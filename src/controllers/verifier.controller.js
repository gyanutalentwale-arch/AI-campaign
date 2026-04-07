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

    startJob(req, res) {
      try {
        res.json(verifierService.startJob(req.body?.contacts));
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
