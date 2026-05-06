const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const Redis = require('ioredis');
const app = express();

// ============================================================
// CONFIGURATION - Update these values before deploying
// ============================================================
const CONFIG = {
  port: process.env.PORT || 3500,

  // Dialpad API key (must have screen_pop scope)
  dialpadApiKey: process.env.DIALPAD_API_KEY || 'YOUR_DIALPAD_API_KEY',

  // The secret you used when creating the Dialpad webhook (Step 1)
  // Leave empty string if you created the webhook without a secret
  dialpadWebhookSecret: process.env.DIALPAD_WEBHOOK_SECRET || '',

  // Your Salesforce instance URL (e.g., https://yourcompany.lightning.force.com)
  salesforceBaseUrl: process.env.SALESFORCE_BASE_URL || 'https://yourcompany.lightning.force.com',

  // Shared secret for Five9 connector (optional, for verifying Five9 requests)
  five9Secret: process.env.FIVE9_SECRET || '',

  // Redis connection URL
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // How long to keep the phone-to-SalesforceID mapping (seconds)
  // 5 minutes should be plenty for a transfer to complete
  cacheTtlSec: 5 * 60,

  // Salesforce API credentials (Connected App — client_credentials OAuth flow)
  sfLoginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
  sfClientId: process.env.SF_CLIENT_ID || '',
  sfClientSecret: process.env.SF_CLIENT_SECRET || '',

  // Enable/disable Dialpad Transfers Group membership check
  // Set to 'true' to require agents to be in a "Transfers Group *" group
  // Set to 'false' to skip the group check and allow all agents
  requireTransfersGroup: (process.env.REQUIRE_TRANSFERS_GROUP || 'true').toLowerCase() === 'true',
};

// ============================================================
// REDIS CLIENT
// Keys are stored as "screenpop:<phone>" with a 5-minute TTL
// ============================================================
const redis = new Redis(CONFIG.redisUrl, {
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));
redis.on('close', () => console.warn('[Redis] Connection closed'));

const REDIS_PREFIX = 'screenpop:';
const LOG_KEY = 'calllog';
const MAX_LOG_ENTRIES = 500;
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// ============================================================
// HELPER: Append a call log entry to Redis
// ============================================================
async function logCall(type, phone, details = {}) {
  const entry = {
    type,
    phone: phone || 'N/A',
    timestamp: Date.now(),
    time: new Date().toISOString(),
    ...details,
  };
  try {
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
  } catch (err) {
    console.error('[Log] Failed to write log:', err.message);
  }
}

// ============================================================
// HELPER: Trim log entries older than 1 week
// Scans from the tail (oldest) and removes expired entries
// ============================================================
async function trimOldLogs() {
  try {
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    const len = await redis.llen(LOG_KEY);
    if (len === 0) return;

    // Read entries from the tail (oldest) in batches
    const BATCH = 200;
    let removed = 0;
    let idx = len - 1;

    while (idx >= 0) {
      const start = Math.max(idx - BATCH + 1, 0);
      const entries = await redis.lrange(LOG_KEY, start, idx);

      // Walk from oldest (last element) toward newest
      let allOld = true;
      for (let i = entries.length - 1; i >= 0; i--) {
        try {
          const log = JSON.parse(entries[i]);
          const ts = log.timestamp || new Date(log.time).getTime();
          if (ts < cutoff) {
            removed++;
          } else {
            allOld = false;
            break;
          }
        } catch (e) {
          removed++; // remove malformed entries too
        }
      }

      if (!allOld) break;
      idx = start - 1;
    }

    if (removed > 0) {
      // Trim the list to keep only the newest (len - removed) entries
      await redis.ltrim(LOG_KEY, 0, len - removed - 1);
      console.log(`[Log Cleanup] Removed ${removed} entries older than 7 days (${len - removed} remaining)`);
    }
  } catch (err) {
    console.error('[Log Cleanup] Error:', err.message);
  }
}

