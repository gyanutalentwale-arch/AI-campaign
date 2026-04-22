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

## Project Layout

```text
.
|-- index.js                     # App bootstrap (starts HTTP server)
|-- server.js                    # Express + Socket.IO setup, shared state
|-- src/
|   |-- routes/                  # API route registration
|   |-- controllers/             # Request/response handlers
|   |-- services/                # Business logic (campaign, email, verifier, bot)
|   `-- models/                  # In-memory app state shape
|-- public/
|   |-- index.html               # Dashboard markup
|   `-- assets/
|       |-- dashboard.js         # Dashboard behavior
|       `-- dashboard.css        # Dashboard styles
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
- WhatsApp session cache is stored in `whatsapp_session/` and ignored by git.
