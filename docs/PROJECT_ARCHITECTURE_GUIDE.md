# Project Architecture Guide

This document is the quickest way to understand how this project works and where to make changes.

It is written for:
- Developers joining the project
- AI coding agents working in this repo
- Anyone debugging WhatsApp bot, dashboard, campaign, or email behavior

## 1. What This Project Does

This is a Node.js application that combines:
- A WhatsApp bot powered by `whatsapp-web.js`
- AI replies using Gemini with OpenAI fallback
- A browser dashboard for control, logs, config, prompts, users, and history
- Bulk WhatsApp campaigns
- Bulk email campaigns

The app is mostly driven by 3 files:
- `index.js` = main app logic and WhatsApp runtime
- `server.js` = Express server, Socket.IO, shared state
- `public/index.html` = full dashboard UI and frontend logic

## 2. High-Level Runtime Flow

Startup flow:
1. `index.js` loads `.env`
2. `index.js` imports `server.js`
3. `server.js` creates Express app, HTTP server, Socket.IO, and shared `state`
4. `server.js` registers API routes from `src/routes/*`
5. `index.js` starts the dashboard server with `startServer()`
6. `index.js` creates the WhatsApp client and registers WhatsApp event handlers
7. Dashboard buttons call API endpoints
8. API endpoints update shared `state`
9. `index.js` reacts to state and WhatsApp events

Important detail:
- `console.log` and `console.error` are overridden in `index.js` and pushed into dashboard logs instead of the terminal

## 3. Core File Map

### Root files

- `index.js`
  Main runtime.
  Owns WhatsApp client, QR flow, unread scan, incoming queue, rate limiting, AI reply pipeline, and message history sync.

- `server.js`
  Shared backend bootstrap.
  Creates Express app, Socket.IO server, in-memory shared state, runtime-state persistence, and route registration.

- `botConfig.js`
  Prompt loader and AI tool definitions.
  Loads `prompts/system_prompt.txt`, `prompts/links.json`, and `prompts/industries.json`.

- `.env`
  All runtime config.
  API keys, models, rate limits, dashboard port, campaign AI settings, email account settings.

- `campaign_preset.json`
  Saved WhatsApp campaign form values.

- `email_preset.json`
  Saved email campaign form values.

- `email_usage_state.json`
  Per-account email daily usage persistence.

- `bot_usage.log`
  AI usage log used to build dashboard usage stats.

### Backend folders

- `src/routes/bot.routes.js`
  WhatsApp connect, stop, restart, logout APIs.

- `src/routes/config.routes.js`
  Dashboard stats, logs, users, chat history, prompt file APIs, config APIs, auto-reply toggle, group export APIs.

- `src/routes/campaign.routes.js`
  Very large file.
  Contains both WhatsApp campaign logic and email campaign logic.

- `src/routes/email.routes.js`
  Currently just a placeholder.
  Email logic is actually inside `src/routes/campaign.routes.js`.

- `src/services/jobs.service.js`
  External Talentwale jobs API integration used by AI tool calls.

- `src/controllers/`
  Present but currently unused.

- `src/utils/`
  Present but currently unused.

### Frontend

- `public/index.html`
  Entire dashboard in one file.
  Contains:
  - HTML structure
  - CSS styling
  - Socket.IO listeners
  - All frontend fetch calls
  - Campaign UI logic
  - Email UI logic
  - Config UI logic
  - Prompt editor UI logic

### Prompt and data folders

- `prompts/system_prompt.txt`
  Main bot persona and reply instructions.

- `prompts/links.json`
  Placeholder values injected into the system prompt.

- `prompts/industries.json`
  Industry name -> ID mapping used for job search tool filtering.

- `data/runtime_state.json`
  Persists runtime toggles like `autoReply`.

- `data/employers_dump.json`
  Data file present in repo. Not part of the main bot reply flow.

- `whatsapp_session/`
  Local WhatsApp session storage for `LocalAuth`.

## 4. Shared State You Must Understand

The app uses a shared `state` object from `server.js`.

Important keys:
- `state.botStatus`
  `stopped`, `starting`, `qr`, `ready`

- `state.qrCode`
  Current QR image data URL for dashboard

- `state.logs`
  Dashboard log buffer

- `state.chatHistory`
  Chat history shown in dashboard