// ============================================================
// HELPER: Format a timestamp to Eastern Time (12-hour format)
// Automatically adjusts for EST/EDT daylight savings
// ============================================================
function formatEastern(isoOrTimestamp) {
  const d = new Date(isoOrTimestamp);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

// ============================================================
// LEAD -> CONTACT FIELD MAPPING
// Key = Contact field API name, Value = Lead field API name
// ============================================================
const LEAD_TO_CONTACT_MAP = {
  'FirstName': 'FirstName',
  'LastName': 'LastName',
  'Best_Contact_Number__c': 'Best_Contact_Number__c',
  'Phone': 'Phone',
  'MobilePhone': 'MobilePhone',
  'OtherPhone': 'OtherPhone__c',
  'Email': 'Email',
  'Dialer_Employment_Status__c': 'Employment_Status__c',
  'MailingCity': 'Subject_Property_City__c',
  'MailingPostalCode': 'Subject_Property_Zip_Code__c',
  'MailingState': 'Subject_Property_State__c',
  'MailingStreet': 'Subject_Property_Street_Address__c',
  'Dialer_DOB__c': 'Birthdate__c',
  'Dialer_SSN__c': 'SSN__c',
  'SSN__c': 'SSN__c',
  'Dialer_Borrower_Income__c': 'Borrower_Income__c',
  'Dialer_Credit_Grade__c': 'FICO_Score__c',
  'Estimated_Credit_Score__c': 'FICO_Score__c',
  'Dialer_beginning_Loan_Amount__c': 'Dialer_beginning_Loan_Amount__c',
  'Dialer_Additional_Cash__c': 'Additional_Cash__c',
  'Dialer_Cash_Out_Amount__c': 'Cash_Out_Amount__c',
  'Dialer_Mortgage_Goal__c': 'Mortgage_Goal__c',
  'Loan_Purpose__c': 'Loan_Purpose__c',
  'Loan_Amount__c': 'Loan_Amount__c',
  'Dialer_Desired_Loan_Amount__c': 'Desired_Loan_Amount__c',
  'Dialer_Rate_Type__c': 'Rate_Type__c',
  'Dialer_Desired_Rate__c': 'Desired_Rate_Type__c',
  'Dialer_Revolving_Debt_Balance__c': 'Monthly_Revolving_Debt_Payment__c',
  'Dialer_Revolving_Debt__c': 'Revolving_Debt__c',
  'Dialer_Total_Installment_Balance__c': 'Monthly_Installment_Payment__c',
  'Dialer_Monthly_Installment_Payment__c': 'Total_Installment_Balance__c',
  // 'AccountId__c': 'Loan_Partner__c',
  'Telemarketer__c': 'Lead_Generator__c',
  'Dialer_Year_House_Acquired__c': 'Year_House_Acquired__c',
  'Dialer_Home_Purchase_Date__c': 'Home_Purchase_Date__c',
  'Dialer_Late_Payments__c': 'Has_Late_Payments__c',
  'Dialer_Has_Bankrupted_or_Forclosure__c': 'Has_Bankrupted__c',
  'Dialer_Lender_Name__c': 'Lender_Name__c',
  'Dialer_Number_of_Mortgages__c': 'Number_Of_Mortgages__c',
  'Dialer_Has_Second_Mortgage__c': 'Has_Second_Mortgage__c',
  'Dialer_beginning_Loan_Amount__c': 'beginning_Loan_Amount__c',
  'PurchasePrice__c': 'Purchase_Price__c',
  'Dialer_Estimated_Appraised_Value__c': 'Estimated_Appraised_Value__c',
  'Dialer_Interest_Rate__c': 'Interest_Rate__c',
  'Dialer_Current_Interest__c': 'Current_Interest__c',
  'Dialer_Mortgage_Start_Date__c': 'Mortgage_Start_Date__c',
  'Dialer_Mortgage_Term__c': 'Mortgage_Term__c',
  'Dialer_LTV__c': 'LTV__c',
  'Dialer_Current_Loan_Type__c': 'Current_Loan_Type__c',
  'Dialer_Current_Balance__c': 'Current_Balance__c',
  'Dialer_Current_Monthly_Payment__c': 'Current_Monthly_Payment__c',
  'Dialer_Current_FHA_Loan__c': 'Current_FHA_Loan__c',
  'Dialer_Estimated_Property_Value__c': 'Property_Value__c',
  'Dialer_Year_Built__c': 'Year_Built__c',
  'Property_Type__c': 'Property_Type__c',
  'Property_Use__c': 'Property_Use__c',
  'Dialer_Lead_Generator_Notes__c': 'Lead_Generator_Notes__c',
  'Lead_Type__c': 'Lead_Type__c',
  'lead_notes__c': 'lead_notes__c',
};

// Fields where we hardcode a value instead of copying from the Lead
const HARDCODED_CONTACT_FIELDS = {
  'Transfer_or_Self_Gen__c': 'Transfer',
  'Transfer__c': true,
  'LeadSource': 'Dialer',
};

// ============================================================
// SALESFORCE AUTH (client_credentials OAuth flow, auto-refreshes)
// ============================================================
let sfAuth = {
  accessToken: null,
  instanceUrl: null,
  expiresAt: 0,
};

async function getSfAccessToken() {
  if (sfAuth.accessToken && Date.now() < sfAuth.expiresAt) {
    return sfAuth;
  }

  console.log('[SF Auth] Requesting new access token...');

  try {
    const response = await axios.post(`${CONFIG.sfLoginUrl}/services/oauth2/token`, null, {
      params: {
        grant_type: 'client_credentials',
        client_id: CONFIG.sfClientId,
        client_secret: CONFIG.sfClientSecret,
      },
    });

    sfAuth = {
      accessToken: response.data.access_token,
      instanceUrl: response.data.instance_url,
      expiresAt: Date.now() + (90 * 60 * 1000), // refresh every 90 min
    };

    console.log(`[SF Auth] Success! Instance: ${sfAuth.instanceUrl}`);
    return sfAuth;
  } catch (error) {
    console.error('[SF Auth] Failed:', error.response?.data || error.message);
    throw new Error('Salesforce authentication failed');
  }
}

// ============================================================
// SALESFORCE API HELPERS
// ============================================================

// Look up a Salesforce User ID by email
// Handles emails with apostrophes by trying:
// 1. Escaped version for SOQL safety
// 2. Version with apostrophe removed (common SF normalization)
async function sfLookupUserByEmail(email) {
  const { accessToken, instanceUrl } = await getSfAccessToken();

  // Escape single quotes for SOQL safety
  const escapedEmail = email.replace(/'/g, "\\'");
  const query = `SELECT Id, Name FROM User WHERE Email = '${escapedEmail}' AND IsActive = true LIMIT 1`;

  try {
    const response = await axios.get(`${instanceUrl}/services/data/v59.0/query`, {
      params: { q: query },
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.data.totalSize > 0) {
      const user = response.data.records[0];
      console.log(`[SF] Found user: ${user.Name} (${user.Id}) for email ${email}`);
      return user.Id;
    }

    // If email contains apostrophe, try without it (common mismatch between Dialpad and SF)
    if (email.includes("'")) {
      const normalizedEmail = email.replace(/'/g, '');
      console.log(`[SF] No user found for "${email}", trying normalized: "${normalizedEmail}"`);
      
      const normalizedQuery = `SELECT Id, Name FROM User WHERE Email = '${normalizedEmail}' AND IsActive = true LIMIT 1`;
      const normalizedResponse = await axios.get(`${instanceUrl}/services/data/v59.0/query`, {
        params: { q: normalizedQuery },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (normalizedResponse.data.totalSize > 0) {
        const user = normalizedResponse.data.records[0];
        console.log(`[SF] Found user with normalized email: ${user.Name} (${user.Id}) for ${normalizedEmail}`);
        return user.Id;
      }
    }

    console.warn(`[SF] No active Salesforce user found for email: ${email}`);
    return null;
  } catch (error) {
    console.error('[SF] User lookup failed:', error.response?.data || error.message);
    return null;
  }
}

// Fetch Lead data by ID
async function sfGetLead(leadId) {
  const { accessToken, instanceUrl } = await getSfAccessToken();

  // Collect all unique Lead field names we need
  const leadFields = new Set();
  for (const [contactField, leadField] of Object.entries(LEAD_TO_CONTACT_MAP)) {
    if (HARDCODED_CONTACT_FIELDS[contactField]) continue;
    leadFields.add(leadField);
  }

  const fieldList = Array.from(leadFields).join(',');

  try {
    const response = await axios.get(
      `${instanceUrl}/services/data/v59.0/sobjects/Lead/${leadId}`,
      {
        params: { fields: fieldList },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    console.log(`[SF] Fetched Lead: ${response.data.FirstName || ''} ${response.data.LastName || ''} (${leadId})`);
    return response.data;
  } catch (error) {
    console.error('[SF] Lead fetch failed:', error.response?.data || error.message);
    return null;
  }
}

// Create a Contact from Lead data with agent as owner
async function sfCreateContact(leadData, ownerId, five9AgentName, leadId, fallbackPhone) {
  const { accessToken, instanceUrl } = await getSfAccessToken();

  const contactRecord = {};

  // Map fields from Lead to Contact
  for (const [contactField, leadField] of Object.entries(LEAD_TO_CONTACT_MAP)) {
    // Use hardcoded value if defined
    if (HARDCODED_CONTACT_FIELDS[contactField]) {
      contactRecord[contactField] = HARDCODED_CONTACT_FIELDS[contactField];
      continue;
    }

    // Copy value from Lead if it exists
    const value = leadData[leadField];
    if (value !== null && value !== undefined && value !== '') {
      contactRecord[contactField] = value;
    }
  }

  // Apply all hardcoded fields (catches any not in the mapping loop)
  for (const [field, value] of Object.entries(HARDCODED_CONTACT_FIELDS)) {
    contactRecord[field] = value;
  }

  // Set the owner to the Dialpad agent who answered
  contactRecord['LoanPartner__c'] = ownerId;

  // Link back to the original Lead
  if (leadId) {
    contactRecord['Original_Lead__c'] = leadId;
  }

  // Set the Five9 agent name as the Telemarketer
  if (five9AgentName) {
    contactRecord['Telemarketer__c'] = five9AgentName;
  }

  // If Best Contact Number is blank on the Lead, fall back to the caller's phone
  if (!contactRecord['Best_Contact_Number__c'] && fallbackPhone) {
    contactRecord['Best_Contact_Number__c'] = formatPhoneForSalesforce(fallbackPhone);
  }

  console.log(`[SF] Creating Contact with ${Object.keys(contactRecord).length} fields, owner: ${ownerId}`);
  console.log(`[SF] Contact preview: ${contactRecord.FirstName__c || ''} ${contactRecord.LastName__c || ''}, phone: ${contactRecord.Phone_1__c || 'N/A'}`);

  try {
    const response = await axios.post(
      `${instanceUrl}/services/data/v59.0/sobjects/Contact`,
      contactRecord,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[SF] Contact created! ID: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    console.error('[SF] Contact creation failed:', JSON.stringify(error.response?.data || error.message, null, 2));
    return null;
  }
}

// Full workflow: Lead -> Contact with agent as owner
async function convertLeadToContact(leadId, agentEmail, five9AgentName, callerPhone) {
  console.log(`[Convert] Starting: Lead ${leadId}, agent ${agentEmail}, five9Agent: ${five9AgentName || 'N/A'}`);

  // Step 1: Look up SF User by Dialpad agent's email
  const ownerId = await sfLookupUserByEmail(agentEmail);
  if (!ownerId) {
    console.error(`[Convert] Cannot proceed - no SF user found for ${agentEmail}`);
    return null;
  }

  // Step 2: Fetch the Lead
  const leadData = await sfGetLead(leadId);
  if (!leadData) {
    console.error(`[Convert] Cannot proceed - Lead ${leadId} not found`);
    return null;
  }

  // Step 3: Create the Contact
  const contactId = await sfCreateContact(leadData, ownerId, five9AgentName, leadId, callerPhone);
  if (!contactId) {
    console.error('[Convert] Contact creation failed');
    return null;
  }

  console.log(`[Convert] Success! Lead ${leadId} -> Contact ${contactId}, owner: ${agentEmail}`);
  return contactId;
}

// ============================================================
// MIDDLEWARE
// ============================================================
// Dialpad sends the JWT as a raw string body — capture it before JSON parsing
app.use('/dialpad/call-events', express.text({ type: '*/*' }));

// Parse JSON bodies for all other routes
app.use(express.json());

// Parse URL-encoded bodies (some connectors send form data)
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
// HELPER: Build Salesforce Lightning record URL
// Maps record ID prefixes to their SObject type
// ============================================================
function sfRecordUrl(recordId) {
  const prefixMap = {
    '003': 'Contact',
    '00Q': 'Lead',
    '001': 'Account',
    '006': 'Opportunity',
    '005': 'User',
  };
  const prefix = (recordId || '').substring(0, 3);
  const sobject = prefixMap[prefix] || 'Contact';
  return `${CONFIG.salesforceBaseUrl}/lightning/r/${sobject}/${recordId}/view`;
}

// ============================================================
// HELPER: Normalize phone number to E.164-ish format
// Strips everything except digits and leading +
// ============================================================
function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^\d+]/g, '');
  // If it's 10 digits (US), prepend +1
  if (/^\d{10}$/.test(cleaned)) {
    cleaned = '+1' + cleaned;
  }
  // Ensure leading +
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

function formatPhoneForSalesforce(phone) {
  if (!phone) return null;

  const digits = String(phone).replace(/\D/g, '');
  const localNumber = digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;

  if (localNumber.length !== 10) {
    return phone;
  }

  return `(${localNumber.slice(0, 3)}) ${localNumber.slice(3, 6)}-${localNumber.slice(6)}`;
}

// ============================================================
// HELPER: Check if a Dialpad user is a member of a "Transfers Group *" group
// Uses the Dialpad API to fetch user details and check group memberships
// ============================================================
async function isUserInTransfersGroup(dialpadUserId) {
  console.log(`[Dialpad] Checking group membership for user ${dialpadUserId}`);

  try {
    // Get user details including group memberships
    const response = await axios.get(
      `https://dialpad.com/api/v2/users/${dialpadUserId}`,
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.dialpadApiKey}`,
        },
      }
    );

    const user = response.data;
    const groups = user.groups || [];

    console.log(`[Dialpad] User ${user.display_name || dialpadUserId} belongs to ${groups.length} groups`);

    // Check each group for "Transfers Group *" pattern (case-insensitive)
    for (const group of groups) {
      const groupName = group.name || '';
      console.log(`[Dialpad]   - Group: "${groupName}"`);

      // Match "Transfers Group" followed by anything (wildcard)
      if (/^Transfers\s+Group\b/i.test(groupName)) {
        console.log(`[Dialpad] ✓ User is in matching group: "${groupName}"`);
        return { isMember: true, groupName };
      }
    }

    console.log(`[Dialpad] ✗ User is NOT in any "Transfers Group *" group`);
    return { isMember: false, groupName: null };
  } catch (error) {
    console.error(`[Dialpad] Group membership check failed:`, error.response?.data || error.message);
    // On API error, we'll fail closed (not in group) to be safe
    return { isMember: false, groupName: null, error: error.message };
  }
}

// ============================================================
// HELPER: Trigger Dialpad screen pop for a user
// ============================================================
async function triggerScreenPop(dialpadUserId, salesforceRecordId) {
  const url = sfRecordUrl(salesforceRecordId);

  console.log(`[ScreenPop] Triggering for user ${dialpadUserId} -> ${url}`);

  try {
    const response = await axios.post(
      `https://dialpad.com/api/v2/users/${dialpadUserId}/screenpop`,
      { screen_pop_uri: url },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.dialpadApiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[ScreenPop] Success! Status: ${response.status}`);
    return true;
  } catch (error) {
    console.error(`[ScreenPop] Failed:`, error.response?.data || error.message);
    return false;
  }
}

// ============================================================
// HELPER: Decode Dialpad JWT webhook payload
// Dialpad sends the entire body as a JWT string when a secret is set.
// The /dialpad/call-events route uses express.text() so req.body is a string.
// ============================================================
function decodeDialpadPayload(req, secret) {
  const raw = req.body;

  console.log('[JWT] Body type:', typeof raw, '| Length:', String(raw).length);
  console.log('[JWT] Preview:', String(raw).substring(0, 80));

  // If no secret, treat as plain JSON
  if (!secret) {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
  }

  // Get the token string
  let token = typeof raw === 'string' ? raw.trim() : '';

  // If body was parsed as JSON by Express, the JWT might be in a field
  if (!token && typeof req.body === 'object') {
    token = req.body.token || JSON.stringify(req.body);
  }

  if (!token) {
    console.error('[JWT] No raw body available for verification');
    return null;
  }

  console.log('[JWT] Token preview:', token.substring(0, 50) + '...');

  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (err) {
    console.error('[JWT] Verification failed:', err.message);
    return null;
  }
}

// ============================================================
// ROUTE 1: Five9 Connector Webhook
// Five9 sends this when a call is being transferred to Dialpad
//
// Expected payload (configure in Five9 connector):
// {
//   "agent_name": "First Last"
//   "phone": "+15551234567",      (caller's ANI)
//   "salesforce_id": "001ABC123"  (the SF Lead/Contact record ID)
// }
// ============================================================
app.post('/five9/transfer', async (req, res) => {
  console.log('[Five9] Received transfer data:', JSON.stringify(req.body));

  // Optional: verify Five9 shared secret
  if (CONFIG.five9Secret) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '');
    if (token !== CONFIG.five9Secret) {
      console.warn('[Five9] Invalid secret - rejecting request');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const phone = normalizePhone(req.body.phone || req.body.ani || req.body.caller_id);
  const salesforceId = req.body.salesforce_id || req.body.sf_id || req.body.record_id;
  const agentName = req.body.agent_name || 'None';

  if (!phone || !salesforceId) {
    console.error('[Five9] Missing phone or salesforce_id in payload');
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['phone', 'salesforce_id'],
      received: req.body,
    });
  }

  // Cache the mapping in Redis with 5-minute TTL
  try {
    await redis.setex(
      `${REDIS_PREFIX}${phone}`,
      CONFIG.cacheTtlSec,
      JSON.stringify({ salesforceId, agentName, timestamp: Date.now() })
    );
    console.log(`[Five9] Cached: ${phone} -> ${salesforceId} (agent: ${agentName || 'N/A'})`);
    await logCall('Transfer', phone, { salesforceId, five9Agent: agentName });
    res.status(200).json({ status: 'ok', phone, salesforceId, agentName });
  } catch (err) {
    console.error('[Five9] Redis write failed:', err.message);
    res.status(500).json({ error: 'Cache write failed' });
  }
});

// ============================================================
// ROUTE 2: Dialpad Call Event Webhook
// Dialpad sends this when a call reaches the "connected" state
// ============================================================
app.post('/dialpad/call-events', async (req, res) => {
  // Decode the payload
  let payload;
  try {
    if (CONFIG.dialpadWebhookSecret) {
      payload = decodeDialpadPayload(req, CONFIG.dialpadWebhookSecret);
      if (!payload) {
        console.error('[Dialpad] Could not decode JWT payload');
        return res.status(400).json({ status: 'error', message: 'JWT decode failed' });
      }
    } else {
      // No secret — body is a raw text string from express.text(), parse it
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }
  } catch (err) {
    console.error('[Dialpad] Payload parse error:', err.message);
    return res.status(400).json({ status: 'error', message: 'Invalid payload' });
  }

  // Log all phone-related fields for debugging
  console.log(`[Dialpad] Call event: state=${payload.state}, direction=${payload.direction}`);
  console.log(`[Dialpad]   external_number: ${payload.external_number}`);
  console.log(`[Dialpad]   internal_number: ${payload.internal_number}`);
  console.log(`[Dialpad]   contact.phone: ${payload.contact?.phone}`);
  console.log(`[Dialpad]   target.id: ${payload.target?.id}, target.name: ${payload.target?.name}`);
  console.log(`[Dialpad]   Full payload keys: ${Object.keys(payload).join(', ')}`);

  // Only process "connected" events
  if (payload.state !== 'connected') {
    console.log(`[Dialpad] Ignoring state: ${payload.state}`);
    return res.status(200).json({ status: 'ignored', reason: `state=${payload.state}` });
  }

  // For inbound calls: external_number is the caller (ANI)
  // For outbound calls: external_number is the number being called
  const callerPhone = normalizePhone(payload.external_number);
  const agentId = payload.target?.id;
  const agentName = payload.target?.name || 'Unknown';
  const agentEmail = payload.target?.email || '';

  if (!callerPhone) {
    console.error('[Dialpad] No external_number in payload');
    return res.status(200).json({ status: 'skipped', reason: 'no external_number' });
  }

  if (!agentId) {
    console.error('[Dialpad] No target.id (agent ID) in payload');
    return res.status(200).json({ status: 'skipped', reason: 'no agent ID' });
  }

  console.log(`[Dialpad] Call answered by ${agentName} (${agentId}, ${agentEmail}) from ${callerPhone}`);

  // Look up the caller in our Redis cache (from Five9 data)
  let cached;
  try {
    const raw = await redis.get(`${REDIS_PREFIX}${callerPhone}`);
    cached = raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[Dialpad] Redis read failed:', err.message);
    return res.status(200).json({ status: 'error', reason: 'cache read failed' });
  }

  if (!cached) {
    console.log(`[Dialpad] No Five9 data cached for ${callerPhone} - skipping`);
    await logCall('No Record Found', callerPhone, { dialpadAgent: agentName, agentEmail });
    return res.status(200).json({ status: 'skipped', reason: 'no cached data for caller' });
  }

  console.log(`[Dialpad] Found cached Salesforce Lead ID: ${cached.salesforceId}`);

  // --- Lead to Contact Conversion ---
  if (!agentEmail) {
    console.warn('[Dialpad] No agent email in payload - cannot set Contact owner');
    return res.status(200).json({
      status: 'skipped',
      reason: 'no agent email',
      leadId: cached.salesforceId,
      leadUrl: sfRecordUrl(cached.salesforceId),
    });
  }

  // --- Check if agent is in a "Transfers Group *" group (if enabled) ---
  if (CONFIG.requireTransfersGroup) {
    const groupCheck = await isUserInTransfersGroup(agentId);
    if (!groupCheck.isMember) {
      console.log(`[Dialpad] Agent ${agentEmail} is NOT in a Transfers Group - skipping contact creation`);
      await logCall('Not In Transfers Group', callerPhone, {
        dialpadAgent: agentName,
        agentEmail,
        agentId,
        error: groupCheck.error || 'Not a member of any Transfers Group',
      });
      return res.status(200).json({
        status: 'skipped',
        reason: 'agent not in Transfers Group',
        agentEmail,
        leadId: cached.salesforceId,
      });
    }
    console.log(`[Dialpad] Agent ${agentEmail} is in "${groupCheck.groupName}" - proceeding with contact creation`);
  } else {
    console.log(`[Dialpad] Transfers Group check disabled - proceeding with contact creation for ${agentEmail}`);
  }

  const contactId = await convertLeadToContact(cached.salesforceId, agentEmail, cached.agentName, callerPhone);

  if (contactId) {
    const contactUrl = sfRecordUrl(contactId);
    console.log(`[Dialpad] Contact ${contactId} created for call from ${callerPhone}`);
    await logCall('Answer', callerPhone, {
      salesforceId: cached.salesforceId,
      contactId,
      contactUrl,
      dialpadAgent: agentName,
      agentEmail,
      five9Agent: cached.agentName,
    });

    // Trigger screen pop to open the new Contact in the agent's browser
    await triggerScreenPop(agentId, contactId);

    // Remove from cache after successful conversion
    await redis.del(`${REDIS_PREFIX}${callerPhone}`).catch(() => {});

    return res.status(200).json({
      status: 'ok',
      screen_pop_uri: contactUrl,
      contactId,
      contactUrl,
      leadId: cached.salesforceId,
      agent: agentEmail,
    });
  }

  // Conversion failed — screen pop the Lead instead
  await triggerScreenPop(agentId, cached.salesforceId);

  return res.status(200).json({
    status: 'error',
    reason: 'contact creation failed',
    screen_pop_uri: sfRecordUrl(cached.salesforceId),
    leadId: cached.salesforceId,
  });
});

// ============================================================// ROUTE 3: Screen Pop Redirect
// Dialpad opens this URL when a call is answered.
// We look up the phone in our cache and redirect to Salesforce.
// Set Dialpad Screen Pop URL to:
//   https://dialpad-dev.pros.mortgage/screenpop/redirect?phone=%CN
// ============================================================
app.get('/screenpop/redirect', async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  console.log(`[Redirect] Screen pop request for phone: ${phone}`);

  if (!phone) {
    return res.send('<html><body><script>window.close();</script></body></html>');
  }

  try {
    const raw = await redis.get(`${REDIS_PREFIX}${phone}`);
    if (raw) {
      const data = JSON.parse(raw);
      const sfUrl = sfRecordUrl(data.salesforceId);
      console.log(`[Redirect] Found! Redirecting to ${sfUrl}`);
      await redis.del(`${REDIS_PREFIX}${phone}`);
      return res.redirect(sfUrl);
    }
  } catch (err) {
    console.error('[Redirect] Redis read failed:', err.message);
  }

  // No cached data — close the tab Dialpad opened
  console.log(`[Redirect] No cached data for ${phone}, closing tab`);
  return res.send('<html><body><script>window.close();</script></body></html>');
});

// ============================================================// ROUTE 3: Health check
// ============================================================
app.get('/health', async (req, res) => {
  let cacheSize = 0;
  let redisStatus = 'unknown';
  try {
    await redis.ping();
    redisStatus = 'connected';
    const keys = await redis.keys(`${REDIS_PREFIX}*`);
    cacheSize = keys.length;
  } catch {
    redisStatus = 'disconnected';
  }
  res.json({
    status: redisStatus === 'connected' ? 'ok' : 'degraded',
    uptime: process.uptime(),
    redis: redisStatus,
    cacheSize,
    sfAuthenticated: !!sfAuth.accessToken && Date.now() < sfAuth.expiresAt,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// ROUTE 4: Debug - view current cache (JSON API)
// ============================================================
app.get('/debug/cache', async (req, res) => {
  try {
    const keys = await redis.keys(`${REDIS_PREFIX}*`);
    const entries = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const ttl = await redis.ttl(key);
      entries.push({
        phone: key.replace(REDIS_PREFIX, ''),
        salesforceId: data.salesforceId,
        age: `${Math.round((Date.now() - data.timestamp) / 1000)}s ago`,
        ttlRemaining: `${ttl}s`,
      });
    }
    res.json({ cacheSize: keys.length, entries });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read cache', detail: err.message });
  }
});

// ============================================================
// ROUTE 5a: Search API - searches ALL log entries in Redis
// ============================================================
app.get('/api/logs/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const types = (req.query.types || '').split(',').filter(Boolean);

    if (!q) return res.json([]);

    // Fetch ALL log entries from Redis (no cap)
    const allEntries = await redis.lrange(LOG_KEY, 0, -1);
    const results = [];

    for (const entry of allEntries) {
      try {
        const log = JSON.parse(entry);
        const agent = log.dialpadAgent || log.five9Agent || '';
        const searchText = [
          log.phone || '',
          log.type || '',
          agent,
          log.salesforceId || '',
          log.contactId || '',
        ].join(' ').toLowerCase();

        const matchText = searchText.includes(q);
        const matchType = types.length === 0 || types.includes(log.type);

        if (matchText && matchType) {
          results.push({
            ...log,
            dialpadAgent: log.dialpadAgent || null,
            five9Agent: log.five9Agent || null,
            displayTime: formatEastern(log.time || log.timestamp) + ' EST',
            sfRecordUrl: log.salesforceId ? sfRecordUrl(log.salesforceId) : null,
          });
        }
      } catch (e) { /* skip malformed */ }
    }

    res.json(results);
  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================================
// ROUTE 5: Admin page - view cached data in a browser
// ============================================================
app.get('/admin', async (req, res) => {
  let rows = '';
  let cacheSize = 0;
  let redisStatus = 'disconnected';
  let logRows = '';
  let totalLogCount = 0;

  try {
    await redis.ping();
    redisStatus = 'connected';
    const keys = await redis.keys(`${REDIS_PREFIX}*`);
    cacheSize = keys.length;

    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const ttl = await redis.ttl(key);
      const ageSec = Math.round((Date.now() - data.timestamp) / 1000);
      rows += `<tr>
        <td>${key.replace(REDIS_PREFIX, '')}</td>
        <td><a href="${sfRecordUrl(data.salesforceId)}" target="_blank">${data.salesforceId}</a></td>
        <td>${data.agentName || 'N/A'}</td>
        <td>${ageSec}s ago</td>
        <td>${ttl}s</td>
      </tr>`;
    }

    // Fetch call log entries (last 500 for display; search API covers all)
    totalLogCount = await redis.llen(LOG_KEY);
    const logEntries = await redis.lrange(LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
    for (const entry of logEntries) {
      try {
        const log = JSON.parse(entry);
        const badgeClass = log.type === 'Answer' ? 'answer' : log.type === 'Transfer' ? 'transfer' : 'norecord';
        const sfLink = log.contactId
          ? `<a href="${log.contactUrl}" target="_blank">${log.contactId}</a>`
          : log.salesforceId
            ? `<a href="${sfRecordUrl(log.salesforceId)}" target="_blank">${log.salesforceId}</a>`
            : '—';
        const agent = log.dialpadAgent || log.five9Agent || '—';
        const displayTime = formatEastern(log.time || log.timestamp) + ' EST';
        logRows += `<tr data-type="${log.type || ''}" data-search="${(log.phone || '') + ' ' + (log.type || '') + ' ' + agent + ' ' + (log.salesforceId || '') + ' ' + (log.contactId || '')}">
          <td><span class="log-badge ${badgeClass}">${log.type}</span></td>
          <td>${log.phone || '—'}</td>
          <td>${sfLink}</td>
          <td>${agent}</td>
          <td>${displayTime}</td>
        </tr>`;
      } catch (e) { /* skip malformed */ }
    }
  } catch (err) {
    rows = `<tr><td colspan="5" style="color:#e74c3c">Redis error: ${err.message}</td></tr>`;
  }

  if (cacheSize === 0 && redisStatus === 'connected') {
    rows = '<tr><td colspan="5" style="color:#888">No cached entries — waiting for Five9 data</td></tr>';
  }
  if (!logRows) {
    logRows = '<tr><td colspan="5" style="color:#888">No log entries yet</td></tr>';
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Screen Pop Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e0e0e0; display: flex; flex-direction: column; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin-bottom: 8px; }
    .meta { color: #888; font-size: 13px; margin-bottom: 20px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge.ok { background: #1a3a2a; color: #4ade80; }
    .badge.bad { background: #3a1a1a; color: #f87171; }
    .log-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .log-badge.answer { background: #1a3a2a; color: #4ade80; }
    .log-badge.transfer { background: #1a2a3a; color: #60a5fa; }
    .log-badge.norecord { background: #3a2a1a; color: #fbbf24; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 12px; background: #1a1d27; color: #aaa; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid #2a2d37; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e2130; font-size: 14px; font-family: "SF Mono", "Fira Code", monospace; }
    tr:hover td { background: #1a1d27; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .top-section { height: 40vh; padding: 24px 24px 16px; overflow-y: auto; flex-shrink: 0; }
    .log-panel { height: 60vh; background: #13151d; border-top: 1px solid #2a2d37; display: flex; flex-direction: column; flex-shrink: 0; }
    .log-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; flex-shrink: 0; }
    .log-header h2 { margin: 0; }
    .search-box { padding: 0 24px 8px; flex-shrink: 0; }
    .search-box input { background: #1a1d27; border: 1px solid #2a2d37; color: #e0e0e0; padding: 8px 12px; border-radius: 6px; font-size: 13px; width: 300px; outline: none; }
    .search-box input:focus { border-color: #60a5fa; }
    .filter-bar { display: flex; gap: 12px; align-items: center; padding: 0 24px 8px; flex-shrink: 0; }
    .filter-bar input { background: #1a1d27; border: 1px solid #2a2d37; color: #e0e0e0; padding: 8px 12px; border-radius: 6px; font-size: 13px; width: 300px; outline: none; }
    .filter-bar input:focus { border-color: #60a5fa; }
    .type-filter { position: relative; }
    .type-filter-btn { background: #1a1d27; border: 1px solid #2a2d37; color: #e0e0e0; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .type-filter-btn:hover { border-color: #60a5fa; }
    .type-filter-btn .arrow { font-size: 10px; }
    .type-dropdown { display: none; position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; background: #1a1d27; border: 1px solid #2a2d37; border-radius: 6px; padding: 6px 0; min-width: 180px; z-index: 200; box-shadow: 0 -4px 12px rgba(0,0,0,.4); }
    .type-dropdown.show { display: block; }
    .type-dropdown label { display: flex; align-items: center; gap: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .type-dropdown label:hover { background: #252838; }
    .type-dropdown input[type=checkbox] { accent-color: #60a5fa; }
    .type-dropdown .divider { height: 1px; background: #2a2d37; margin: 4px 0; }
    .log-content { overflow-y: auto; flex: 1; padding: 0 24px 12px; }
  </style>
</head>
<body>
  <div class="top-section">
    <h1>Dialpad Screen Pop — Admin</h1>
    <p class="meta">
      Redis: <span class="badge ${redisStatus === 'connected' ? 'ok' : 'bad'}">${redisStatus}</span>
      &nbsp; Cached: <strong>${cacheSize}</strong>
      &nbsp; TTL: ${CONFIG.cacheTtlSec}s
    </p>

    <h2>Active Cache</h2>
    <table>
      <thead><tr><th>Phone (ANI)</th><th>Salesforce ID</th><th>Five9 Agent</th><th>Age</th><th>TTL Left</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="log-panel">
    <div class="log-header">
      <h2>Call Log <span style="font-size:13px;color:#888;font-weight:normal">(showing last ${MAX_LOG_ENTRIES} of ${totalLogCount} total — search queries all)</span></h2>
    </div>
    <div class="filter-bar">
      <input type="text" id="logSearch" placeholder="Search by phone, agent, ID..." oninput="filterLog()">
      <div class="type-filter">
        <button class="type-filter-btn" onclick="toggleDropdown(event)">Type: All <span class="arrow">&#9650;</span></button>
        <div class="type-dropdown" id="typeDropdown">
          <label><input type="checkbox" value="All" checked onchange="toggleAll(this)"> All</label>
          <div class="divider"></div>
          <label><input type="checkbox" value="Transfer" checked onchange="toggleType(this)"> <span class="log-badge transfer">Transfer</span></label>
          <label><input type="checkbox" value="Answer" checked onchange="toggleType(this)"> <span class="log-badge answer">Answer</span></label>
          <label><input type="checkbox" value="No Record Found" checked onchange="toggleType(this)"> <span class="log-badge norecord">No Record Found</span></label>
        </div>
      </div>
    </div>
    <div class="log-content">
      <table>
        <thead><tr><th>Type</th><th>Phone</th><th>SF Record</th><th>Agent</th><th>Time</th></tr></thead>
        <tbody id="logTable">${logRows}</tbody>
      </table>
    </div>
  </div>

  <script>
    // --- State persistence across refresh ---
    const STATE_KEY = 'adminFilterState';
    function saveState() {
      const state = {
        search: document.getElementById('logSearch').value,
        types: getSelectedTypes()
      };
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    }
    function restoreState() {
      try {
        const raw = sessionStorage.getItem(STATE_KEY);
        if (!raw) return;
        const state = JSON.parse(raw);
        if (state.search) document.getElementById('logSearch').value = state.search;
        if (state.types) {
          const allTypes = ['Transfer', 'Answer', 'No Record Found'];
          const checks = document.querySelectorAll('#typeDropdown input[type=checkbox]:not([value=All])');
          checks.forEach(c => { c.checked = state.types.includes(c.value); });
          const allBox = document.querySelector('#typeDropdown input[value=All]');
          allBox.checked = state.types.length === allTypes.length;
          updateBtnLabel();
        }
        filterLog();
      } catch(e) {}
    }

    // --- Auto-refresh via fetch (no full page reload) ---
    async function refreshData() {
      try {
        const resp = await fetch(window.location.href);
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        // Update cache table
        const newTop = doc.querySelector('.top-section');
        if (newTop) document.querySelector('.top-section').innerHTML = newTop.innerHTML;
        // Update log header (total count may have changed)
        const newLogHeader = doc.querySelector('.log-header');
        if (newLogHeader) document.querySelector('.log-header').innerHTML = newLogHeader.innerHTML;
        // Update log table body and refresh originalLogHTML
        const newLogBody = doc.querySelector('#logTable');
        if (newLogBody) {
          originalLogHTML = newLogBody.innerHTML;
          // Only overwrite visible table if user is NOT actively searching
          const q = document.getElementById('logSearch').value.trim();
          if (!q) {
            document.getElementById('logTable').innerHTML = newLogBody.innerHTML;
          }
        }
        filterLog();
      } catch(e) {}
    }
    setInterval(refreshData, 10000);

    // --- Type filter logic ---
    function getSelectedTypes() {
      const checks = document.querySelectorAll('#typeDropdown input[type=checkbox]:not([value=All])');
      const selected = [];
      checks.forEach(c => { if (c.checked) selected.push(c.value); });
      return selected;
    }

    function updateBtnLabel() {
      const btn = document.querySelector('.type-filter-btn');
      const types = getSelectedTypes();
      if (types.length === 3) {
        btn.innerHTML = 'Type: All <span class="arrow">&#9650;</span>';
      } else if (types.length === 0) {
        btn.innerHTML = 'Type: None <span class="arrow">&#9650;</span>';
      } else {
        btn.innerHTML = 'Type: ' + types.join(', ') + ' <span class="arrow">&#9650;</span>';
      }
    }

    function toggleAll(el) {
      const checks = document.querySelectorAll('#typeDropdown input[type=checkbox]:not([value=All])');
      checks.forEach(c => { c.checked = el.checked; });
      updateBtnLabel();
      filterLog();
      saveState();
    }

    function toggleType(el) {
      const checks = document.querySelectorAll('#typeDropdown input[type=checkbox]:not([value=All])');
      const allBox = document.querySelector('#typeDropdown input[value=All]');
      allBox.checked = [...checks].every(c => c.checked);
      updateBtnLabel();
      filterLog();
      saveState();
    }

    function toggleDropdown(e) {
      e.stopPropagation();
      document.getElementById('typeDropdown').classList.toggle('show');
    }

    document.addEventListener('click', function(e) {
      const dd = document.getElementById('typeDropdown');
      if (!e.target.closest('.type-filter')) dd.classList.remove('show');
    });

    // Store original (last 500) rows so we can restore them when search is cleared
    let originalLogHTML = document.getElementById('logTable').innerHTML;
    let searchDebounceTimer = null;

    function filterLog() {
      const q = document.getElementById('logSearch').value.trim();
      const selected = getSelectedTypes();

      // If there's a search query, debounce and call server-side search API
      if (q) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => serverSearch(q, selected), 300);
      } else {
        // No search query — restore original rows and filter by type client-side
        clearTimeout(searchDebounceTimer);
        document.getElementById('logTable').innerHTML = originalLogHTML;
        const rows = document.querySelectorAll('#logTable tr[data-search]');
        rows.forEach(row => {
          const type = row.getAttribute('data-type') || '';
          row.style.display = selected.includes(type) ? '' : 'none';
        });
      }
      saveState();
    }

    async function serverSearch(q, selectedTypes) {
      try {
        const params = new URLSearchParams({ q, types: selectedTypes.join(',') });
        const resp = await fetch('/api/logs/search?' + params.toString());
        const results = await resp.json();
        const tbody = document.getElementById('logTable');
        if (results.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#888">No matching log entries</td></tr>';
          return;
        }
        let html = '';
        for (const log of results) {
          const badgeClass = log.type === 'Answer' ? 'answer' : log.type === 'Transfer' ? 'transfer' : 'norecord';
          const agent = log.dialpadAgent || log.five9Agent || '\u2014';
          const sfLink = log.contactId
            ? '<a href="' + log.contactUrl + '" target="_blank">' + log.contactId + '</a>'
            : log.salesforceId
              ? '<a href="' + log.sfRecordUrl + '" target="_blank">' + log.salesforceId + '</a>'
              : '\u2014';
          html += '<tr data-type="' + (log.type || '') + '" data-search="' + ((log.phone || '') + ' ' + (log.type || '') + ' ' + agent + ' ' + (log.salesforceId || '') + ' ' + (log.contactId || '')) + '">';
          html += '<td><span class="log-badge ' + badgeClass + '">' + log.type + '</span></td>';
          html += '<td>' + (log.phone || '\u2014') + '</td>';
          html += '<td>' + sfLink + '</td>';
          html += '<td>' + agent + '</td>';
          html += '<td>' + log.displayTime + '</td>';
          html += '</tr>';
        }
        tbody.innerHTML = html;
      } catch(e) {
        console.error('Search failed:', e);
      }
    }

    // Restore saved state on load
    restoreState();
  </script>
</body>
</html>`);
});

// ============================================================
// START SERVER
// ============================================================
app.listen(CONFIG.port, () => {
  console.log('='.repeat(60));
  console.log(`  Dialpad Screen Pop Middleware`);
  console.log(`  Listening on port ${CONFIG.port}`);
  console.log(`  Redis:            ${CONFIG.redisUrl}`);
  console.log(`  Cache TTL:        ${CONFIG.cacheTtlSec}s`);
  console.log(`  Five9 webhook:    POST /five9/transfer`);
  console.log(`  Dialpad webhook:  POST /dialpad/call-events`);
  console.log(`  Screen pop:       GET  /screenpop/redirect`);
  console.log(`  Health check:     GET  /health`);
  console.log('='.repeat(60));

  // Test Salesforce auth on startup
  if (CONFIG.sfClientId) {
    getSfAccessToken()
      .then(() => console.log('[Startup] Salesforce auth: OK'))
      .catch(() => console.error('[Startup] Salesforce auth: FAILED - check credentials'));
  } else {
    console.warn('[Startup] Salesforce credentials not configured - Lead conversion disabled');
  }

  // Trim old log entries on startup, then every hour
  trimOldLogs();
  setInterval(trimOldLogs, 60 * 60 * 1000);
});
