const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const fs = require('fs');
const QRCode = require('qrcode');
const { tools, getSystemInstructions } = require('../../botConfig');
const {
    isGoogleOauthSessionValid,
    runGeminiOAuthChat,
} = require('./gemini-oauth.service');
require('dotenv').config();

// â”€â”€â”€ Dashboard Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = function createWhatsAppRuntime({ io, state, addLog }) {

function stringifyLogArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    try {
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
    } catch (_) {
        return String(arg);
    }
}

function normalizeLogText(text) {
    const cp1252Map = {
        0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
        0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
        0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
        0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
        0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
        0x017E: 0x9E, 0x0178: 0x9F,
    };
    const score = (value) => (String(value || '').match(/[ÃÂâðïœžš€™]/g) || []).length;
    const toBytes = (value) => {
        const str = String(value || '');
        const bytes = Buffer.alloc(str.length);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code <= 0xFF) {
                bytes[i] = code;
                continue;
            }
            const mapped = cp1252Map[code];
            if (mapped === undefined) return null;
            bytes[i] = mapped;
        }
        return bytes;
    };

    let best = String(text || '');
    let bestScore = score(best);
    if (!bestScore) return best;

    for (let i = 0; i < 3; i++) {
        const bytes = toBytes(best);
        if (!bytes) break;
        const next = bytes.toString('utf8');
        if (next === best) break;
        const nextScore = score(next);
        if (nextScore < bestScore) {
            best = next;
            bestScore = nextScore;
        } else {
            break;
        }
    }

    return best;
}

// Route logs to dashboard only (no terminal output)
console.log = (...args) => {
    const message = normalizeLogText(args.map(stringifyLogArg).join(' '));
    addLog('info', message);
};
console.error = (...args) => {
    const message = normalizeLogText(args.map(stringifyLogArg).join(' '));
    addLog('error', message);
};

