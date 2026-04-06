const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  getGoogleOauthPublicState,
  isGoogleOauthSessionValid,
} = require("./src/services/gemini-oauth.service");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage() });
const RUNTIME_STATE_PATH = path.join(process.cwd(), "data", "runtime_state.json");

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static("public"));

function getDefaultGeminiAuthMode() {
  return process.env.GEMINI_AUTH_MODE === "google_oauth"
    ? "google_oauth"
    : "api_key";
}

function createEmptyGoogleOauthSession(projectId = "") {
  return {
    accessToken: "",
    expiresAt: 0,
    email: "",
    name: "",
    picture: "",
    grantedScope: "",
    projectId: String(
      projectId || process.env.GOOGLE_OAUTH_PROJECT_ID || "",
    ).trim(),
  };
}

function sanitizeGoogleOauthSession(session = {}) {
  return {
    ...createEmptyGoogleOauthSession(session?.projectId),
    accessToken: String(session?.accessToken || "").trim(),
    expiresAt: Number(session?.expiresAt || 0),
    email: String(session?.email || "").trim(),
    name: String(session?.name || "").trim(),
    picture: String(session?.picture || "").trim(),
    grantedScope: String(session?.grantedScope || "").trim(),
    projectId: String(
      session?.projectId || process.env.GOOGLE_OAUTH_PROJECT_ID || "",
    ).trim(),
  };
}

function loadRuntimeState() {
  try {
    const raw = fs.readFileSync(RUNTIME_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const persistedGoogleOauth = sanitizeGoogleOauthSession(
      parsed?.aiAuth?.googleOauth,
    );
    const hasValidGoogleOauth = isGoogleOauthSessionValid(persistedGoogleOauth);
    const persistedMode =
      parsed?.aiAuth?.mode === "google_oauth"
        ? "google_oauth"
        : parsed?.aiAuth?.mode === "api_key"
          ? "api_key"
          : getDefaultGeminiAuthMode();

    return {
      autoReply: !!parsed.autoReply,
      aiAuth: {
        mode:
          persistedMode === "google_oauth" && hasValidGoogleOauth
            ? "google_oauth"
            : "api_key",
        googleOauth: hasValidGoogleOauth
          ? persistedGoogleOauth
          : createEmptyGoogleOauthSession(persistedGoogleOauth.projectId),
      },
    };
  } catch (_) {
    return {
      autoReply: false,
      aiAuth: {
        mode: "api_key",
        googleOauth: createEmptyGoogleOauthSession(),
      },
    };
  }
}

function saveRuntimeState(runtimeState = {}) {
  try {
    const googleOauth = sanitizeGoogleOauthSession(
      runtimeState?.aiAuth?.googleOauth,
    );
    const hasValidGoogleOauth = isGoogleOauthSessionValid(googleOauth);

    fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      RUNTIME_STATE_PATH,
      JSON.stringify(
        {
          autoReply: !!runtimeState.autoReply,
          aiAuth: {
            mode:
              runtimeState?.aiAuth?.mode === "google_oauth" && hasValidGoogleOauth
                ? "google_oauth"
                : "api_key",
            googleOauth: hasValidGoogleOauth
              ? googleOauth
              : createEmptyGoogleOauthSession(googleOauth.projectId),
          },
        },
        null,
        2,
      ),
    );
  } catch (_) {}
}

const persistedRuntimeState = loadRuntimeState();

function getInitialGeminiAuthMode() {
  return persistedRuntimeState?.aiAuth?.mode === "google_oauth"
    ? "google_oauth"
    : "api_key";
}

function createEmptyMessageStats() {
  return {
    total: 0,
    today: 0,
    gemini: 0,
    openai: 0,
    api: 0,
    googleOauth: 0,
  };
}

function applyUsageStats(stats, modelName, timestamp = "") {
  const model = String(modelName || "").trim();
  const lower = model.toLowerCase();
  const isoTime = String(timestamp || "");

  stats.total = (stats.total || 0) + 1;
  if (isoTime.startsWith(new Date().toISOString().slice(0, 10))) {
    stats.today = (stats.today || 0) + 1;
  }
  if (lower.includes("gemini")) {
    stats.gemini = (stats.gemini || 0) + 1;
  }
  if (lower.includes("openai")) {
    stats.openai = (stats.openai || 0) + 1;
  }

  const isGoogleOauth =
    lower.includes("oauth") || lower.includes("google login");
  const isApiBacked = lower.includes("gemini") || lower.includes("openai");
  if (isGoogleOauth) {
    stats.googleOauth = (stats.googleOauth || 0) + 1;
  } else if (isApiBacked) {
    stats.api = (stats.api || 0) + 1;
  }
}

