const {
  extractTextFromContent,
  fetchGoogleUserProfile,
  generateContentWithGoogleOauth,
  isGoogleOauthSessionValid,
} = require("./gemini-oauth.service");

const ALLOWED_PROMPT_FILES = [
  "system_prompt.txt",
  "links.json",
  "industries.json",
];

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = function createConfigService({
  io,
  state,
  addLog,
  path,
  fs,
}) {
  function emitAiAuthStatus() {
    if (typeof state.getAiAuthStatus === "function") {
      io.emit("ai_auth_status", state.getAiAuthStatus());
    }
  }

  function persistRuntimeState() {
    if (typeof state.persistRuntimeState === "function") {
      state.persistRuntimeState();
    }
  }

  function getStats() {
    return {
      botStatus: state.botStatus,
      stats: state.messageStats,
      emailStats: state.emailStats,
      activeUsers: Array.from(state.activeUsers.entries()).map(([id, user]) => ({
        id,
        ...user,
      })),
      qrCode: state.qrCode,
      autoReply: state.autoReply,
      aiAuth:
        typeof state.getAiAuthStatus === "function"
          ? state.getAiAuthStatus()
          : null,
    };
  }

  function getLogs(limit = 100) {
    return state.logs.slice(-Math.max(parseInt(limit, 10) || 100, 1));
  }

  function getUsageLog() {
    try {
      return fs.readFileSync("bot_usage.log", "utf8");
    } catch (_) {
      return "";
    }
  }

  function getUsers() {
    return Array.from(state.activeUsers.entries()).map(([id, user]) => ({
      id,
      ...user,
    }));
  }

  function getHistory(userId) {
    return state.chatHistory.get(userId) || [];
  }

  function clearHistory(userId) {
    state.chatHistory.delete(userId);
    io.emit("history_cleared", userId);
    addLog("info", `History cleared for ${userId}`);
    return { ok: true };
  }

  function resolvePromptFilePath(file) {
    if (!ALLOWED_PROMPT_FILES.includes(file)) {
      throw createHttpError(403, "Not allowed");
    }

    return file.startsWith("..")
      ? path.join(process.cwd(), file)
      : path.join(process.cwd(), "prompts", file);
  }

  function getPromptFile(file) {
    const fullPath = resolvePromptFilePath(file);
    try {
      return fs.readFileSync(fullPath, "utf8");
    } catch (_) {
      return "";
    }
  }

  function savePromptFile(file, data) {
    const fullPath = resolvePromptFilePath(file);
    fs.writeFileSync(fullPath, data || "");
    addLog("info", `Prompt updated: ${file}`);
    return { ok: true };
  }

  function getConfigLines() {
    try {
      return fs
        .readFileSync(".env", "utf8")
        .split("\n")
        .map((line) => {
          if (!line.includes("=")) return null;
          const [key, ...rest] = line.split("=");
          const value = rest.join("=");
          return {
            key: key.trim(),
            value: value.trim(),
            masked: /KEY|SECRET|TOKEN/i.test(key),
          };
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function updateConfig(key, value) {
    if (!key) {
      throw createHttpError(400, "key required");
    }

    let raw = "";
    try {
      raw = fs.readFileSync(".env", "utf8");
    } catch (_) {}

    let found = false;
    const updated = raw.split("\n").map((line) => {
      if (line.startsWith(key + "=")) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });

    if (!found) {
      updated.push(`${key}=${value}`);
    }

    fs.writeFileSync(".env", updated.join("\n"));
    process.env[key] = value;

    if (key === "GEMINI_AUTH_MODE") {
      state.aiAuth.mode = value === "google_oauth" ? "google_oauth" : "api_key";
    }
    if (key === "GOOGLE_OAUTH_PROJECT_ID") {
      state.aiAuth.googleOauth.projectId = String(value || "").trim();
    }

    addLog("info", `Config updated: ${key}`);
    persistRuntimeState();
    emitAiAuthStatus();
    return { ok: true };
  }

  function getAiAuthStatus() {
    return typeof state.getAiAuthStatus === "function"
      ? state.getAiAuthStatus()
      : {};
  }

  function setAiAuthMode(modeInput) {
    const mode = modeInput === "google_oauth" ? "google_oauth" : "api_key";

    if (
      mode === "google_oauth" &&
      !isGoogleOauthSessionValid(state.aiAuth.googleOauth)
    ) {
      throw createHttpError(
        400,
        "Sign in with Google first before enabling Google OAuth mode.",
      );
    }

    state.aiAuth.mode = mode;
    process.env.GEMINI_AUTH_MODE = mode;
    addLog(
      "info",
      mode === "google_oauth"
        ? "Gemini auth mode switched to Google OAuth."
        : "Gemini auth mode switched to API key.",
    );
    persistRuntimeState();
    emitAiAuthStatus();
    return getAiAuthStatus();
  }

  async function saveGoogleSession({
    accessToken,
    expiresAt,
    grantedScope,
    projectId,
  }) {
    const token = String(accessToken || "").trim();
    const resolvedProjectId = String(
      projectId ||
        state.aiAuth.googleOauth.projectId ||
        process.env.GOOGLE_OAUTH_PROJECT_ID ||
        "",
    ).trim();

    if (!token) {
      throw createHttpError(400, "accessToken is required");
    }
    if (!resolvedProjectId) {
      throw createHttpError(
        400,
        "GOOGLE_OAUTH_PROJECT_ID is required before testing Google OAuth mode.",
      );
    }

    try {
      const profile = await fetchGoogleUserProfile(token);
      state.aiAuth.googleOauth = {
        accessToken: token,
        expiresAt: Number(expiresAt) || Date.now() + 55 * 60 * 1000,
        email: profile.email || "",
        name: profile.name || "",
        picture: profile.picture || "",
        grantedScope: String(grantedScope || "").trim(),
        projectId: resolvedProjectId,
      };
      state.aiAuth.mode = "google_oauth";
      process.env.GEMINI_AUTH_MODE = "google_oauth";

      addLog(
        "success",
        `Google OAuth connected${profile.email ? ` as ${profile.email}` : ""}.`,
      );
      persistRuntimeState();
      emitAiAuthStatus();
      return getAiAuthStatus();
    } catch (error) {
      addLog("error", `Google OAuth sign-in failed: ${error.message}`);
      throw createHttpError(400, error.message);
    }
  }

  function clearGoogleSession() {
    state.aiAuth.googleOauth = {
      accessToken: "",
      expiresAt: 0,
      email: "",
      name: "",
      picture: "",
      grantedScope: "",
      projectId: process.env.GOOGLE_OAUTH_PROJECT_ID || "",
    };
    state.aiAuth.mode = "api_key";
    process.env.GEMINI_AUTH_MODE = "api_key";
    addLog("info", "Google OAuth session removed. Gemini auth reverted to API key.");
    persistRuntimeState();
    emitAiAuthStatus();
    return getAiAuthStatus();
  }

  async function testGoogleOauth({ model, prompt } = {}) {
    if (!isGoogleOauthSessionValid(state.aiAuth.googleOauth)) {
      throw createHttpError(
        400,
        "Google OAuth session is missing or expired. Sign in again first.",
      );
    }

    const resolvedModel = String(
      model || process.env.PRIMARY_MODEL || "gemini-2.5-flash",
    ).trim();
    const resolvedPrompt = String(
      prompt ||
        "Reply with one short line confirming that Google OAuth Gemini is working.",
    ).trim();

    try {
      const response = await generateContentWithGoogleOauth({
        accessToken: state.aiAuth.googleOauth.accessToken,
        projectId: state.aiAuth.googleOauth.projectId,
        model: resolvedModel,
        contents: [{ role: "user", parts: [{ text: resolvedPrompt }] }],
        systemInstruction: { parts: [{ text: "Reply in plain text only." }] },
        generationConfig: { maxOutputTokens: 120 },
      });

      const text = extractTextFromContent(response?.candidates?.[0]?.content);
      if (!text) {
        throw new Error(
          "Gemini test completed but no text response was returned.",
        );
      }

      addLog("success", `Google OAuth Gemini test passed on ${resolvedModel}.`);
      return { ok: true, model: resolvedModel, text };
    } catch (error) {
      addLog("error", `Google OAuth Gemini test failed: ${error.message}`);
      throw createHttpError(400, error.message);
    }
  }

  async function setAutoReply(enabled) {
    const wasEnabled = !!state.autoReply;
    state.autoReply = !!enabled;
    persistRuntimeState();
    addLog("info", `Auto Reply ${state.autoReply ? "Enabled" : "Disabled"}`);
    io.emit("autoreply", state.autoReply);

    if (
      state.autoReply &&
      !wasEnabled &&
      state.botStatus === "ready" &&
      typeof state.processUnreadFn === "function"
    ) {
      addLog("info", "Auto Reply enabled - scanning unread WhatsApp messages...");
      Promise.resolve()
        .then(() => state.processUnreadFn("toggle_on"))
        .catch((error) => {
          addLog(
            "error",
            `Unread scan failed after enabling Auto Reply: ${error.message}`,
          );
        });
    }

    return { enabled: state.autoReply };
  }

  async function listGroups() {
    if (!state.botClient) {
      throw createHttpError(400, "Bot not connected");
    }

    const chats = await state.botClient.getChats();
    return {
      groups: chats
        .filter((chat) => chat.isGroup)
        .map((chat) => ({
          id: chat.id._serialized,
          name: chat.name,
          participants: chat.participants?.length || 0,
        })),
    };
  }

  async function exportGroupCsv(groupId) {
    if (!state.botClient) {
      throw createHttpError(400, "Bot not connected");
    }

    const chat = await state.botClient.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      throw createHttpError(404, "Group not found");
    }

    const rows = chat.participants.map((participant) => ({
      number: participant.id.user,
    }));
    const csv = ["number", ...rows.map((row) => `"${row.number}"`)].join("\n");

    return {
      filename: `${chat.name.replace(/[^a-z0-9]/gi, "_")}_contacts.csv`,
      csv,
    };
  }

  return {
    clearGoogleSession,
    clearHistory,
    exportGroupCsv,
    getAiAuthStatus,
    getAutoReply: () => ({ enabled: state.autoReply }),
    getConfigLines,
    getHistory,
    getLogs,
    getPromptFile,
    getStats,
    getUsageLog,
    getUsers,
    listGroups,
    saveGoogleSession,
    savePromptFile,
    setAiAuthMode,
    setAutoReply,
    testGoogleOauth,
    updateConfig,
  };
};
