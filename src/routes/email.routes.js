const multer = require("multer");
const createEmailController = require("../controllers/email.controller");
const createEmailService = require("../services/email.service");

module.exports = function registerEmailRoutes(ctx) {
  const { app } = ctx;
  const upload = multer({ storage: multer.memoryStorage() });
  const emailService = createEmailService(ctx);
  const emailController = createEmailController(emailService);

  app.post("/api/email/parse", upload.single("file"), emailController.parseFile);
  app.post("/api/email/parse-sheet", emailController.parseSheet);
  app.get("/api/email/test", emailController.testAccounts);
  app.get("/api/email/accounts", emailController.listAccounts);
  app.get("/api/email/preset", emailController.getPreset);
  app.post("/api/email/preset", emailController.savePreset);
  app.post("/api/email/start", emailController.startCampaign);
  app.post("/api/email/stop/:id", emailController.stopCampaign);
  app.get("/api/email/:id/log", emailController.downloadLog);
};
