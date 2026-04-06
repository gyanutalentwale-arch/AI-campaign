module.exports = function(app, io, state, addLog, path, fs) {
// --- Bot Control API ---
app.post("/api/bot/start", async (req, res) => {
  if (state.botStatus !== "stopped")
    return res.json({ ok: false, msg: "Bot already running" });
  if (!state.botInitFn)
    return res.status(500).json({ ok: false, msg: "Bot not ready" });
  try {
    state.botStatus = "starting";
    io.emit("status", "starting");
    addLog("info", "Bot starting...");
    state.botInitFn();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.post("/api/bot/stop", async (req, res) => {
  if (!state.botDestroyFn)
    return res.status(500).json({ ok: false, msg: "Bot not ready" });
  try {
    addLog("info", "Bot stopping...");
    await state.botDestroyFn();
    state.botStatus = "stopped";
    io.emit("status", "stopped");
    res.json({ ok: true });
  } catch (e) {
    state.botStatus = "stopped";
    io.emit("status", "stopped");
    res.json({ ok: true });
  }
});

app.post("/api/bot/restart", async (req, res) => {
  if (!state.botDestroyFn || !state.botInitFn)
    return res.status(500).json({ ok: false, msg: "Bot not ready" });
  try {
    addLog("info", "Bot restarting...");
    try {
      await state.botDestroyFn();
    } catch (_) {}
    state.botStatus = "starting";
    io.emit("status", "starting");
    setTimeout(() => {
      state.botInitFn();
    }, 2000);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.post("/api/bot/logout", async (req, res) => {
  try {
    addLog("info", "Logging out WhatsApp session...");
    // Logout clears the session; next initialize() will show QR
    if (state.botClient) {
      try {
        await state.botClient.logout();
      } catch (_) {}
      try {
        await state.botClient.destroy();
      } catch (_) {}
    }
    // Delete saved session folder so fresh QR is shown
    const sessionPath = path.join(process.cwd(), "whatsapp_session", "Default");
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(path.join(process.cwd(), "whatsapp_session"), {
        recursive: true,
        force: true,
      });
      addLog("info", "Session data cleared");
    }
    state.botStatus = "stopped";
    state.qrCode = null;
    io.emit("status", "stopped");
    res.json({
      ok: true,
      msg: "Logged out. Click WhatsApp Connect to scan QR again.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.post("/api/bot/scan-unread", async (req, res) => {
  if (typeof state.processUnreadFn !== "function") {
    return res.status(500).json({
      ok: false,
      msg: "Unread scanner is not available right now.",
    });
  }

  try {
    addLog("info", "Manual unread scan requested from dashboard.");
    const result = await state.processUnreadFn("dashboard_button");

    if (!result?.ok) {
      const reason = result?.reason;
      if (reason === "bot_not_ready") {
        return res.status(400).json({
          ok: false,
          msg: "WhatsApp bot not ready. Connect WhatsApp first.",
          ...result,
        });
      }
      if (reason === "auto_reply_off") {
        return res.status(400).json({
          ok: false,
          msg: "Auto Reply is OFF. Enable it first, then scan unread messages.",
          ...result,
        });
      }
      if (reason === "scan_in_progress") {
        return res.status(409).json({
          ok: false,
          msg: "Unread scan is already running.",
          ...result,
        });
      }
      return res.status(500).json({
        ok: false,
        msg: result?.error || "Unread scan failed.",
        ...result,
      });
    }

    const totalUnread = Number(result.totalUnread) || 0;
    const queuedCount = Number(result.queuedCount) || 0;
    const skippedCount = Number(result.skippedCount) || 0;
    const msg =
      totalUnread === 0
        ? "No unread WhatsApp messages found."
        : `Unread scan done. Found ${totalUnread}, queued ${queuedCount}, skipped ${skippedCount}.`;

    res.json({
      ok: true,
      msg,
      ...result,
    });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});


};
