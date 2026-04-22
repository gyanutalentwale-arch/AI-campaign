const createBotControlService = require("../services/bot-control.service");
const createBotController = require("../controllers/bot.controller");

module.exports = function registerBotRoutes(ctx) {
  const { app } = ctx;
  const botService = createBotControlService(ctx);
  const botController = createBotController(botService);

  app.post("/api/bot/start", botController.startBot);
  app.post("/api/bot/stop", botController.stopBot);
  app.post("/api/bot/restart", botController.restartBot);
  app.post("/api/bot/logout", botController.logoutBot);
};
