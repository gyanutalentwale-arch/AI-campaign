function sendError(res, error) {
  const status = error?.status || 500;
  const payload = error?.payload || {};
  res.status(status).json({
    ok: false,
    msg: error?.message || "Internal server error",
    ...payload,
  });
}

module.exports = function createBotController(botService) {
  return {
    async startBot(req, res) {
      try {
        res.json(await botService.startBot());
      } catch (error) {
        sendError(res, error);
      }
    },

    async stopBot(req, res) {
      try {
        res.json(await botService.stopBot());
      } catch (error) {
        sendError(res, error);
      }
    },

    async restartBot(req, res) {
      try {
        res.json(await botService.restartBot());
      } catch (error) {
        sendError(res, error);
      }
    },

    async logoutBot(req, res) {
      try {
        res.json(await botService.logoutBot());
      } catch (error) {
        sendError(res, error);
      }
    },

    async startVerifier(req, res) {
      try {
        res.json(await botService.startVerifier());
      } catch (error) {
        sendError(res, error);
      }
    },

    async stopVerifier(req, res) {
      try {
        res.json(await botService.stopVerifier());
      } catch (error) {
        sendError(res, error);
      }
    },

    async restartVerifier(req, res) {
      try {
        res.json(await botService.restartVerifier());
      } catch (error) {
        sendError(res, error);
      }
    },

    async logoutVerifier(req, res) {
      try {
        res.json(await botService.logoutVerifier());
      } catch (error) {
        sendError(res, error);
      }
    },

    async scanUnread(req, res) {
      try {
        res.json(await botService.scanUnread());
      } catch (error) {
        sendError(res, error);
      }
    },
  };
};
