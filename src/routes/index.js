module.exports = function registerRoutes(ctx) {
  require("./bot.routes")(ctx);
  require("./config.routes")(ctx);
  require("./campaign.routes")(ctx);
  require("./email.routes")(ctx);
  require("./verifier.routes")(ctx);
};