// Log model usage
function logModelUsage(userId, modelName, message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] User: ${userId} | Model: ${modelName} | Msg: "${message}"\n`;
    fs.appendFile('bot_usage.log', logEntry, (err) => {
        if (err) console.error("Error writing to log file:", err);
    });
    if (typeof state.recordAiUsageStats === 'function') {
        state.recordAiUsageStats(modelName, timestamp);
    }
}

// Initialize Gemini API
const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;
if (!genAI) {
    console.log("⚠️ GEMINI_API_KEY not found. API key Gemini mode disabled.");
}

// Initialize OpenAI API (Fallback)
let openai;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
    console.log("âš ï¸ OPENAI_API_KEY not found. OpenAI fallback disabled.");
}

// Helper to get Gemini model instance
const getModel = (modelName, systemInstruction = getSystemInstructions()) => {
    if (!genAI) return null;
    return genAI.getGenerativeModel({
        model: modelName,
        tools: tools,
        systemInstruction,
    });
};

function getGeminiModelName(isRetry = false) {
    return isRetry
        ? (process.env.FALLBACK_MODEL || "gemini-2.0-flash")
        : (process.env.PRIMARY_MODEL || "gemini-2.5-flash");
}

function buildGeminiSystemInstruction(userName) {
    let sysText = getSystemInstructions().parts[0].text;
    if (userName) {
        sysText += `\n\n**USER INFO:** WhatsApp name: ${userName}. Use this name to personalize responses.`;
    }
    return { role: "system", parts: [{ text: sysText }] };
}

const { searchJobsFromApi } = require("./jobs.service");

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nðŸ›‘ Shutting down bot...');
    try { await client.destroy(); } catch (err) {}
    process.exit(0);
});

// Anti-Spam & Rate Limiting â€” values from .env, fallback to defaults
const messageQueue = [];
const userLastMessageTime = new Map();
const userMessageCount = new Map();
let isProcessing = false;

const RATE_LIMIT = {
    MIN_DELAY:       parseInt(process.env.MIN_DELAY)       || 2000,
    MAX_DELAY:       parseInt(process.env.MAX_DELAY)       || 5000,
    TYPING_MIN:      parseInt(process.env.TYPING_MIN)      || 1500,
    TYPING_MAX:      parseInt(process.env.TYPING_MAX)      || 4000,
    MAX_BURST:       parseInt(process.env.MAX_BURST)       || 4,
    COOLDOWN_PERIOD: parseInt(process.env.COOLDOWN_PERIOD) || 20000,
};

// Random delay generator (human-like)
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Check if user is rate limited (Pure check, no state modification)
function isRateLimited(userId) {
    const now = Date.now();
    const lastTime = userLastMessageTime.get(userId) || 0;
    const count = userMessageCount.get(userId) || 0;
    
    // If cooldown period passed, they are not limited
    if (now - lastTime > RATE_LIMIT.COOLDOWN_PERIOD) {
        return false;
    }
    
    // If burst limit reached within the cooldown period
    if (count >= RATE_LIMIT.MAX_BURST) {
        return true;
    }
    
    return false;
}

// Update user message tracking
function updateUserTracking(userId) {
    const now = Date.now();
    const lastTime = userLastMessageTime.get(userId) || 0;
    const count = userMessageCount.get(userId) || 0;
    
    if (now - lastTime > RATE_LIMIT.COOLDOWN_PERIOD) {
        userMessageCount.set(userId, 1);
    } else {
        userMessageCount.set(userId, count + 1);
    }
    
    userLastMessageTime.set(userId, now);
}

// Process message queue with delays (No skipping, queued instead)
async function processMessageQueue() {
    if (isProcessing || messageQueue.length === 0) return;
    
    isProcessing = true;
    
    while (messageQueue.length > 0) {
        // Find the first message that belongs to a user who is NOT rate-limited
        let msgIndex = -1;
        for (let i = 0; i < messageQueue.length; i++) {
            if (!isRateLimited(messageQueue[i].userId)) {
                msgIndex = i;
                break;
            }
        }

        // If all pending messages are from rate-limited users
        if (msgIndex === -1) {
            console.log(`â¸ï¸ All pending messages are from rate-limited users. Pausing queue for 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue; // Re-evaluate queue after waiting
        }

        // Extract the processable message from the queue
        const { msg, chat, userId, userName } = messageQueue.splice(msgIndex, 1)[0];
        
        try {
            // Random delay before processing (human-like)
            const delay = getRandomDelay(RATE_LIMIT.MIN_DELAY, RATE_LIMIT.MAX_DELAY);
            console.log(`â³ Processing queued message for ${userId} in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Process the message
            await handleMessage(msg, chat, userId, userName);
            
            // Update tracking AFTER processing
            updateUserTracking(userId);
            
        } catch (error) {
            console.error(`âŒ Error processing queued message:`, error.message);
        }
    }
    
    isProcessing = false;
}

// In-memory stores
const chatHistory = state.chatHistory;
const userNames = new Map();
const processedIncomingMessages = new Map();
const INCOMING_MESSAGE_DEDUPE_TTL = 10 * 60 * 1000;
let isScanningUnreadMessages = false;

function cleanupProcessedIncomingMessages(now = Date.now()) {
    for (const [msgId, seenAt] of processedIncomingMessages.entries()) {
        if (now - seenAt > INCOMING_MESSAGE_DEDUPE_TTL) {
            processedIncomingMessages.delete(msgId);
        }
    }
}

function getIncomingMessageId(msg) {
    return msg?.id?._serialized
        || `${msg?.from || 'unknown'}|${msg?.timestamp || Date.now()}|${msg?.type || 'text'}|${String(msg?.body || '').slice(0, 120)}`;
}

function isStatusBroadcastMessage(msg) {
    return msg?.from === 'status@broadcast' || msg?.to === 'status@broadcast';
}

function getMessagePreview(msg) {
    const text = String(msg?.body || '').trim();
    if (text) {
        return text.length > 80 ? `${text.slice(0, 80)}...` : text;
    }
    return `[${msg?.type || 'message'}]`;
}

function shouldIgnoreIncomingMessage(msg) {
    const body = String(msg?.body || '').trim();
    const ignoredTypes = new Set(['e2e_notification', 'notification_template', 'protocol', 'revoked']);
    if (ignoredTypes.has(msg?.type)) {
        return true;
    }
    return !body;
}

function rememberIncomingMessage(msg) {
    cleanupProcessedIncomingMessages();
    const msgId = getIncomingMessageId(msg);
    if (processedIncomingMessages.has(msgId)) {
        return false;
    }
    processedIncomingMessages.set(msgId, Date.now());
    return true;
}

function trackActiveUser(userId, userName) {
    const userInfo = state.activeUsers.get(userId) || { name: userName, msgCount: 0, lastSeen: null };
    userInfo.name = userName || userInfo.name;
    userInfo.msgCount = (userInfo.msgCount || 0) + 1;
    userInfo.lastSeen = new Date().toISOString();
    state.activeUsers.set(userId, userInfo);
    io.emit('users_update', Array.from(state.activeUsers.entries()).map(([id, u]) => ({ id, ...u })));
}

async function resolveUserName(msg, chat, userId) {
    if (userNames.has(userId)) {
        return userNames.get(userId);
    }

    try {
        const contact = await msg.getContact();
        let userName = contact.pushname || contact.name || contact.shortName || null;
        if (chat.isGroup && !userName) {
            userName = contact.pushname || contact.name || null;
        }
        if (userName && !userName.match(/^\+?\d+$/)) {
            userNames.set(userId, userName);
            console.log(`Cached contact name for ${userId}: ${userName}`);
            return userName;
        }
    } catch (_) {}

    return null;
}

async function queueIncomingMessage(msg, source = 'message', options = {}) {
    const { chat: existingChat = null, userName: existingUserName, startProcessing = true } = options;

    if (isStatusBroadcastMessage(msg) || msg.fromMe) {
        return false;
    }

    if (shouldIgnoreIncomingMessage(msg)) {
        console.log(`Ignored non-chat incoming event (${source}) from ${msg.from}: ${getMessagePreview(msg)}`);
        return false;
    }

    if (source === 'message_create' && msg.isNewMsg === false) {
        return false;
    }

    if (!state.autoReply) {
        console.log(`Incoming (${source}) from ${msg.from}: ${getMessagePreview(msg)}`);
        console.log(`Auto Reply OFF - incoming message captured but reply skipped for ${msg.from}`);
        return false;
    }

    if (!rememberIncomingMessage(msg)) {
        console.log(`Duplicate incoming message ignored (${source}) from ${msg.from}`);
        return false;
    }

    console.log(`Incoming (${source}) from ${msg.from}: ${getMessagePreview(msg)}`);

    if (state.activeCampaignId) {
        console.log(`Campaign ${state.activeCampaignId} active - continuing inbound handling for ${msg.from}`);
    }

    const chat = existingChat || await msg.getChat();
    const userId = msg.from;
    const userName = existingUserName === undefined
        ? await resolveUserName(msg, chat, userId)
        : existingUserName;

    messageQueue.push({ msg, chat, userId, userName });
    console.log(`Message queued from ${userId}. Queue length: ${messageQueue.length}`);

    trackActiveUser(userId, userName);

    if (startProcessing) {
        processMessageQueue();
    }

    return true;
}

async function processUnreadMessages(scanSource = 'manual') {
    if (!state.botClient || state.botStatus !== 'ready') {
        console.log(`Unread scan skipped (${scanSource}) - bot not ready.`);
        return {
            ok: false,
            reason: 'bot_not_ready',
            totalUnread: 0,
            queuedCount: 0,
            skippedCount: 0,
        };
    }

    if (!state.autoReply) {
        console.log(`Unread scan skipped (${scanSource}) - Auto Reply is OFF.`);
        return {
            ok: false,
            reason: 'auto_reply_off',
            totalUnread: 0,
            queuedCount: 0,
            skippedCount: 0,
        };
    }

    if (isScanningUnreadMessages) {
        console.log(`Unread scan skipped (${scanSource}) - another unread scan is already running.`);
        return {
            ok: false,
            reason: 'scan_in_progress',
            totalUnread: 0,
            queuedCount: 0,
            skippedCount: 0,
        };
    }

    isScanningUnreadMessages = true;

    try {
        const chats = await client.getChats();
        let totalUnread = 0;
        let queuedCount = 0;

        for (const chat of chats) {
            if (chat.unreadCount <= 0) continue;

            totalUnread += chat.unreadCount;
            console.log(`Found ${chat.unreadCount} unread in: ${chat.name || chat.id._serialized}`);

            const messages = await chat.fetchMessages({ limit: chat.unreadCount });

            for (const msg of messages) {
                if (msg.fromMe) continue;
                if (isStatusBroadcastMessage(msg)) continue;
                if (!msg.body || msg.body.trim() === '') continue;

                const msgIndex = messages.indexOf(msg);
                let hasReply = false;

                for (let i = msgIndex + 1; i < messages.length; i++) {
                    if (messages[i].fromMe) {
                        hasReply = true;
                        console.log(`Skipping unread message (already replied from other device): "${msg.body.substring(0, 30)}..."`);
                        break;
                    }
                }

                if (!hasReply) {
                    const didQueue = await queueIncomingMessage(msg, 'unread_scan', {
                        chat,
                        startProcessing: false,
                    });
                    if (didQueue) {
                        queuedCount++;
                    }
                }
            }

            await chat.sendSeen();
        }

        if (totalUnread === 0) {
            console.log(`No unread messages found during ${scanSource} scan.`);
        } else {
            console.log(`Unread scan (${scanSource}) found ${totalUnread} unread messages, queued ${queuedCount} for processing (${totalUnread - queuedCount} already replied or skipped).`);
        }

        if (messageQueue.length > 0) {
            processMessageQueue();
        }
        return {
            ok: true,
            reason: totalUnread === 0 ? 'no_unread' : 'scan_complete',
            totalUnread,
            queuedCount,
            skippedCount: Math.max(totalUnread - queuedCount, 0),
        };
    } catch (error) {
        console.error(`Error checking unread messages during ${scanSource} scan:`, error.message);
        return {
            ok: false,
            reason: 'scan_failed',
            error: error.message,
            totalUnread: 0,
            queuedCount: 0,
            skippedCount: 0,
        };
    } finally {
        isScanningUnreadMessages = false;
    }
}

// Setup WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "client-one", dataPath: "./whatsapp_session" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

const clientVerifier = new Client({
    authStrategy: new LocalAuth({ clientId: "client-verifier", dataPath: "./whatsapp_session_verifier" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

// Register bot control functions for dashboard
state.botInitFn    = () => client.initialize();
state.botDestroyFn = () => client.destroy();
state.botLogoutFn  = async () => {
    try { await client.logout(); } catch (_) {}
    try { await client.destroy(); } catch (_) {}
};
state.botClient    = null; // set after ready
state.processUnreadFn = (source = 'manual') => processUnreadMessages(source);

state.botVerifierInitFn    = () => clientVerifier.initialize();
state.botVerifierDestroyFn = () => clientVerifier.destroy();
state.botVerifierLogoutFn  = async () => {
    try { await clientVerifier.logout(); } catch (_) {}
    try { await clientVerifier.destroy(); } catch (_) {}
};
state.botVerifierClient    = null; // set after ready

// QR Code
client.on('qr', async (qr) => {
    console.log('Sender QR code generated. Scan it from the dashboard.');
    state.botStatus = 'qr';
    io.emit('status', 'qr');
    try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        state.qrCode = qrDataUrl;
        io.emit('qr', qrDataUrl);
    } catch (_) {}
});

clientVerifier.on('qr', async (qr) => {
    console.log('Verifier QR code generated. Scan it from the dashboard.');
    state.botVerifierStatus = 'qr';
    io.emit('status_verifier', 'qr');
    try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        state.verifierQrCode = qrDataUrl;
        io.emit('qr_verifier', qrDataUrl);
    } catch (_) {}
});

client.on('authenticated', () => {
    console.log('Sender authenticated via QR.');
    state.botStatus = 'starting';
    io.emit('status', 'starting');
});
clientVerifier.on('authenticated', () => {
    console.log('Verifier authenticated via QR.');
    state.botVerifierStatus = 'starting';
    io.emit('status_verifier', 'starting');
});

client.on('authenticated', () => {
    console.log('Sender authenticated via QR.');
    state.botStatus = 'starting';
    io.emit('status', 'starting');
});
clientVerifier.on('authenticated', () => {
    console.log('Verifier authenticated via QR.');
    state.botVerifierStatus = 'starting';
    io.emit('status_verifier', 'starting');
});

// Auth failure & disconnection
client.on('auth_failure', (msg) => { console.error('âŒ Sender Auth failed:', msg); state.botStatus = 'stopped'; io.emit('status', 'stopped'); });
client.on('disconnected', (reason) => {
    const reasonText = String(reason || '').toLowerCase();
    state.botClient = null;
    state.botStatus = 'stopped';
    io.emit('status', 'stopped');
    // For manual stop/logout, wait for explicit dashboard start.
    if (reasonText.includes('navigation') || reasonText.includes('logout')) {
        console.log('Sender Disconnected:', reason, '- Bot stopped. Use WhatsApp Connect to start again.');
        return;
    }
    console.log('Sender Disconnected:', reason, '- Reconnecting...');
    state.botStatus = 'starting';
    io.emit('status', 'starting');
    client.initialize();
});

clientVerifier.on('auth_failure', (msg) => { console.error('❌ Verifier Auth failed:', msg); state.botVerifierStatus = 'stopped'; io.emit('status_verifier', 'stopped'); });
clientVerifier.on('disconnected', (reason) => {
    const reasonText = String(reason || '').toLowerCase();
    state.botVerifierClient = null;
    state.botVerifierStatus = 'stopped';
    io.emit('status_verifier', 'stopped');
    if (reasonText.includes('navigation') || reasonText.includes('logout')) {
        console.log('Verifier Disconnected:', reason, '- Bot stopped. Use Connect Verifier to start again.');
        return;
    }
    console.log('Verifier Disconnected:', reason, '- Reconnecting...');
    state.botVerifierStatus = 'starting';
    io.emit('status_verifier', 'starting');
    clientVerifier.initialize();
});
// Client Ready - Process unread messages
client.on('ready', async () => {
    console.log('âœ… WhatsApp Sender is ready!');
    state.botStatus = 'ready';
    state.botClient = client;
    state.qrCode = null;
    io.emit('status', 'ready');

    if (!state.autoReply) {
        console.log('â¸ï¸ Auto Reply is OFF â€” skipping unread messages. Enable from dashboard.');
        return;
    }
    await processUnreadMessages('ready');
});

clientVerifier.on('ready', async () => {
    console.log('✅ WhatsApp Verifier is ready!');
    state.botVerifierStatus = 'ready';
    state.botVerifierClient = clientVerifier;
    state.verifierQrCode = null;
    io.emit('status_verifier', 'ready');
});

// Message Handling - Add to queue
client.on('message', async msg => {
    try {
        await queueIncomingMessage(msg, 'message');
    } catch (error) {
        console.error("Error queuing incoming message:", error.message);
    }
});

client.on('message_create', async msg => {
    try {
        await queueIncomingMessage(msg, 'message_create');
    } catch (error) {
        console.error("Error queuing message_create event:", error.message);
    }
});

// Actual message handler (called from queue)
async function handleMessage(msg, chat, userId, userName) {
    let typingInterval = null;

    try {
        // Guard: skip if last history entry is model (ghost trigger)
        const existingHistory = chatHistory.get(userId) || [];
        if (existingHistory.length > 0) {
            const lastRole = existingHistory[existingHistory.length - 1].role;
            if (lastRole === 'model') {
                const lastBotReply = existingHistory[existingHistory.length - 1]?.parts?.[0]?.text || '';
                if (msg.body.trim() === lastBotReply.trim()) {
                    console.log(`⏭ Ghost trigger detected for ${userId} - skipping`);
                    return;
                }
            }
        }

        const typingDelay = getRandomDelay(RATE_LIMIT.TYPING_MIN, RATE_LIMIT.TYPING_MAX);
        await chat.sendStateTyping();
        typingInterval = setInterval(() => { chat.sendStateTyping(); }, 5000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));

        if (!chatHistory.has(userId)) chatHistory.set(userId, []);
        let history = chatHistory.get(userId) || [];

        let cleanHistory = [...history];
        while (cleanHistory.length > 0 && cleanHistory[0].role !== 'user') cleanHistory.shift();
        while (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'model') cleanHistory.pop();
        const paired = [];
        for (let i = 0; i < cleanHistory.length - 1; i += 2) {
            if (cleanHistory[i].role === 'user' && cleanHistory[i + 1]?.role === 'model') {
                paired.push(cleanHistory[i], cleanHistory[i + 1]);
            }
        }
        cleanHistory = paired;

        // OpenAI Fallback
        async function runOpenAIChat() {
            console.log("⚠️ Switching to OpenAI...");
            let openAIHistory = cleanHistory;
            if (openAIHistory.length > 4) openAIHistory = openAIHistory.slice(-4);
            const sysText = buildGeminiSystemInstruction(userName).parts[0].text;
            const openAIMessages = [
                { role: "system", content: sysText },
                ...openAIHistory.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts[0].text })),
                { role: "user", content: msg.body }
            ];
            const openAITools = [{ type: "function", function: { name: "search_jobs", description: "Search for job openings.", parameters: { type: "object", properties: { location: { type: "string" }, query: { type: "string" }, industry: { type: "string" } }, required: ["location"] } } }];
            const completion = await openai.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages: openAIMessages, tools: openAITools, tool_choice: "auto" });
            let responseMessage = completion.choices[0].message;
            let text = responseMessage.content;
            if (responseMessage.tool_calls) {
                const toolCall = responseMessage.tool_calls[0];
                if (toolCall.function.name === "search_jobs") {
                    const args = JSON.parse(toolCall.function.arguments);
                    const apiResponse = await searchJobsFromApi(args.location, args.query || "", args.industry || "");
                    openAIMessages.push(responseMessage);
                    openAIMessages.push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: JSON.stringify(apiResponse) });
                    const secondResponse = await openai.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages: openAIMessages });
                    text = secondResponse.choices[0].message.content;
                }
            }
            logModelUsage(msg.from, 'OpenAI GPT-4o-mini', msg.body);
            return { text, newHistory: [...cleanHistory, { role: "user", parts: [{ text: msg.body }] }, { role: "model", parts: [{ text }] }] };
        }

        // Detect rate limit errors (429 / RESOURCE_EXHAUSTED)
        function isRateLimitError(err) {
            const m = (err.message || '').toLowerCase();
            return err.status === 429 || m.includes('429') || m.includes('resource_exhausted') || m.includes('quota') || m.includes('rate limit');
        }

        function isGoogleAuthScopeError(err) {
            const m = (err.message || '').toLowerCase();
            return m.includes('insufficient authentication scopes') || m.includes('permission_denied');
        }

        function hasValidGoogleOauthSession() {
            return isGoogleOauthSessionValid(state.aiAuth?.googleOauth);
        }

        // Gemini Chat with exponential backoff retry + fallback
        async function runChat(isRetry = false, retryCount = 0) {
            const modelName = getGeminiModelName(isRetry);
            const useGoogleOauth = state.aiAuth?.mode === 'google_oauth';
            const systemInstruction = buildGeminiSystemInstruction(userName);

            try {
                if (useGoogleOauth) {
                    if (!hasValidGoogleOauthSession()) {
                        throw new Error("Google OAuth Gemini mode is enabled, but the Google session is missing or expired. Please sign in again from the dashboard.");
                    }

                    const oauthResult = await runGeminiOAuthChat({
                        accessToken: state.aiAuth.googleOauth.accessToken,
                        projectId: state.aiAuth.googleOauth.projectId,
                        modelName,
                        cleanHistory,
                        userMessage: msg.body,
                        systemInstruction,
                        tools,
                        generationConfig: {
                            maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS) || 5000,
                        },
                        executeFunctionCall: async (call) => {
                            if (call.name === "search_jobs") {
                                return await searchJobsFromApi(
                                    call.args?.location,
                                    call.args?.query || "",
                                    call.args?.industry || "",
                                );
                            }
                            return { error: `Unsupported function: ${call.name}` };
                        },
                    });

                    logModelUsage(msg.from, `Gemini OAuth (${modelName})`, msg.body);
                    return oauthResult;
                }

                if (!genAI) {
                    throw new Error("GEMINI_API_KEY is not configured.");
                }

                const modelToUse = getModel(modelName, systemInstruction);
                const chatSession = modelToUse.startChat({ history: cleanHistory, generationConfig: { maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS) || 5000 } });
                let result = await chatSession.sendMessage(msg.body);
                let response = result.response; 
                const calls = response.functionCalls();
                if (calls && calls.length > 0) {
                    const call = calls[0];
                    if (call.name === "search_jobs") {
                        const apiResponse = await searchJobsFromApi(call.args.location, call.args.query || "", call.args.industry || "");
                        result = await chatSession.sendMessage([{ functionResponse: { name: "search_jobs", response: apiResponse } }]);
                        response = result.response;
                    }
                }
                logModelUsage(msg.from, `Gemini API Key (${modelName})`, msg.body);
                return { text: response.text(), newHistory: await chatSession.getHistory() };
            } catch (error) {
                // Exponential backoff on rate limit: 15s -> 30s -> 60s
                if (isRateLimitError(error) && retryCount < 3) {
                    const waitMs = [15000, 30000, 60000][retryCount];
                    addLog('warn', `⚠️ Rate limit hit (${modelName}). Retry ${retryCount + 1}/3 in ${waitMs/1000}s...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    return await runChat(isRetry, retryCount + 1);
                }
                if (!isRetry) {
                    addLog('warn', `Primary Gemini model failed (${modelName}): ${error.message}`);
                    addLog('warn', `Switching to Gemini fallback model (${getGeminiModelName(true)})...`);
                    return await runChat(true, 0);
                } else if (openai && state.aiAuth?.mode !== 'google_oauth') {
                    addLog('warn', 'Switching to OpenAI fallback...');
                    return await runOpenAIChat();
                }
                throw error;
            }
        }

        // Execute: Gemini 2.5 -> Gemini 2.0 -> OpenAI
        let text, newHistory;
        try {
            const result = await runChat(false, 0);
            text = result.text;
            newHistory = result.newHistory;
        } catch (err) {
            if (isGoogleAuthScopeError(err)) {
                addLog('error', 'Google OAuth token is missing required Gemini scopes. Re-login from dashboard after updating OAuth consent screen scopes.');
                text = "Bot permissions update ho rahi hain. Kripya thodi der baad message karein.";
                newHistory = history;
            } else {
                addLog('error', `All AI models failed for ${userId}: ${err.message}`);
                text = "We're experiencing a brief technical issue. Please try again in a moment. Thank you for your patience!";
                newHistory = history;
            }
        }

        // Sanitize & save history
        let simplifiedHistory = [];
        for (const m of newHistory) {
            if ((m.role === 'user' || m.role === 'model') && m.parts) {
                let isFn = false;
                for (const p of m.parts) { if (p.functionCall || p.functionResponse) { isFn = true; break; } }
                if (!isFn && m.parts.length > 0) simplifiedHistory.push(m);
            }
        }
        let finalHistory = [];
        for (const m of simplifiedHistory) {
            if (finalHistory.length === 0) { if (m.role === 'user') finalHistory.push(m); }
            else {
                const lastRole = finalHistory[finalHistory.length - 1].role;
                if (lastRole !== m.role) finalHistory.push(m);
                else finalHistory[finalHistory.length - 1] = m;
            }
        }
        if (finalHistory.length > 0 && finalHistory[finalHistory.length - 1].role === 'user') finalHistory.pop();

        const maxH = parseInt(process.env.MAX_HISTORY) || 6;
        if (finalHistory.length > maxH) {
            finalHistory = finalHistory.slice(-maxH);
            while (finalHistory.length > 0 && finalHistory[0].role !== 'user') finalHistory.shift();
        }
        chatHistory.set(userId, finalHistory);
        state.chatHistory.set(userId, finalHistory);
        io.emit('history_update', { userId, history: finalHistory });

        if (typingInterval) clearInterval(typingInterval);
        await chat.clearState();
        if (text && text.trim()) {
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 1500)));
            await msg.reply(text);
            addLog('success', `✅ Reply sent to ${userId}: ${text.substring(0, 80)}`);
        }

    } catch (error) {
        if (typingInterval) clearInterval(typingInterval);
        console.error("❌ Error:", error.message);
        try { await new Promise(resolve => setTimeout(resolve, 1000)); await msg.reply("We're experiencing a brief technical issue. Please try again in a moment. Thank you for your patience! 🙏"); } catch (e) {}
    }
}

// Keep bot idle on program start. Connect from dashboard button when needed.
state.botStatus = 'stopped';
io.emit('status', 'stopped');
state.botVerifierStatus = 'stopped';
io.emit('status_verifier', 'stopped');

return {
    client,
    clientVerifier,
    shutdown: async () => {
        try { await client.destroy(); } catch (_) {}
        try { await clientVerifier.destroy(); } catch (_) {}
    }
};
};