- `state.messageStats`
  WhatsApp AI usage counters

- `state.emailStats`
  Email counters and active account info

- `state.activeUsers`
  Users shown in dashboard

- `state.botClient`
  Active WhatsApp client instance once ready

- `state.botInitFn`
  Function injected by `index.js` to initialize the WhatsApp client

- `state.botDestroyFn`
  Function injected by `index.js` to destroy the WhatsApp client

- `state.activeCampaignId`
  Current running WhatsApp campaign ID

- `state.campaignRecipients`
  Recipients set for current campaign

- `state.autoReply`
  Master switch for reply behavior

- `state.processUnreadFn`
  Function injected by `index.js` to process unread messages when needed

- `state.persistRuntimeState`
  Saves runtime toggles to `data/runtime_state.json`

If a backend change needs dashboard visibility, it usually requires updating `state` and maybe `io.emit(...)`.

## 5. Main Logic by Feature

## 5.1 WhatsApp connect / session / QR

Main files:
- `src/routes/bot.routes.js`
- `index.js`

How it works:
1. Dashboard button calls `/api/bot/start`
2. Route calls `state.botInitFn()`
3. `index.js` handles WhatsApp events:
   - `qr`
   - `auth_failure`
   - `disconnected`
   - `ready`
4. Status and QR are pushed to dashboard through Socket.IO

Change here if you want to modify:
- Connect / disconnect behavior
- Reconnect logic
- QR handling
- Logout / session clearing
- Startup status transitions

## 5.2 Auto reply and incoming message flow

Main file:
- `index.js`

Key functions:
- `queueIncomingMessage(...)`
- `processUnreadMessages(...)`
- `processMessageQueue(...)`
- `handleMessage(...)`

Live flow:
1. WhatsApp emits `message` or `message_create`
2. `queueIncomingMessage(...)` validates the event
3. If `state.autoReply` is off, message is skipped
4. If on, message goes into `messageQueue`
5. `processMessageQueue()` applies delay and anti-spam logic
6. `handleMessage()` builds AI context and sends the reply

Unread flow:
1. On bot `ready`, `processUnreadMessages('ready')` runs if auto-reply is on
2. When auto-reply is toggled on from dashboard, `processUnreadMessages('toggle_on')` runs

Change here if you want to modify:
- Auto-reply rules
- Unread catch-up behavior
- Event deduping
- Rate limiting
- Typing delays
- History trimming
- Reply sending logic
- Fallback between Gemini and OpenAI

## 5.3 AI prompt and tool behavior

Main files:
- `botConfig.js`
- `prompts/system_prompt.txt`
- `prompts/links.json`
- `prompts/industries.json`
- `src/services/jobs.service.js`

How it works:
- `getSystemInstructions()` loads the system prompt and injects placeholders from `links.json`
- `tools` defines the `search_jobs` tool
- `handleMessage()` in `index.js` uses Gemini first, then fallback Gemini, then OpenAI
- Tool calls are resolved through `searchJobsFromApi(...)`

Change here if you want to modify:
- Bot tone
- Business rules in prompt
- Contact links injected in prompt
- Tool schema
- Job search API logic
- Industry mapping

Important caveat:
- `system_prompt.txt` and `links.json` are read dynamically and can affect next messages
- `industries.json` is turned into `INDUSTRY_MAP` at module load, so changing it may require a process restart

## 5.4 Dashboard frontend

Main file:
- `public/index.html`

What lives here:
- Layout and styling
- Navigation tabs
- Socket listeners
- Fetch calls to all APIs
- Users/history rendering
- Prompt manager UI
- Config editor UI
- Bot control buttons
- Auto-reply toggle
- Campaign forms and progress
- Email forms and progress

Change here if you want to modify:
- Dashboard look and feel
- Tab layout
- Button behavior
- Client-side validation
- Progress UI
- Config UI
- Toasts and log presentation

Important note:
- This file is large and contains both markup and logic
- Search by function name before editing instead of scrolling blindly

Useful frontend functions:
- `updateStatus`
- `updateUsers`
- `renderChat`
- `loadTraining`
- `loadConfig`
- `connectWhatsApp`
- `toggleAutoReply`
- `startCampaign`
- `stopCampaign`
- `loadEmailPreset`
- `saveEmailPreset`

## 5.5 Dashboard API surface

