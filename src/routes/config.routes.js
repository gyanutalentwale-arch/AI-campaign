const {
  extractTextFromContent,
  fetchGoogleUserProfile,
  generateContentWithGoogleOauth,
  isGoogleOauthSessionValid,
} = require("../services/gemini-oauth.service");

module.exports = function(app, io, state, addLog, path, fs) {
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

// --- Stats and Logs ---
app.get("/api/stats", (req, res) => {
  if (typeof refreshEmailStats === "function") refreshEmailStats(false);
  res.json({
    botStatus: state.botStatus,
    stats: state.messageStats,
    emailStats: state.emailStats,
    activeUsers: Array.from(state.activeUsers.entries()).map(([id, u]) => ({
      id,
      ...u,
    })),
    qrCode: state.qrCode,
    autoReply: state.autoReply,
    aiAuth: typeof state.getAiAuthStatus === "function" ? state.getAiAuthStatus() : null,
  });
});

app.get("/api/logs", (req, res) => {
  res.json(state.logs.slice(-(parseInt(req.query.limit) || 100)));
});

app.get("/api/usage-log", (req, res) => {
  try {
    res.json({ log: fs.readFileSync("bot_usage.log", "utf8") });
  } catch (_) {
    res.json({ log: "" });
  }
});

// --- Chat History ---
app.get("/api/users", (req, res) => {
  res.json(
    Array.from(state.activeUsers.entries()).map(([id, u]) => ({ id, ...u })),
  );
});

app.get("/api/history/:userId", (req, res) => {
  res.json({ history: state.chatHistory.get(req.params.userId) || [] });
});

app.delete("/api/history/:userId", (req, res) => {
  state.chatHistory.delete(req.params.userId);
  io.emit("history_cleared", req.params.userId);
  addLog("info", `History cleared for ${req.params.userId}`);
  res.json({ ok: true });
});

// --- Prompt File API ---
const ALLOWED_PROMPT_FILES = [
  "system_prompt.txt",
  "links.json",
  "industries.json",
];

app.get("/api/prompt-file", (req, res) => {
  const file = req.query.file;
  if (!ALLOWED_PROMPT_FILES.includes(file))
    return res.status(403).json({ error: "Not allowed" });
  try {
    const fullPath = file.startsWith("..")
      ? path.join(process.cwd(), file)
      : path.join(process.cwd(), "prompts", file);
    res.json({ data: fs.readFileSync(fullPath, "utf8") });
  } catch (_) {
    res.json({ data: "" });
  }
});

app.post("/api/prompt-file", (req, res) => {
  const { file, data } = req.body;
  if (!ALLOWED_PROMPT_FILES.includes(file))
    return res.status(403).json({ error: "Not allowed" });
  try {
    const fullPath = file.startsWith("..")
      ? path.join(process.cwd(), file)
      : path.join(process.cwd(), "prompts", file);
    fs.writeFileSync(fullPath, data || "");
    addLog("info", `Prompt updated: ${file}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- .env Config API ---
app.get("/api/config", (req, res) => {
  try {
    const lines = fs
      .readFileSync(".env", "utf8")
      .split("\n")
      .map((line) => {
        if (!line.includes("=")) return null;
        const [key, ...rest] = line.split("=");
        const value = rest.join("=");
        const isSensitive = /KEY|SECRET|TOKEN/i.test(key);
        return { key: key.trim(), value: value.trim(), masked: isSensitive };
      })
      .filter(Boolean);
    res.json({ lines });
  } catch (_) {
    res.json({ lines: [] });
  }
});

app.post("/api/config", (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "key required" });
  try {
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
    if (!found) updated.push(`${key}=${value}`);
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ai-auth/status", (req, res) => {
  res.json(typeof state.getAiAuthStatus === "function" ? state.getAiAuthStatus() : {});
});

app.post("/api/ai-auth/mode", (req, res) => {
  const mode = req.body?.mode === "google_oauth" ? "google_oauth" : "api_key";

  if (mode === "google_oauth" && !isGoogleOauthSessionValid(state.aiAuth.googleOauth)) {
    return res.status(400).json({
      error: "Sign in with Google first before enabling Google OAuth mode.",
    });
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
  res.json(typeof state.getAiAuthStatus === "function" ? state.getAiAuthStatus() : {});
});

app.post("/api/ai-auth/google-session", async (req, res) => {
  const accessToken = String(req.body?.accessToken || "").trim();
  const expiresAt = Number(req.body?.expiresAt || 0);
  const grantedScope = String(req.body?.grantedScope || "").trim();
  const projectId = String(
    req.body?.projectId
      || state.aiAuth.googleOauth.projectId
      || process.env.GOOGLE_OAUTH_PROJECT_ID
      || "",
  ).trim();

  if (!accessToken) {
    return res.status(400).json({ error: "accessToken is required" });
  }
  if (!projectId) {
    return res.status(400).json({
      error: "GOOGLE_OAUTH_PROJECT_ID is required before testing Google OAuth mode.",
    });
  }

  try {
    const profile = await fetchGoogleUserProfile(accessToken);
    state.aiAuth.googleOauth = {
      accessToken,
      expiresAt: expiresAt || Date.now() + 55 * 60 * 1000,
      email: profile.email || "",
      name: profile.name || "",
      picture: profile.picture || "",
      grantedScope,
      projectId,
    };
    state.aiAuth.mode = "google_oauth";
    process.env.GEMINI_AUTH_MODE = "google_oauth";

    addLog(
      "success",
      `Google OAuth connected${profile.email ? ` as ${profile.email}` : ""}.`,
    );
    persistRuntimeState();
    emitAiAuthStatus();
    res.json(typeof state.getAiAuthStatus === "function" ? state.getAiAuthStatus() : {});
  } catch (error) {
    addLog("error", `Google OAuth sign-in failed: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/ai-auth/google-session", (req, res) => {
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
  res.json(typeof state.getAiAuthStatus === "function" ? state.getAiAuthStatus() : {});
});

app.post("/api/ai-auth/test", async (req, res) => {
  if (!isGoogleOauthSessionValid(state.aiAuth.googleOauth)) {
    return res.status(400).json({
      error: "Google OAuth session is missing or expired. Sign in again first.",
    });
  }

  const model = String(req.body?.model || process.env.PRIMARY_MODEL || "gemini-2.5-flash").trim();
  const prompt = String(
    req.body?.prompt ||
      "Reply with one short line confirming that Google OAuth Gemini is working.",
  ).trim();

  try {
    const response = await generateContentWithGoogleOauth({
      accessToken: state.aiAuth.googleOauth.accessToken,
      projectId: state.aiAuth.googleOauth.projectId,
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: "Reply in plain text only." }] },
      generationConfig: {
        maxOutputTokens: 120,
      },
    });

    const text = extractTextFromContent(response?.candidates?.[0]?.content);
    if (!text) {
      throw new Error("Gemini test completed but no text response was returned.");
    }

    addLog("success", `Google OAuth Gemini test passed on ${model}.`);
    res.json({ ok: true, model, text });
  } catch (error) {
    addLog("error", `Google OAuth Gemini test failed: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});


// --- Auto Reply Toggle ---
app.get("/api/autoreply", (req, res) => res.json({ enabled: state.autoReply }));

app.post("/api/autoreply", (req, res) => {
  const wasEnabled = !!state.autoReply;
  state.autoReply = !!req.body.enabled;
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
        addLog("error", `Unread scan failed after enabling Auto Reply: ${error.message}`);
      });
  }

  res.json({ enabled: state.autoReply });
});

// --- Group Export ---
// List all groups bot is in
app.get("/api/groups", async (req, res) => {
  if (!state.botClient)
    return res.status(400).json({ error: "Bot not connected" });
  try {
    const chats = await state.botClient.getChats();
    const groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({
        id: c.id._serialized,
        name: c.name,
        participants: c.participants?.length || 0,
      }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export group participants as CSV
app.get("/api/groups/:groupId/export", async (req, res) => {
  if (!state.botClient)
    return res.status(400).json({ error: "Bot not connected" });
  try {
    const chat = await state.botClient.getChatById(req.params.groupId);
    if (!chat || !chat.isGroup)
      return res.status(404).json({ error: "Group not found" });

    const rows = chat.participants.map((p) => ({ number: p.id.user }));

    const csv = ["number", ...rows.map((r) => `"${r.number}"`)].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${chat.name.replace(/[^a-z0-9]/gi, "_")}_contacts.csv"`,
    );
    res.send("\uFEFF" + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


};
