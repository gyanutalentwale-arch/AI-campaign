const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

module.exports = function(app, io, state, addLog, path, fs) {
  const verifierService = require('../services/verifier.service')({ io, state, addLog });

  app.post('/api/verifier/parse-upload', upload.single('file'), (req, res) => {
    try {
      const data = verifierService.parseContactsFromUpload(req.file);
      res.json(data);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/verifier/parse-sheet', async (req, res) => {
    try {
      const data = await verifierService.parseContactsFromSheet(req.body.url);
      res.json(data);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/verifier/start', (req, res) => {
    try {
      if (!req.body.contacts || !req.body.contacts.length) throw new Error("No contacts provided");
      const result = verifierService.startJob(req.body.contacts);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/verifier/stop', (req, res) => {
    try {
      res.json(verifierService.stopJob(req.body.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/verifier/active', (req, res) => {
    res.json(verifierService.getActiveJob());
  });

  app.get('/api/verifier/log/:id', (req, res) => {
    try {
      const type = req.query.type || 'valid';
      const { filename, csv } = verifierService.getJobLog(req.params.id, type);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "text/csv");
      res.send(csv);
    } catch (err) {
      res.status(err.status || 500).send(err.message);
    }
  });
};