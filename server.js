const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const {
  createInitialState,
  createEmptyMessageStats,
} = require("./src/models/app-state.model");
const registerRoutes = require("./src/routes");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static("public"));

const state = createInitialState();

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
    stats.api = (stats.api || 0) + 1;
  }
}

state.recordAiUsageStats = (modelName, timestamp = new Date().toISOString()) => {
  applyUsageStats(state.messageStats, modelName, timestamp);
  io.emit("stats", state.messageStats);
};

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

function recordModelCallUsage(modelName, source = "system") {
  const timestamp = new Date().toISOString();
  const model = String(modelName || "").trim() || "unknown-model";
  const actor = String(source || "system").trim() || "system";
  const logEntry = `[${timestamp}] User: ${actor} | Model: ${model} | Msg: "__ai_call__"\n`;
  fs.appendFile("bot_usage.log", logEntry, () => {});
  state.recordAiUsageStats(model, timestamp);
}

function buildSocketInitPayload() {
  return {
    botStatus: state.botStatus,
    stats: state.messageStats,
    emailStats: state.emailStats,
    logs: state.logs.slice(-100),
    activeUsers: Array.from(state.activeUsers.entries()).map(([id, user]) => ({
      id,
      ...user,
    })),
    qrCode: state.qrCode,
  };
}

loadUsageLogs();

registerRoutes({
  app,
  io,
  state,
  addLog,
  path,
  fs,
  recordModelCallUsage,
});

io.on("connection", (socket) => {
  socket.emit("init", buildSocketInitPayload());
});

module.exports = {
  app,
  io,
  state,
  addLog,
  server,
  recordModelCallUsage,
};
