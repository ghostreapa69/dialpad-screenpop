# Dialpad Screen Pop Middleware — Full Deployment Guide

## Overview

This guide walks you through every step to get the Five9 → Dialpad → Salesforce screen pop working on your Hostinger VPS using Docker and Portainer.

**What we're building:**

Five9 transfers a call → Five9 connector sends caller phone + Salesforce ID to your server → server caches mapping in Redis (5-minute TTL) → call arrives at Dialpad → agent answers → Dialpad sends "connected" event to your server → server matches the phone number in Redis → server calls Dialpad Screen Pop API → Salesforce record opens on the agent's screen.

The stack consists of two Docker containers: the Node.js middleware and a Redis instance used as a short-lived cache.

---

## Phase 1: Get Your Dialpad API Key

Before anything else, you need a Dialpad API key with the right permissions.

### Step 1.1 — Generate the API Key

1. Log into **Dialpad** as a Company Admin
2. Go to **Admin Settings** → **Company Settings**
3. Look for **API Keys** (or go to https://dialpad.com/settings/api)
4. Click **Create API Key**
5. Give it a name like `Five9 Screen Pop Middleware`
6. Make sure the following **scopes** are enabled:
   - `screen_pop` — required to trigger screen pops on user devices
   - `call_event_subscription` — required to subscribe to call events
   - `webhook` — required to create webhooks
7. Copy the API key and **save it somewhere secure** — you'll need it multiple times

> **Note:** If you don't see API key options in your admin panel, your Dialpad plan may require you to request API access. Contact Dialpad support or fill out the developer access form at https://developers.dialpad.com/docs/guidelines

---

## Phase 2: Prepare Your Hostinger VPS

### Step 2.1 — SSH into your VPS

```bash
ssh root@YOUR_VPS_IP
```

### Step 2.2 — Make sure Docker and Portainer are running

If Docker isn't installed yet:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Start Docker
sudo systemctl enable docker
sudo systemctl start docker
```

If Portainer isn't installed yet:

```bash
# Create Portainer volume
docker volume create portainer_data

# Run Portainer
docker run -d \
  -p 9000:9000 \
  -p 9443:9443 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Portainer will be available at `https://YOUR_VPS_IP:9443`.

### Step 2.3 — Create the project directory

```bash
mkdir -p /opt/stacks/dialpad-screenpop
cd /opt/stacks/dialpad-screenpop
```

### Step 2.4 — Upload the project files

From your local machine, upload the files:

```bash
scp server.js package.json Dockerfile docker-compose.yml root@YOUR_VPS_IP:/opt/stacks/dialpad-screenpop/
```

Or, if you prefer, SSH in and create them manually by pasting the contents.

Verify the files are there:

```bash
ls -la /opt/stacks/dialpad-screenpop/
```

You should see:
- `server.js`
- `package.json`
- `Dockerfile`
- `docker-compose.yml`

> **Note:** The compose file includes a `redis` service alongside the app. No separate Redis install is needed.

---

## Phase 3: Deploy in Portainer

### Step 3.1 — Open Portainer

1. Go to `https://YOUR_VPS_IP:9443` in your browser
2. Log in to Portainer

### Step 3.2 — Create the Stack

1. Click **Stacks** in the left sidebar
2. Click **+ Add stack**
3. Give it a name: `dialpad-screenpop`
4. Under **Build method**, select **Upload** or **Web editor**

**If using Web editor**, paste this docker-compose content:

```yaml
version: "3.8"

services:
  redis:
    image: redis:7-alpine
    container_name: dialpad-screenpop-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  dialpad-screenpop:
    build: /opt/stacks/dialpad-screenpop
    container_name: dialpad-screenpop
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
    ports:
      - "3500:3500"
    environment:
      - PORT=3500
      - REDIS_URL=redis://redis:6379
      - DIALPAD_API_KEY=PASTE_YOUR_KEY_HERE
      - DIALPAD_WEBHOOK_SECRET=
      - SALESFORCE_BASE_URL=https://yourcompany.lightning.force.com
      - FIVE9_SECRET=
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3500/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  redis-data:
```

**If using Repository or Upload**, point to the `/opt/stacks/dialpad-screenpop` directory.

### Step 3.3 — Set Environment Variables

Before deploying, update the environment variables in the compose file:

| Variable | What to put |
|----------|-------------|
| `DIALPAD_API_KEY` | Your Dialpad API key from Phase 1 |
| `DIALPAD_WEBHOOK_SECRET` | Leave blank for now (you'll set this in Phase 5) |
| `SALESFORCE_BASE_URL` | Your Salesforce URL, e.g., `https://yourcompany.lightning.force.com` |
| `FIVE9_SECRET` | Optional. A random string you'll also put in the Five9 connector for auth |
| `REDIS_URL` | Leave as `redis://redis:6379` (the compose Redis service) |

### Step 3.4 — Deploy the Stack

1. Click **Deploy the stack**
2. Wait for it to build and start (30-60 seconds)
3. You should see the container status turn **green/running**

### Step 3.5 — Verify it's running

Either from Portainer's container console or via SSH:

```bash
curl http://localhost:3500/health
```

You should get back:

```json
{"status":"ok","uptime":5.123,"redis":"connected","cacheSize":0,"timestamp":"2026-03-24T..."}
```

---

## Phase 4: Set Up HTTPS with a Domain

Dialpad requires an HTTPS URL for webhooks. You need a domain or subdomain pointed at your VPS.

### Step 4.1 — Point a domain/subdomain to your VPS

In your DNS provider (Cloudflare, Hostinger DNS, etc.), create an **A record**:

```
Type: A
Name: screenpop          (or whatever subdomain you want)
Value: YOUR_VPS_IP
TTL: Auto
```

This gives you `screenpop.yourdomain.com`.

### Step 4.2 — Set up a reverse proxy

**Option A: If you already have Nginx Proxy Manager running in Docker:**

1. Open NPM at your usual URL
2. Click **Proxy Hosts** → **Add Proxy Host**
3. Fill in:
   - **Domain Names:** `screenpop.yourdomain.com`
   - **Scheme:** `http`
   - **Forward Hostname/IP:** `dialpad-screenpop` (container name) or `YOUR_VPS_IP`
   - **Forward Port:** `3500`
4. Go to the **SSL** tab
   - Select **Request a new SSL certificate**
   - Check **Force SSL**
   - Click **Save**

**Option B: If you're using standalone Nginx:**

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

Create the config:

```bash
sudo nano /etc/nginx/sites-available/dialpad-screenpop
```

Paste:

```nginx
server {
    listen 80;
    server_name screenpop.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it and get SSL:

```bash
sudo ln -s /etc/nginx/sites-available/dialpad-screenpop /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d screenpop.yourdomain.com
```

### Step 4.3 — Test HTTPS

```bash
curl https://screenpop.yourdomain.com/health
```

You should get the same JSON health response. If this works, your server is publicly reachable over HTTPS.

---

## Phase 5: Register the Webhook with Dialpad

Now you tell Dialpad to send call events to your server. This is the two-step API process.

### Step 5.1 — Create the Webhook

Run this from your terminal (or Postman, or any HTTP client):

```bash
curl -X POST "https://dialpad.com/api/v2/webhooks" \
  -H "Authorization: Bearer YOUR_DIALPAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "hook_url": "https://screenpop.yourdomain.com/dialpad/call-events",
    "secret": "pick-a-strong-random-string-here"
  }'
```

**Save two things from the response:**

1. The `id` — this is your **webhook_id** (you need it for Step 5.2)
2. The `secret` you used — you need to put this in your container's `DIALPAD_WEBHOOK_SECRET` environment variable

> **Important:** If you set a `secret` here, go back to Portainer → your stack → update the `DIALPAD_WEBHOOK_SECRET` environment variable to match, then redeploy the stack.
>
> If you'd rather keep things simple for initial testing, omit the `secret` field entirely — Dialpad will send plain JSON instead of JWT. You can always delete and recreate the webhook with a secret later.

### Step 5.2 — Create the Call Event Subscription

```bash
curl -X POST "https://dialpad.com/api/v2/subscriptions/call" \
  -H "Authorization: Bearer YOUR_DIALPAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_id": "WEBHOOK_ID_FROM_STEP_5_1",
    "call_states": ["connected"],
    "target_type": "company"
  }'
