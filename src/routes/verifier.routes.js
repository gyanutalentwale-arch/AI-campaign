const multer = require("multer");
const createVerifierService = require("../services/verifier.service");
const createVerifierController = require("../controllers/verifier.controller");

module.exports = function registerVerifierRoutes(ctx) {
  const { app, io, state, addLog } = ctx;
  const upload = multer({ storage: multer.memoryStorage() });
  const verifierService = createVerifierService({ io, state, addLog });
  const verifierController = createVerifierController(verifierService);

  app.post("/api/verifier/parse-upload", upload.single("file"), verifierController.parseUpload);
  app.post("/api/verifier/parse-sheet", verifierController.parseSheet);
  app.post("/api/verifier/start", verifierController.startJob);
  app.post("/api/verifier/pause", verifierController.pauseJob);
  app.post("/api/verifier/resume", verifierController.resumeJob);
  app.post("/api/verifier/stop", verifierController.stopJob);
  app.get("/api/verifier/active", verifierController.getActiveJob);
  app.get("/api/verifier/log/:id", verifierController.downloadLog);
};
