const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

module.exports = function createWhatsAppRuntime({ io, state, addLog }) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "client-one",
      dataPath: "./whatsapp_session",
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  function setStatus(status) {
    state.botStatus = status;
    io.emit("status", status);
  }

  state.botInitFn = () => client.initialize();
  state.botDestroyFn = () => client.destroy();
  state.botLogoutFn = async () => {
    try {
      await client.logout();
    } catch (_) {}
    try {
      await client.destroy();
    } catch (_) {}
  };
  state.botClient = null;

  client.on("qr", async (qr) => {
    addLog("info", "Sender QR code generated. Scan it from the dashboard.");
    setStatus("qr");
    try {
      const qrDataUrl = await QRCode.toDataURL(qr);
      state.qrCode = qrDataUrl;
      io.emit("qr", qrDataUrl);
    } catch (_) {}
  });

  client.on("authenticated", () => {
    addLog("info", "Sender authenticated via QR.");
    setStatus("starting");
  });

  client.on("auth_failure", (msg) => {
    addLog("error", `Sender auth failed: ${String(msg || "unknown error")}`);
    state.botClient = null;
    setStatus("stopped");
  });

  client.on("disconnected", (reason) => {
    const reasonText = String(reason || "").toLowerCase();
    state.botClient = null;
    setStatus("stopped");

    if (reasonText.includes("navigation") || reasonText.includes("logout")) {
      addLog(
        "warn",
        "Sender disconnected. Bot stopped. Use WhatsApp Connect to start again.",
      );
      return;
    }

    addLog("warn", `Sender disconnected (${reason || "unknown"}). Reconnecting...`);
    setStatus("starting");
    client.initialize();
  });

  client.on("ready", () => {
    addLog("success", "WhatsApp sender is ready.");
    state.botClient = client;
    state.qrCode = null;
    setStatus("ready");
  });

  addLog(
    "info",
    "Inbound auto-reply flow is disabled. Sender account is used for campaigns and verification.",
  );

  setStatus("stopped");

  return {
    client,
    shutdown: async () => {
      try {
        await client.destroy();
      } catch (_) {}
    },
  };
};
