const multer = require("multer");
const createCampaignService = require("../services/campaign.service");
const createCampaignController = require("../controllers/campaign.controller");

module.exports = function (
  app,
  io,
  state,
  addLog,
  path,
  fs,
  recordModelCallUsage = () => {},
) {
  const upload = multer({ storage: multer.memoryStorage() });
  const uploadImg = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  const campaignService = createCampaignService({
    io,
    state,
    addLog,
    path,
    fs,
    recordModelCallUsage,
  });
  const campaignController = createCampaignController(campaignService);

  app.post("/api/campaign/parse", upload.single("file"), campaignController.parseFile);
  app.post("/api/campaign/parse-sheet", campaignController.parseSheet);
  app.post(
    "/api/campaign/upload-image",
    uploadImg.single("image"),
    campaignController.uploadImage,
  );
  app.get("/api/campaign/preset", campaignController.getPreset);
  app.post("/api/campaign/preset", campaignController.savePreset);
  app.post("/api/campaign/start", campaignController.startCampaign);
  app.post("/api/campaign/stop/:id", campaignController.stopCampaign);
  app.get("/api/campaign/active", campaignController.getActiveCampaign);
  app.get("/api/campaign/:id/log", campaignController.downloadLog);
};
