# Project Architecture Guide (Current)

## Scope

This codebase is now campaign-focused:
- WhatsApp campaign sending
- WhatsApp number verification
- Email campaign sending

Not included:
- Inbound WhatsApp auto-reply/chatbot flows
- Prompt-manager driven auto-reply logic
- Google OAuth login for AI
- OpenAI fallback

## Runtime Flow

1. `index.js` starts Express/socket server from `server.js`.
2. `whatsapp-runtime.service.js` creates one WhatsApp client session.
3. Dashboard receives QR/status/log events through Socket.IO.
4. Campaign and verifier APIs use the same connected WhatsApp client (`state.botClient`).

## Core Services

- `src/services/whatsapp-runtime.service.js`
  - Owns WhatsApp session lifecycle (start/QR/ready/disconnect/logout)

- `src/services/campaign.service.js`
  - Parses contacts (file/sheet/group)
  - Optionally applies Gemini AI message variation
  - Verifies recipient availability on WhatsApp before send
  - Sends messages/media in paced batches

- `src/services/verifier.service.js`
  - Parses contacts
  - Optionally checks Talentwale candidate presence
  - Verifies WhatsApp availability using same sender account client
  - Exposes downloadable result CSVs (valid/skipped/invalid/failed)

- `src/services/email.service.js`
  - Parses contacts
  - Sends templated HTML email campaigns with account-aware limits

- `src/services/config.service.js`
  - Dashboard stats, logs, `.env` config CRUD, group listing/export

## API Route Groups

- `src/routes/bot.routes.js`
  - `/api/bot/start`, `/stop`, `/restart`, `/logout`

- `src/routes/campaign.routes.js`
  - Parse/start/stop/active/log/preset endpoints for WhatsApp campaigns

- `src/routes/verifier.routes.js`
  - Parse/start/pause/resume/stop/active/log endpoints for verification

- `src/routes/email.routes.js`
  - Parse/start/stop/active/log/accounts/test/preset endpoints for email campaigns

- `src/routes/config.routes.js`
  - Stats/logs/config and group export endpoints

## Frontend

- `public/index.html`
  - Pages: Overview, Live Logs, Bulk Campaign, Email Campaign, Bulk Verifier, Configuration

- `public/assets/dashboard.js`
  - Handles socket events, status updates, and each page workflow
