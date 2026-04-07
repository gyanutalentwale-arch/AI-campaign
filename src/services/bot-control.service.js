function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = function createBotControlService({
  io,
  state,
  addLog,
  path,
  fs,
}) {
  function setBotStatus(status) {
    state.botStatus = status;
    io.emit("status", status);
  }

  function setVerifierStatus(status) {
    state.botVerifierStatus = status;
    io.emit("status_verifier", status);
  }

  async function startBot() {
    if (state.botStatus !== "stopped") {
      return { ok: false, msg: "Bot already running" };
    }
    if (!state.botInitFn) {
      throw createHttpError(500, "Bot not ready");
    }

    setBotStatus("starting");
    addLog("info", "Bot starting...");
    state.botInitFn();
    return { ok: true };
  }

  async function stopBot() {
    if (!state.botDestroyFn) {
      throw createHttpError(500, "Bot not ready");
    }

    try {
      addLog("info", "Bot stopping...");
      await state.botDestroyFn();
    } finally {
      setBotStatus("stopped");
    }

    return { ok: true };
  }

  async function restartBot() {
    if (!state.botDestroyFn || !state.botInitFn) {
      throw createHttpError(500, "Bot not ready");
    }

    addLog("info", "Bot restarting...");
    try {
      await state.botDestroyFn();
    } catch (_) {}
    setBotStatus("starting");
    setTimeout(() => {
      state.botInitFn();
    }, 2000);
    return { ok: true };
  }

  async function logoutBot() {
    addLog("info", "Logging out WhatsApp session...");

    if (state.botLogoutFn) {
      await state.botLogoutFn();
    } else if (state.botClient) {
      try {
        await state.botClient.logout();
      } catch (_) {}
      try {
        await state.botClient.destroy();
      } catch (_) {}
    }

    const sessionPath = path.join(process.cwd(), "whatsapp_session");
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      addLog("info", "Session data cleared");
    }

    state.botClient = null;
    state.qrCode = null;
    setBotStatus("stopped");

    return {
      ok: true,
      msg: "Logged out. Click WhatsApp Connect to scan QR again.",
    };
  }

  async function startVerifier() {
    if (state.botVerifierStatus !== "stopped") {
      return { ok: false, msg: "Verifier already running" };
    }
    if (!state.botVerifierInitFn) {
      throw createHttpError(500, "Verifier not ready");
    }

    setVerifierStatus("starting");
    addLog("info", "Verifier starting...");
    state.botVerifierInitFn();
    return { ok: true };
  }

  async function stopVerifier() {
    if (!state.botVerifierDestroyFn) {
      throw createHttpError(500, "Verifier not ready");
    }

    try {
      addLog("info", "Verifier stopping...");
      await state.botVerifierDestroyFn();
    } finally {
      setVerifierStatus("stopped");
    }

    return { ok: true };
  }

  async function restartVerifier() {
    if (!state.botVerifierDestroyFn || !state.botVerifierInitFn) {
      throw createHttpError(500, "Verifier not ready");
    }

    addLog("info", "Verifier restarting...");
    try {
      await state.botVerifierDestroyFn();
    } catch (_) {}
    setVerifierStatus("starting");
    setTimeout(() => {
      state.botVerifierInitFn();
    }, 2000);
    return { ok: true };
  }

  async function logoutVerifier() {
    addLog("info", "Logging out Verifier session...");

    if (state.botVerifierLogoutFn) {
      await state.botVerifierLogoutFn();
    } else if (state.botVerifierClient) {
      try {
        await state.botVerifierClient.logout();
      } catch (_) {}
      try {
        await state.botVerifierClient.destroy();
      } catch (_) {}
    }

    const sessionPath = path.join(process.cwd(), "whatsapp_session_verifier");
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      addLog("info", "Verifier Session data cleared");
    }

    state.botVerifierClient = null;
    state.verifierQrCode = null;
    setVerifierStatus("stopped");

    return {
      ok: true,
      msg: "Verifier Logged out. Click Connect Verifier to scan QR again.",
    };
  }

  async function scanUnread() {
    if (typeof state.processUnreadFn !== "function") {
      throw createHttpError(500, "Unread scanner is not available right now.");
    }

    addLog("info", "Manual unread scan requested from dashboard.");
    const result = await state.processUnreadFn("dashboard_button");

    if (!result?.ok) {
      const reason = result?.reason;
      if (reason === "bot_not_ready") {
        throw Object.assign(
          createHttpError(400, "WhatsApp bot not ready. Connect WhatsApp first."),
          { payload: result },
        );
      }
      if (reason === "auto_reply_off") {
        throw Object.assign(
          createHttpError(400, "Auto Reply is OFF. Enable it first, then scan unread messages."),
          { payload: result },
        );
      }
      if (reason === "scan_in_progress") {
        throw Object.assign(
          createHttpError(409, "Unread scan is already running."),
          { payload: result },
        );
      }
      throw Object.assign(
        createHttpError(500, result?.error || "Unread scan failed."),
        { payload: result },
      );
    }

    const totalUnread = Number(result.totalUnread) || 0;
    const queuedCount = Number(result.queuedCount) || 0;
    const skippedCount = Number(result.skippedCount) || 0;

    return {
      ok: true,
      msg:
        totalUnread === 0
          ? "No unread WhatsApp messages found."
          : `Unread scan done. Found ${totalUnread}, queued ${queuedCount}, skipped ${skippedCount}.`,
      ...result,
    };
  }

  return {
    logoutBot,
    logoutVerifier,
    restartBot,
    restartVerifier,
    scanUnread,
    startBot,
    startVerifier,
    stopBot,
    stopVerifier,
  };
};
