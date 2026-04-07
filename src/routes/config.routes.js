const createConfigService = require("../services/config.service");
const createConfigController = require("../controllers/config.controller");

module.exports = function registerConfigRoutes(ctx) {
  const { app } = ctx;
  const configService = createConfigService(ctx);
  const configController = createConfigController(configService);

  app.get("/api/stats", configController.getStats);
  app.get("/api/logs", configController.getLogs);
  app.get("/api/usage-log", configController.getUsageLog);

  app.get("/api/users", configController.getUsers);
  app.get("/api/history/:userId", configController.getHistory);
  app.delete("/api/history/:userId", configController.clearHistory);

  app.get("/api/prompt-file", configController.getPromptFile);
  app.post("/api/prompt-file", configController.savePromptFile);

  app.get("/api/config", configController.getConfig);
  app.post("/api/config", configController.updateConfig);

  app.get("/api/ai-auth/status", configController.getAiAuthStatus);
  app.post("/api/ai-auth/mode", configController.setAiAuthMode);
  app.post("/api/ai-auth/google-session", configController.saveGoogleSession);
  app.delete("/api/ai-auth/google-session", configController.clearGoogleSession);
  app.post("/api/ai-auth/test", configController.testGoogleOauth);

  app.get("/api/autoreply", configController.getAutoReply);
  app.post("/api/autoreply", configController.setAutoReply);

  app.get("/api/groups", configController.listGroups);
  app.get("/api/groups/:groupId/export", configController.exportGroup);
};
