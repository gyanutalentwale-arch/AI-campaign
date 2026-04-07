require("dotenv").config();

const { server, io, state, addLog } = require("./server");
const createWhatsAppRuntime = require("./src/services/whatsapp-runtime.service");

const PORT = process.env.DASHBOARD_PORT || 3000;
const runtime = createWhatsAppRuntime({ io, state, addLog });

function startServer(port, retries = 5) {
  server.listen(port, () => {
    addLog("info", `Dashboard running at http://localhost:${port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && retries > 0) {
      addLog("warn", `Port ${port} busy, retrying on ${port + 1}...`);
      server.close();
      setTimeout(() => startServer(port + 1, retries - 1), 1000);
    } else {
      addLog("error", `Server error: ${error.message}`);
    }
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
