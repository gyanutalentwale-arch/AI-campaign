function sendError(res, error) {
  const status = error?.status || 500;
  const message = error?.message || "Internal server error";
  res.status(status).json({ error: message });
}

module.exports = function createCampaignController(campaignService) {
  return {
    parseFile(req, res) {
      try {
        const data = campaignService.parseContactsFromUpload(req.file);
        res.json(data);
      } catch (error) {
        sendError(res, error);
      }
    },

    async parseSheet(req, res) {
      try {
        const data = await campaignService.parseContactsFromSheet(req.body?.url);
        res.json(data);
      } catch (error) {
        sendError(res, error);
      }
    },

    uploadImage(req, res) {
      try {
        const data = campaignService.buildUploadedImagePayload(req.file);
        res.json(data);
      } catch (error) {
        sendError(res, error);
      }
    },

    getPreset(req, res) {
      try {
        res.json({ preset: campaignService.getCampaignPreset() });
      } catch (error) {
        sendError(res, error);
      }
    },

    savePreset(req, res) {
      try {
        const preset = campaignService.saveCampaignPresetData(req.body || {});
        res.json({ ok: true, preset });
      } catch (error) {
        sendError(res, error);
      }
    },

    startCampaign(req, res) {
      try {
        const result = campaignService.startCampaign(req.body || {});
        res.json(result);
      } catch (error) {
        sendError(res, error);
      }
    },

    stopCampaign(req, res) {
      try {
        const result = campaignService.stopCampaign(req.params.id);
        res.json(result);
      } catch (error) {
        sendError(res, error);
      }
    },

    getActiveCampaign(req, res) {
      try {
        const data = campaignService.getActiveCampaign();
        res.json(data);
      } catch (error) {
        sendError(res, error);
      }
    },

    downloadLog(req, res) {
      try {
        const { filename, csv } = campaignService.getCampaignLog(req.params.id);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send("\uFEFF" + csv);
      } catch (error) {
        sendError(res, error);
      }
    },
  };
};
