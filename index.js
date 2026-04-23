require("dotenv").config();

const { server, io, state, addLog } = require("./server");
const createWhatsAppRuntime = require("./src/services/whatsapp-runtime.service");

const requestedPort = parseInt(
  process.env.PORT || process.env.WEBSITES_PORT || process.env.DASHBOARD_PORT || "3000",
  10,
);
const PORT = Number.isFinite(requestedPort) ? requestedPort : 3000;
const isManagedPort = Boolean(process.env.PORT || process.env.WEBSITES_PORT);
const runtime = createWhatsAppRuntime({ io, state, addLog });

function startServer(port, retries = 5) {
  const onError = (error) => {
    const canRetry = !isManagedPort && error.code === "EADDRINUSE" && retries > 0;
    if (canRetry) {
      addLog("warn", `Port ${port} busy, retrying on ${port + 1}...`);
      setTimeout(() => startServer(port + 1, retries - 1), 1000);
      return;
    }

    addLog("error", `Server error on port ${port}: ${error.message}`);
    if (isManagedPort) {
      process.exit(1);
    }
  };

  server.once("error", onError);
  server.listen(port, () => {
    server.off("error", onError);
    addLog("info", `Dashboard running on port ${port}`);
  });
}

process.on("SIGINT", async () => {
  addLog("info", "Shutting down bot...");
  try {
    await runtime.shutdown();
  } catch (_) {}
  process.exit(0);
});

startServer(PORT);