```

This tells Dialpad: "Every time any call in the company is answered, POST the event data to my webhook."

If you want to narrow it down to a specific department or call center:

```bash
# For a specific call center:
{
  "webhook_id": "WEBHOOK_ID",
  "call_states": ["connected"],
  "target_type": "call_center",
  "target_id": "YOUR_CALL_CENTER_ID"
}
```

### Step 5.3 — Verify the subscription

```bash
curl -X GET "https://dialpad.com/api/v2/subscriptions/call" \
  -H "Authorization: Bearer YOUR_DIALPAD_API_KEY"
```

You should see your subscription listed with the webhook URL and call states.

---

## Phase 6: Configure the Five9 Connector

This is the Five9 side — when a call is transferred to Dialpad, Five9 sends the Salesforce record ID to your server.

### Step 6.1 — Create or edit a Five9 Connector

1. Log into **Five9 Admin** (VCC Administrator)
2. Go to **Connectors** (or **Workflow Automation** → **Connectors** depending on your Five9 version)
3. Create a new connector or edit an existing one

### Step 6.2 — Configure the connector

Set it up as an **HTTP/REST** connector:

| Setting | Value |
|---------|-------|
| **Method** | POST |
| **URL** | `https://screenpop.yourdomain.com/five9/transfer` |
| **Content-Type** | `application/json` |
| **Body** | See below |

