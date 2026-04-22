const createConfigService = require("../services/config.service");
const createConfigController = require("../controllers/config.controller");

module.exports = function registerConfigRoutes(ctx) {
  const { app } = ctx;
  const configService = createConfigService(ctx);
  const configController = createConfigController(configService);

  app.get("/api/stats", configController.getStats);
  app.get("/api/logs", configController.getLogs);
  app.get("/api/usage-log", configController.getUsageLog);

  app.get("/api/config", configController.getConfig);
  app.post("/api/config", configController.updateConfig);

  app.get("/api/groups", configController.listGroups);
  app.get("/api/groups/:groupId/export", configController.exportGroup);
};
