# Dialpad Screen Pop Middleware

Bridges Five9 call transfers with Dialpad screen pops to open Salesforce records automatically when an agent answers a transferred call. Uses a Redis container for short-lived caching (5-minute TTL) to correlate calls between Five9 and Dialpad.

## How It Works

```
Five9 Agent transfers call
        │
        ├──► Five9 Connector POSTs {phone, salesforce_id} ──► This Server (caches in Redis)
        │
        └──► Call arrives at Dialpad (PSTN transfer)
                    │
                    └──► Agent answers
                              │
                              └──► Dialpad fires "connected" webhook ──► This Server
                                                                              │
                                                                              ├── Looks up phone in Redis
                                                                              ├── Finds Salesforce ID
                                                                              └── Calls Dialpad Screen Pop API
                                                                                         │
                                                                                         └──► Salesforce record opens
                                                                                              on agent's screen
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/five9/transfer` | Receives transfer data from Five9 connector |
| POST | `/dialpad/call-events` | Receives call events from Dialpad webhook |
| GET | `/health` | Health check |
| GET | `/debug/cache` | View cached entries (remove in production) |

## Setup on Hostinger VPS

### 1. Upload files to your VPS

```bash
scp -r ./* root@YOUR_VPS_IP:/tmp/dialpad-screenpop/
```

### 2. Deploy with Docker Compose

The stack runs two containers: the Node.js middleware and a Redis instance.

```bash
ssh root@YOUR_VPS_IP
cd /opt/stacks/dialpad-screenpop
docker compose up -d --build
```

### 3. Edit your environment variables

Update the `environment` section in `docker-compose.yml` (or create a `.env` file):

- `DIALPAD_API_KEY` - Your Dialpad API key with `screen_pop` scope
- `SALESFORCE_BASE_URL` - Your Salesforce Lightning URL
- `DIALPAD_WEBHOOK_SECRET` - The secret from when you created the Dialpad webhook
- `FIVE9_SECRET` - Optional shared secret for Five9 connector auth
- `REDIS_URL` - Defaults to `redis://redis:6379` (the compose Redis service)

### 4. Verify it's running

```bash
curl http://localhost:3500/health
```

Expected response:
```json
{"status":"ok","uptime":5.123,"redis":"connected","cacheSize":0,"timestamp":"..."}
```

### 5. Set up HTTPS (required for webhooks)

If using Nginx (installed by setup script):
```bash
# Edit the server_name in the Nginx config
sudo nano /etc/nginx/sites-available/dialpad-screenpop

# Test and reload
sudo nginx -t && sudo systemctl reload nginx

# Get SSL certificate
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d screenpop.yourdomain.com
```

If not using Nginx, you can use Certbot standalone or put it behind Cloudflare.

### 6. Register the webhook with Dialpad

Once your server is live with HTTPS:

```bash
# Step 1: Create the webhook
curl -X POST "https://dialpad.com/api/v2/webhooks" \
  -H "Authorization: Bearer YOUR_DIALPAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "hook_url": "https://screenpop.yourdomain.com/dialpad/call-events",
    "secret": "your-webhook-secret-here"
  }'

# Save the webhook ID from the response, then:

# Step 2: Create the call event subscription
curl -X POST "https://dialpad.com/api/v2/subscriptions/call" \
  -H "Authorization: Bearer YOUR_DIALPAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_id": "WEBHOOK_ID_FROM_STEP_1",
    "call_states": ["connected"],
    "target_type": "company"
  }'
```

### 7. Configure Five9 Connector

In Five9, set up the connector to POST to:
```
https://screenpop.yourdomain.com/five9/transfer
```

With JSON body containing:
```json
{
  "phone": "{{ANI}}",
  "salesforce_id": "{{SalesforceRecordId}}"
}
```

(Use whatever Five9 variable syntax maps to the caller's phone number and the Salesforce record ID)

## Testing

### Test Five9 side manually:
```bash
curl -X POST https://screenpop.yourdomain.com/five9/transfer \
  -H "Content-Type: application/json" \
  -d '{"phone": "+15551234567", "salesforce_id": "00Q1234567890AB"}'
```

### Check the cache:
```bash
curl https://screenpop.yourdomain.com/debug/cache
```

### Check health:
```bash
curl https://screenpop.yourdomain.com/health
```

## Troubleshooting

- **Logs**: `sudo journalctl -u dialpad-screenpop -f`
- **Restart**: `sudo systemctl restart dialpad-screenpop`
- **Screen pop not firing**: Check that your Dialpad API key has the `screen_pop` scope
- **No cached data**: Verify Five9 connector is hitting `/five9/transfer` before the call is answered
- **JWT decode errors**: Make sure `DIALPAD_WEBHOOK_SECRET` matches what you used in the webhook create call