**Body (JSON):**

```json
{
  "phone": "{{Call.ANI}}",
  "salesforce_id": "{{Contact.salesforce_id}}"
}
```

> **Note:** The exact Five9 variable syntax depends on your setup. The `phone` field needs to be the **caller's phone number** (ANI), and `salesforce_id` needs to be the **Salesforce record ID** you want to pop. Adjust the Five9 variable names to match your campaign/contact fields.

**If you set a `FIVE9_SECRET`**, add an Authorization header:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer YOUR_FIVE9_SECRET_VALUE` |

### Step 6.3 — Set the trigger

Configure the connector to fire **on transfer** — specifically when an agent transfers a call to the Dialpad number/department. The exact trigger depends on your Five9 IVR script or disposition workflow.

---

## Phase 7: Test End-to-End

### Step 7.1 — Test the Five9 side manually

Simulate what Five9 would send:

```bash
curl -X POST https://screenpop.yourdomain.com/five9/transfer \
  -H "Content-Type: application/json" \
  -d '{"phone": "+15551234567", "salesforce_id": "00Q1234567890AB"}'
```

Expected response:

```json
{"status":"ok","phone":"+15551234567","salesforceId":"00Q1234567890AB"}
```

### Step 7.2 — Verify it's cached

```bash
curl https://screenpop.yourdomain.com/debug/cache
```

Expected:

```json
{"cacheSize":1,"entries":[{"phone":"+15551234567","salesforceId":"00Q1234567890AB","age":"3s ago","ttlRemaining":"297s"}]}
```

### Step 7.3 — Make a test call

1. Have someone call the Dialpad number that Five9 transfers to
2. Before transferring, trigger the Five9 connector (or use the manual curl above with the caller's real phone number)
3. Answer the call on Dialpad
4. Watch the server logs for the screen pop trigger:

```bash
# If using Portainer: go to the container → Logs
# If using SSH:
docker logs -f dialpad-screenpop
```

You should see:

```
[Five9] Cached: +15551234567 -> 00Q1234567890AB
[Dialpad] Call event: state=connected, direction=inbound, external=+15551234567
[Dialpad] Call answered by John Smith (5908860123456789) from +15551234567
[Dialpad] Found cached Salesforce ID: 00Q1234567890AB
[ScreenPop] Triggering for user 5908860123456789 -> https://yourcompany.lightning.force.com/00Q1234567890AB
[ScreenPop] Success! Status: 200
```

And the Salesforce record should open on the agent's screen.

---

## Troubleshooting

### "No Five9 data cached for +1555..."

The Five9 connector didn't fire before the agent answered, or the phone number format doesn't match. Check:
- Is Five9 sending the ANI in the same format Dialpad uses? (E.164, e.g., +15551234567)
- Is the connector firing at the right time (before/during transfer, not after)?
- Check the cache: `curl https://screenpop.yourdomain.com/debug/cache`

### Screen pop not appearing

- Check that the Dialpad API key has the `screen_pop` scope
- Check the agent has the Dialpad desktop app or browser app open
- Check the logs for error messages from the Dialpad API
- The Screen Pop API is rate-limited to 5 per minute per user

### Dialpad not sending events

- Verify subscription exists: `curl -H "Authorization: Bearer KEY" https://dialpad.com/api/v2/subscriptions/call`
- Make sure the webhook URL is HTTPS and publicly reachable
- Check if Dialpad is sending JWT and you're not decoding it (or vice versa)

### JWT decode errors

- Make sure `DIALPAD_WEBHOOK_SECRET` in your container matches the `secret` you used when creating the webhook
- If testing without JWT, remove the secret from both the webhook and the env variable

### Container won't start

- Check logs: `docker logs dialpad-screenpop`
- Make sure port 3500 isn't already in use: `ss -tlnp | grep 3500`

---

## Security Notes (for production)

1. **Remove the `/debug/cache` route** from `server.js` before going live — it exposes phone numbers and Salesforce IDs
2. **Use the Five9 secret** (`FIVE9_SECRET`) to authenticate connector requests
3. **Use the Dialpad webhook secret** (`DIALPAD_WEBHOOK_SECRET`) to verify events are from Dialpad
4. **Restrict access** — your reverse proxy should only allow POST to `/five9/transfer` and `/dialpad/call-events` from the internet, and block `/debug/*`