Main files:
- `src/routes/config.routes.js`
- `src/routes/bot.routes.js`
- `src/routes/campaign.routes.js`

Route groups:

Bot control:
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/restart`
- `POST /api/bot/logout`

Dashboard state and utilities:
- `GET /api/stats`
- `GET /api/logs`
- `GET /api/usage-log`
- `GET /api/users`
- `GET /api/history/:userId`
- `DELETE /api/history/:userId`

Prompt manager:
- `GET /api/prompt-file`
- `POST /api/prompt-file`

Config:
- `GET /api/config`
- `POST /api/config`
- `GET /api/autoreply`
- `POST /api/autoreply`

Groups:
- `GET /api/groups`
- `GET /api/groups/:groupId/export`

WhatsApp campaign:
- `POST /api/campaign/parse`
- `POST /api/campaign/parse-sheet`
- `POST /api/campaign/upload-image`
- `GET /api/campaign/preset`
- `POST /api/campaign/preset`
- `POST /api/campaign/start`
- `POST /api/campaign/stop/:id`
- `GET /api/campaign/active`
- `GET /api/campaign/:id/log`

Email campaign:
- `POST /api/email/parse`
- `POST /api/email/parse-sheet`
- `GET /api/email/test`
- `GET /api/email/accounts`
- `GET /api/email/preset`
- `POST /api/email/preset`
- `POST /api/email/start`
- `POST /api/email/stop/:id`
- `GET /api/email/:id/log`

If you add a new dashboard feature, you usually need changes in both:
- backend route file
- `public/index.html`

## 5.6 WhatsApp campaign flow

Main file:
- `src/routes/campaign.routes.js`

What this file handles:
- CSV/XLSX/Google Sheet parsing
- Group export import flow
- Phone normalization
- WhatsApp ID building
- AI variation generation for campaign copy
- Human-like typing and delay logic
- Campaign progress tracking
- Downloadable campaign result log

Important internal areas:
- Contact parsing
- Number normalization
- Campaign preset load/save
- Campaign send loop
- Progress broadcasting through Socket.IO

Change here if you want to modify:
- Accepted contact file formats
- Number parsing rules
- Delay strategy
- Campaign pacing
- AI rewrite rules for campaigns
- Image send behavior
- Stop / resume behavior
- CSV export format

## 5.7 Email campaign flow

Main file:
- `src/routes/campaign.routes.js`

Email is currently implemented in the same file as WhatsApp campaigns.

What it handles:
- Email contact parsing
- Gmail / Google Workspace SMTP sending
- Multiple account rotation
- Daily per-account usage tracking
- Midnight reset logic
- Email preset save/load
- Email campaign progress and CSV log

Change here if you want to modify:
- SMTP config behavior
- Account pooling
- Daily limit logic
- Email template save/load
- Email send pacing
- Email validation

Important note:
- `src/routes/email.routes.js` is not where real email logic lives right now

## 6. Where To Change What

Use this as the fastest edit map.

### Change bot reply wording or behavior

Start with:
- `prompts/system_prompt.txt`
- `botConfig.js`
- `index.js`

Use:
- prompt-only change for tone or instructions
- `handleMessage()` in `index.js` for logic changes

### Change when bot should reply or skip

Start with:
- `index.js`

Look at:
- `queueIncomingMessage(...)`
- `processUnreadMessages(...)`
- `handleMessage(...)`

### Change WhatsApp connection behavior

Start with:
- `src/routes/bot.routes.js`
- `index.js`

### Change dashboard buttons, widgets, forms, or layout

Start with:
- `public/index.html`

### Change dashboard backend API

Start with:
- `src/routes/config.routes.js`
- `src/routes/bot.routes.js`
- `src/routes/campaign.routes.js`

### Change prompt editor or config editor behavior

Start with:
- `public/index.html`
- `src/routes/config.routes.js`

### Change job search tool or API filtering

Start with:
- `src/services/jobs.service.js`
- `botConfig.js`
- `prompts/industries.json`

### Change WhatsApp campaign sending behavior

Start with:
- `src/routes/campaign.routes.js`

Look for:
- phone normalization
- AI variation
- send loop
- anti-ban delay logic

### Change email campaign behavior

Start with:
- `src/routes/campaign.routes.js`

Look for:
- `EMAIL_*` env usage
- transport creation
- account rotation
- daily usage state

### Change what is saved between restarts

Start with:
- `server.js`
- `data/runtime_state.json`
- `email_usage_state.json`
- `campaign_preset.json`
- `email_preset.json`

## 7. Settings and Restart Rules

Not every change behaves the same way.

Changes that usually apply on next bot action:
- `prompts/system_prompt.txt`
- `prompts/links.json`
- auto-reply toggle
- campaign preset save
- email preset save

Changes that usually need a process restart:
- `.env` values
- most model settings from `.env`
- dashboard port
- rate limiting values from `.env`
- `prompts/industries.json` in practice

WhatsApp session reset:
- Use `/api/bot/logout`
- This clears the saved session so a new QR is required

## 8. Debugging Checklist

If bot is not replying:
- Check dashboard status: `stopped`, `starting`, `qr`, `ready`
- Check auto-reply toggle state
- Check dashboard logs
- Check unread-scan behavior when turning auto-reply on
- Check `GEMINI_API_KEY`
- Check `bot_usage.log` to see whether AI calls are happening

If dashboard shows wrong state:
- Check `state` updates in `server.js` and `index.js`
- Check corresponding `io.emit(...)`
- Check frontend `socket.on(...)` listeners in `public/index.html`

If config changes do not work:
- Remember `.env` changes need restart
- Confirm frontend saves through `/api/config`
- Confirm backend route is reading the updated env only after restart

If prompt change does not show:
- Confirm you edited the correct prompt file
- Confirm the logic lives in prompt and not in `index.js`
- If industry matching changed, restart the process

If campaign behavior is wrong:
- Check `src/routes/campaign.routes.js`
- Check parsing step
- Check number normalization
- Check delay and send loop
- Check `campaign_progress` socket updates

If email behavior is wrong:
- Check `EMAIL_*` values in `.env`
- Check account loading and usage state logic in `src/routes/campaign.routes.js`
- Check `/api/email/test`

## 9. Recommended Editing Pattern For New Features

If you add a new dashboard-controlled feature, the normal path is:
1. Add UI in `public/index.html`
2. Add frontend fetch or socket handling in the same file
3. Add backend API in the correct route file
4. Update shared `state` in `server.js` or runtime code if the feature is live state
5. If the bot runtime must react, wire it in `index.js`
6. If the feature must survive restart, persist it to a file

Example:
- New toggle affecting live bot behavior
  - frontend toggle in `public/index.html`
  - API route in `src/routes/config.routes.js`
  - state storage in `server.js`
  - runtime use in `index.js`

## 10. Current Technical Debt / Refactor Hotspots

These are the biggest complexity hotspots in the repo.

- `public/index.html`
  Giant frontend file with HTML, CSS, and all JS combined

- `src/routes/campaign.routes.js`
  Contains both WhatsApp campaign logic and email campaign logic

- `index.js`
  Owns startup, logging override, WhatsApp runtime, queueing, unread scan, AI pipeline, and reply sending

If you plan major changes, the safest future refactor path is:
- split dashboard JS from HTML
- split WhatsApp campaign routes from email routes
- extract AI reply pipeline from `index.js` into a service
- extract shared utility helpers from large route files

## 11. Fast Search Hints

Use these search terms when locating logic quickly:

- WhatsApp reply logic:
  `queueIncomingMessage`
  `processUnreadMessages`
  `handleMessage`

- Bot status / QR:
  `client.on('qr'`
  `client.on('ready'`
  `botInitFn`

- Auto reply:
  `/api/autoreply`
  `state.autoReply`

- Campaign:
  `/api/campaign/start`
  `campaign_progress`
  `humanDelay`
  `getUniqueVariation`

- Email:
  `/api/email/start`
  `createTransport`
  `EMAIL_DAILY_LIMIT`

- Prompt system:
  `getSystemInstructions`
  `search_jobs`
  `INDUSTRY_MAP`

## 12. Bottom Line

If you only remember one thing, remember this:

- `index.js` = live WhatsApp bot brain
- `server.js` = shared state and backend shell
- `public/index.html` = full dashboard frontend
- `src/routes/campaign.routes.js` = both WhatsApp campaign and email campaign engine
- `src/routes/config.routes.js` = dashboard support APIs
- `botConfig.js` + `prompts/*` = AI behavior definition

