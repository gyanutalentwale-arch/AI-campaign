# AI WhatsApp Campaign & Career Assistant Bot

This repository contains a full-featured WhatsApp Career Assistant Bot integrated with a live dashboard for managing AI-driven interactions, bulk email campaigns, and multi-AI backend fallbacks. It is designed to automate career guidance, handle candidate questions, seamlessly fetch job details, and dispatch outreach campaigns.

## Key Features

* **Multi-AI Fallback Architecture**: Robust integration using Google Gemini (via API key or OAuth) as the primary engine. If rate-limits or exceptions occur, it seamlessly falls back to OpenAI GPT models.
* **WhatsApp Career Assistant**: Autonomous chat flows that collect candidate resumes, present live jobs, parse input safely, and maintain strict rate limits to avoid spam mapping.
* **Real-time Dashboard Console**: An elegant UI powered by `socket.io` and `express`. Manage the bot's status (scan QR code, start/stop), monitor active AI processing queues, and visualize usage stats dynamically in real-time.
* **Advanced Email Campaigns Engine**: Dedicated internal module supporting multiple SMTP accounts with rotation limits, uploading parsing data via XLSX, and sending customized interactive HTML emails. 
* **Safe State Management**: Intelligent auto-reply queuing logic, deduplication tracking during inbound floods, and ghost trigger prevention.

## Technology Stack

* **Backend Environment**: [Node.js](https://nodejs.org/), [Express](https://expressjs.com/)
* **WhatsApp Framework**: [whatsapp-web.js](https://wwebjs.dev/) (headless Puppeteer)
* **Real-time Communication**: [Socket.IO](https://socket.io/)
* **AI NLP Models**: [@google/generative-ai](https://www.npmjs.com/package/@google/generative-ai), [OpenAI Node SDK](https://github.com/openai/openai-node)
* **Utilities**: Nodemailer (Mailing), Multer & XLSX (File routing), QRCode (Authentication)

## Local Setup & Installation

### 1. Clone the repository
```bash
git clone https://github.com/gyanutalentwale-arch/AI-campaign.git
cd AI-campaign
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Setup
The project relies on environment variables for API keys and configurations. Create your own configuration by duplicating the example file format:
```bash
cp .env.example .env
```
*Open `.env` and fill in your Gemini/OpenAI API Keys, email account credentials, and adjust rate limit thresholds as required.*

### 4. Start the Application
```bash
npm start
```
By default, the server will launch operations on port `2105`. 

### 5. Access the Dashboard
1. Open your browser and navigate to `http://localhost:2105`.
2. Connect the WhatsApp instance by scanning the displayed QR code via your linked-devices tab.
3. Manage, pause, or view AI statistics seamlessly.

## Project Architecture & Configuration

* **`index.js` / `server.js`**: Core entry points connecting Express routers, WhatsApp-Web initialization, Socket broadcasting, and polling configurations.
* **`/src/routes/`**: Distinct logical separations mapping `bot`, `config`, `campaign`, and `email` handler routes.
* **`/prompts/`**: Stores static templates (`system_prompt.txt`), AI rules context, and mapping guidelines ensuring modular editing without code touches.
* **Security Check**: This repository uses a secure, sanitized boilerplate format. Sensitive dynamic folders like `/whatsapp_session/`, runtime states (`data/`), server logs, and personal test presets are excluded natively.

## License
Provided for internal organization use. Ensure to comply with WhatsApp/Meta's messaging terms of service regarding automated scripts.