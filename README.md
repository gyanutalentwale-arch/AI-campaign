# Talentwale Campaign Dashboard

Campaign-first Node.js app for:
- WhatsApp bulk campaigns
- WhatsApp number verification
- Email campaigns (multi SMTP)

Single WhatsApp account is used for both sender and verifier flow.
Inbound chatbot/auto-reply flow is intentionally removed.
AI variation is Gemini-only.

## Quick Start

1. Install dependencies
```bash
npm install
```

2. Create env file
```bash
cp .env.example .env
# PowerShell: Copy-Item .env.example .env
```

3. Fill required values in `.env`
- `GEMINI_API_KEY`
- `DASHBOARD_PORT`
- `EMAIL_1_USER`, `EMAIL_1_PASSWORD`, `EMAIL_1_NAME`

4. Run
```bash
npm start
```

5. Open dashboard
- `http://localhost:<DASHBOARD_PORT>`

## Azure App Service Deployment (Recommended: Linux Custom Container)

This project is now Azure-ready with:
- automatic managed port support (`PORT` / `WEBSITES_PORT`)
- persistent runtime storage support (`APP_DATA_DIR`, default `/home/site/data` on Azure)
- Puppeteer + Chromium compatible Docker runtime

### Fastest way (recommended)

```powershell
az login --use-device-code
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-azure.ps1 -ResourceGroup <resourceGroup> -AppName <uniqueAppName>
```

Notes:
- Script auto-creates ACR + App Service plan + Web App + image build + app settings.
- By default it reads values from `.env` and applies only non-placeholder keys.
- Optional flags: `-SubscriptionId`, `-Location`, `-PlanName`, `-AcrName`, `-Sku`, `-ImageTag`.

### 1) Build and push image to ACR

```bash
az acr build --registry <acrName> --image wp-bot:latest .
```

### 2) Create App Service plan + Web App (Linux)

```bash
az appservice plan create \
  --resource-group <resourceGroup> \
  --name <appServicePlan> \
  --is-linux \
  --sku B1

az webapp create \
  --resource-group <resourceGroup> \
  --plan <appServicePlan> \
  --name <appName>
```

### 3) Attach container image (ACR)

```bash
ACR_USER=$(az acr credential show --name <acrName> --query username -o tsv)
ACR_PASS=$(az acr credential show --name <acrName> --query passwords[0].value -o tsv)

az webapp config container set \
  --resource-group <resourceGroup> \
  --name <appName> \
  --container-image-name <acrName>.azurecr.io/wp-bot:latest \
  --container-registry-url https://<acrName>.azurecr.io \
  --container-registry-user $ACR_USER \
  --container-registry-password $ACR_PASS
```

### 4) Set required App Settings

```bash
az webapp config appsettings set \
  --resource-group <resourceGroup> \
  --name <appName> \
  --settings \
    WEBSITES_PORT=3000 \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
    APP_DATA_DIR=/home/site/data \
    GEMINI_API_KEY=<your_key> \
    EMAIL_1_USER=<smtp_user> \
    EMAIL_1_PASSWORD=<smtp_password> \
    EMAIL_1_NAME=<sender_name>
```

### 5) Enable realtime behavior

```bash
az webapp config set \
  --resource-group <resourceGroup> \
  --name <appName> \
  --web-sockets-enabled true \
  --always-on true
```

### 6) Restart app

```bash
az webapp restart --resource-group <resourceGroup> --name <appName>
```

## Important Azure Notes

- Keep App Service instances at `1` for WhatsApp session stability.
- Runtime files (session, cache, log, presets) are stored in `APP_DATA_DIR`.
- On Azure Linux custom container, keep `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` so `/home` persists.
- Prefer Azure App Settings instead of editing `.env` in production.

## Project Layout

```text
.
|-- index.js                     # App bootstrap (starts HTTP server)
|-- server.js                    # Express + Socket.IO setup, shared state
|-- src/
|   |-- routes/                  # API route registration
|   |-- controllers/             # Request/response handlers
|   |-- services/                # Business logic (campaign, email, verifier, bot)
|   |-- models/                  # In-memory app state shape
|   `-- utils/                   # Runtime path helpers (Azure/local)
|-- public/
|   |-- index.html               # Dashboard markup
|   `-- assets/
|       |-- dashboard.js         # Dashboard behavior
|       `-- dashboard.css        # Dashboard styles
|-- Dockerfile                   # Azure App Service custom container runtime
`-- docs/
    `-- PROJECT_ARCHITECTURE_GUIDE.md
```

## Main Runtime Flow

1. `index.js` starts the server from `server.js`.
2. `whatsapp-runtime.service.js` creates and manages one WhatsApp client session.
3. Dashboard gets real-time updates through Socket.IO (`status`, `qr`, `log`, campaign progress).
4. Campaign + verifier both use the same connected `state.botClient`.

## Where To Change What

- WhatsApp connect lifecycle: `src/services/whatsapp-runtime.service.js`
- WhatsApp campaign send logic: `src/services/campaign.service.js`
- Number verification logic: `src/services/verifier.service.js`
- Email campaign logic: `src/services/email.service.js`
- Dashboard behavior/UI actions: `public/assets/dashboard.js`
- API route wiring: `src/routes/index.js`

## Notes

- Preset/state files (`campaign_preset.json`, `email_preset.json`, `email_usage_state.json`) are runtime artifacts.
- WhatsApp session cache is runtime data and ignored by git.
- `bot_usage.log` is also runtime data and should stay outside source control.