// --- Shared State ---
const state = {
  botStatus: "stopped",
  qrCode: null,
  logs: [],
  chatHistory: new Map(),
  messageStats: createEmptyMessageStats(),
  emailStats: {
    totalSent: 0,
    totalFailed: 0,
    todaySent: 0,
    todayFailed: 0,
    accountsConfigured: 0,
    accountsAtLimit: 0,
    activeAccount: "-",
    dailyLimit: 0,
    remainingToday: 0,
  },
  activeUsers: new Map(),
  botClient: null,
  botInitFn: null,
  botDestroyFn: null,
  activeCampaignId: null,
  campaignRecipients: new Set(),
  autoReply: persistedRuntimeState.autoReply,
  aiAuth: {
    mode: getInitialGeminiAuthMode(),
    googleOauth: sanitizeGoogleOauthSession(
      persistedRuntimeState?.aiAuth?.googleOauth,
    ),
  },
};

state.persistRuntimeState = () => saveRuntimeState(state);
state.getAiAuthStatus = () => getGoogleOauthPublicState(state);
state.recordAiUsageStats = (modelName, timestamp = new Date().toISOString()) => {
  applyUsageStats(state.messageStats, modelName, timestamp);
  io.emit("stats", state.messageStats);
};

// --- Log Helper ---
function normalizeLogText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .trim();
}

function addLog(level, message) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message: normalizeLogText(message),
  };
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  io.emit("log", entry);
}

if (isGoogleOauthSessionValid(state.aiAuth.googleOauth)) {
  addLog(
    "info",
    `Restored Google OAuth session${state.aiAuth.googleOauth.email ? ` for ${state.aiAuth.googleOauth.email}` : ""}.`,
  );
}

// --- Load usage stats on startup ---
function loadUsageLogs() {
  try {
    const raw = fs.readFileSync("bot_usage.log", "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    Object.assign(state.messageStats, createEmptyMessageStats());
    lines.forEach((line) => {
      const timeMatch = line.match(/^\[([^\]]+)\]/);
      const modelMatch = line.match(/\|\s*Model:\s*(.*?)\s*\|\s*Msg:/);
      applyUsageStats(
        state.messageStats,
        modelMatch ? modelMatch[1] : line,
        timeMatch ? timeMatch[1] : "",
      );
    });
  } catch (_) {}
}
loadUsageLogs();

function recordModelCallUsage(modelName, source = "system") {
  const timestamp = new Date().toISOString();
  const model = String(modelName || "").trim() || "unknown-model";
  const actor = String(source || "system").trim() || "system";
  const logEntry = `[${timestamp}] User: ${actor} | Model: ${model} | Msg: "__ai_call__"\n`;
  fs.appendFile("bot_usage.log", logEntry, () => {});
  state.recordAiUsageStats(model, timestamp);
}


// --- Modular Routes ---
require('./src/routes/bot.routes')(app, io, state, addLog, path, fs);
require('./src/routes/config.routes')(app, io, state, addLog, path, fs);
require('./src/routes/campaign.routes')(
  app,
  io,
  state,
  addLog,
  path,
  fs,
  recordModelCallUsage,
);
require('./src/routes/email.routes')(app, io, state, addLog, path, fs);
// --- Socket.IO ---
io.on("connection", (socket) => {
  socket.emit("init", {
    botStatus: state.botStatus,
    stats: state.messageStats,
    emailStats: state.emailStats,
    logs: state.logs.slice(-100),
    activeUsers: Array.from(state.activeUsers.entries()).map(([id, u]) => ({
      id,
      ...u,
    })),
    qrCode: state.qrCode,
    autoReply: state.autoReply,
    aiAuth: state.getAiAuthStatus(),
  });
});



module.exports = { io, state, addLog, server };
