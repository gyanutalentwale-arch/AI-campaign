# Project Architecture Guide

## Product Scope

This codebase is campaign-focused:
- WhatsApp bulk sending
- WhatsApp bulk number verification
- Email bulk campaigns

Not part of this codebase:
- Inbound WhatsApp chatbot / auto-reply
- Prompt manager based bot behavior
- Google OAuth AI auth flow
- OpenAI model flow

## High-Level Architecture

- **Entry layer**: `index.js`, `server.js`
- **API layer**: `src/routes/*` + `src/controllers/*`
- **Business layer**: `src/services/*`
- **UI layer**: `public/index.html`, `public/assets/dashboard.js`, `public/assets/dashboard.css`

## Backend Flow

1. `index.js` loads env and starts HTTP server.
2. `server.js` initializes Express, Socket.IO, shared `state`, and registers routes.
3. `whatsapp-runtime.service.js` manages the single WhatsApp Web client lifecycle.
4. Campaign/verifier/email services execute long-running jobs and emit progress via Socket.IO.

## Shared State (`app-state.model.js`)

- `botStatus`, `qrCode`, `logs`
- `botClient`, `botInitFn`, `botDestroyFn`, `botLogoutFn`
- `activeCampaignId`, `activeVerifierId`
- usage stats and email stats

## Routes Overview

### Bot
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/restart`
- `POST /api/bot/logout`

### Campaign (WhatsApp)
- `POST /api/campaign/parse`
- `POST /api/campaign/parse-sheet`
- `POST /api/campaign/start`
- `POST /api/campaign/stop/:id`
- `GET /api/campaign/active`
- `GET /api/campaign/:id/log`
- `GET /api/campaign/preset`
- `POST /api/campaign/preset`

### Verifier
- `POST /api/verifier/parse-upload`
- `POST /api/verifier/parse-sheet`
- `POST /api/verifier/start`
- `POST /api/verifier/pause`
- `POST /api/verifier/resume`
- `POST /api/verifier/stop`
- `GET /api/verifier/active`
- `GET /api/verifier/log/:id`

### Email
- `POST /api/email/parse`
- `POST /api/email/parse-sheet`
- `POST /api/email/start`
- `POST /api/email/stop/:id`
- `GET /api/email/active`
- `GET /api/email/:id/log`
- `GET /api/email/accounts`
- `GET /api/email/test`
- `GET /api/email/preset`
- `POST /api/email/preset`

### Config
- `GET /api/stats`
- `GET /api/logs`
- `GET /api/config`
- `POST /api/config`
- `GET /api/groups`
- `GET /api/groups/:groupId/export`

## File Ownership Guide

- `src/services/campaign.service.js`
  - WhatsApp campaign parsing, templating, AI variation, send loop

- `src/services/verifier.service.js`
  - Bulk verification jobs, optional Talentwale match, CSV outputs

- `src/services/email.service.js`
  - Email contacts parse + SMTP send engine + account limits

- `src/services/whatsapp-runtime.service.js`
  - WhatsApp auth/qr/ready/disconnect behavior

- `public/assets/dashboard.js`
  - Frontend actions, API calls, socket listeners, progress rendering

## Runtime Artifacts (ignored in git)

- `whatsapp_session/`
- `campaign_preset.json`
- `email_preset.json`
- `email_usage_state.json`
- `*.log`
