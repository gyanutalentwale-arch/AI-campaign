function sendError(res, error) {
  const status = error?.status || 500;
  res.status(status).json({ error: error?.message || "Internal server error" });
}

module.exports = function createVerifierController(verifierService) {
  return {
    parseUpload(req, res) {
      try {
        res.json(verifierService.parseContactsFromUpload(req.file));
      } catch (error) {
        sendError(res, error);
      }
    },

    async parseSheet(req, res) {
      try {
        res.json(await verifierService.parseContactsFromSheet(req.body?.url));
      } catch (error) {
        sendError(res, error);
      }
    },

    async startJob(req, res) {
      try {
        res.json(await verifierService.startJob(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    },

    pauseJob(req, res) {
      try {
        res.json(verifierService.pauseJob(req.body?.id));
      } catch (error) {
        sendError(res, error);
      }
    },

    async resumeJob(req, res) {
      try {
        res.json(await verifierService.resumeJob(req.body?.id));
      } catch (error) {
        sendError(res, error);
      }
    },

    stopJob(req, res) {
      try {
        res.json(verifierService.stopJob(req.body?.id));
      } catch (error) {
        sendError(res, error);
      }
    },

    getActiveJob(req, res) {
      try {
        res.json(verifierService.getActiveJob());
      } catch (error) {
        sendError(res, error);
      }
    },

    downloadLog(req, res) {
      try {
        const { filename, csv } = verifierService.getJobLog(
          req.params.id,
          req.query.type || "valid",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Type", "text/csv");
        res.send(csv);
      } catch (error) {
        const status = error?.status || 500;
        res.status(status).send(error?.message || "Internal server error");
      }
    },
  };
};
