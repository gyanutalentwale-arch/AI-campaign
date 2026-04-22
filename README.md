# Talentwale Campaign Bot

A Node.js dashboard to run:
- WhatsApp bulk campaigns
- WhatsApp bulk number verification
- Email campaigns (multi SMTP)

The system uses a single WhatsApp session/account for both sending and verification.
Inbound auto-reply/chatbot flows are removed.
AI message variation is Gemini-only.

## Stack

- Node.js + Express
- whatsapp-web.js
- Socket.IO
- Gemini (`@google/generative-ai`)
- Nodemailer, Multer, XLSX

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create environment file:
```bash
cp .env.example .env
```

3. Update required keys/settings in `.env`:
- `GEMINI_API_KEY`
- `DASHBOARD_PORT`
- Email account variables (`EMAIL_1_USER`, `EMAIL_1_PASSWORD`, etc.)

4. Start app:
```bash
npm start
```

5. Open dashboard:
- `http://localhost:<DASHBOARD_PORT>`

## Main Modules

- `index.js`, `server.js`: app bootstrap and sockets
- `src/services/whatsapp-runtime.service.js`: single WhatsApp runtime
- `src/services/campaign.service.js`: WhatsApp campaign send flow + Gemini variation
- `src/services/verifier.service.js`: bulk WhatsApp number verification
- `src/services/email.service.js`: email campaign engine
- `src/routes/*`: API routes for bot/config/campaign/email/verifier
- `public/*`: dashboard UI
