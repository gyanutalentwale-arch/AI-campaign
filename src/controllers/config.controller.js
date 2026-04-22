function sendError(res, error) {
  res.status(error?.status || 500).json({
    error: error?.message || "Internal server error",
  });
}

module.exports = function createConfigController(configService) {
  return {
    getStats(req, res) {
      try {
        res.json(configService.getStats());
      } catch (error) {
        sendError(res, error);
      }
    },

    getLogs(req, res) {
      try {
        res.json(configService.getLogs(req.query.limit));
      } catch (error) {
        sendError(res, error);
      }
    },

    getConfig(req, res) {
      try {
        res.json({ lines: configService.getConfigLines() });
      } catch (error) {
        sendError(res, error);
      }
    },

    updateConfig(req, res) {
      try {
        res.json(configService.updateConfig(req.body.key, req.body.value));
      } catch (error) {
        sendError(res, error);
      }
    },

    async listGroups(req, res) {
      try {
        res.json(await configService.listGroups());
      } catch (error) {
        sendError(res, error);
      }
    },

    async exportGroup(req, res) {
      try {
        const { filename, csv } = await configService.exportGroupCsv(
          req.params.groupId,
        );
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.send("\uFEFF" + csv);
      } catch (error) {
        sendError(res, error);
      }
    },
  };
};
