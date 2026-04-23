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
  resolveRuntimePath,
}) {
  function setBotStatus(status) {
    state.botStatus = status;
    io.emit("status", status);
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

    const sessionPath =
      typeof resolveRuntimePath === "function"
        ? resolveRuntimePath("whatsapp_session")
        : path.join(process.cwd(), "whatsapp_session");
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

  return {
    logoutBot,
    restartBot,
    startBot,
    stopBot,
  };
};
