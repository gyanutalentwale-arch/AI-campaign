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

    getUsageLog(req, res) {
      try {
        res.json({ log: configService.getUsageLog() });
      } catch (error) {
        sendError(res, error);
      }
    },

    getUsers(req, res) {
      try {
        res.json(configService.getUsers());
      } catch (error) {
        sendError(res, error);
      }
    },

    getHistory(req, res) {
      try {
        res.json({ history: configService.getHistory(req.params.userId) });
      } catch (error) {
        sendError(res, error);
      }
    },

    clearHistory(req, res) {
      try {
        res.json(configService.clearHistory(req.params.userId));
      } catch (error) {
        sendError(res, error);
      }
    },

    getPromptFile(req, res) {
      try {
        res.json({ data: configService.getPromptFile(req.query.file) });
      } catch (error) {
        sendError(res, error);
      }
    },

    savePromptFile(req, res) {
      try {
        res.json(configService.savePromptFile(req.body.file, req.body.data));
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

    getAiAuthStatus(req, res) {
      try {
        res.json(configService.getAiAuthStatus());
      } catch (error) {
        sendError(res, error);
      }
    },

    setAiAuthMode(req, res) {
      try {
        res.json(configService.setAiAuthMode(req.body?.mode));
      } catch (error) {
        sendError(res, error);
      }
    },

    async saveGoogleSession(req, res) {
      try {
        res.json(await configService.saveGoogleSession(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    },

    clearGoogleSession(req, res) {
      try {
        res.json(configService.clearGoogleSession());
      } catch (error) {
        sendError(res, error);
      }
    },

    async testGoogleOauth(req, res) {
      try {
        res.json(await configService.testGoogleOauth(req.body || {}));
      } catch (error) {
        sendError(res, error);
      }
    },

    getAutoReply(req, res) {
      try {
        res.json(configService.getAutoReply());
      } catch (error) {
        sendError(res, error);
      }
    },

    async setAutoReply(req, res) {
      try {
        res.json(await configService.setAutoReply(req.body?.enabled));
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
