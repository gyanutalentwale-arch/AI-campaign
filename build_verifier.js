const fs = require('fs');
const path = require('path');

// 1. Create src/services/verifier.service.js
const verifierServiceContent = `
const axios = require('axios');
const XLSX = require('xlsx');

module.exports = function createVerifierService({ io, state, addLog }) {
  const jobs = new Map();

  function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function normalizeRawPhoneDigits(value) {
    if (value === null || value === undefined) return "";
    let raw = String(value).trim();
    if (!raw) return "";

    const sci = raw.replace(/,/g, "");
    if (/^[+-]?\\d*\\.?\\d+e[+-]?\\d+$/i.test(sci)) {
      const parsed = Number(sci);
      if (Number.isFinite(parsed)) {
        raw = parsed.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
      }
    }

    raw = raw.replace(/\\.0+$/, "");
    return raw.replace(/\\D/g, "");
  }

  function toWAId(number) {
    const n = normalizeRawPhoneDigits(number);
    if (!n) return "";
    if (n.startsWith("91") && n.length === 12) return n + "@c.us";
    if (n.length === 10) return "91" + n + "@c.us";
    if (n.length === 11 && n.startsWith("0")) return "91" + n.slice(1) + "@c.us";
    if (n.length >= 11 && n.length <= 15) return n + "@c.us";
    return "91" + n.slice(-10) + "@c.us";
  }

  // Parse Rows
  function parseRowsFromFile(buffer, mimetype, originalname) {
    const ext = require('path').extname(originalname).toLowerCase();
    let rows = [];
    let headers = [];

    if (ext === ".csv" || mimetype === "text/csv") {
      const csv = buffer.toString("utf8").replace(/^\\uFEFF/, "").trim();
      const lines = csv ? csv.split("\\n") : [];
      if (!lines.length) return { rows: [], headers: [] };
      headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      lines.slice(1).forEach((line) => {
        const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        if (cols.every((c) => !c)) return;
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cols[i] || ""; });
        rows.push(obj);
      });
    } else {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      if (rows.length) headers = Object.keys(rows[0]);
    }

    return { rows, headers };
  }

  function parseContactsFile(buffer, mimetype, originalname) {
    const { rows, headers } = parseRowsFromFile(buffer, mimetype, originalname);
    const numCol = headers.find((h) => /number|phone|mobile|contact|whatsapp|cell|ph\\b|no\\b|num/i.test(h));
    const contacts = rows.map((row) => {
      const num = numCol ? normalizeRawPhoneDigits(row[numCol]) : "";
      return num.length >= 10 ? row : null;
    }).filter(Boolean);

    return { contacts, headers, numCol };
  }

  function getGoogleSheetCsvUrl(url) {
    const match = url.match(/\\/spreadsheets\\/d\\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("Invalid Google Sheets URL");
    const sheetId = match[1];
    const gidMatch = url.match(/[#&?]gid=(\\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return \`https://docs.google.com/spreadsheets/d/\${sheetId}/export?format=csv&gid=\${gid}\`;
  }

  function parseContactsFromUpload(file) {
    if (!file) throw createHttpError(400, "No file uploaded");
    const { contacts, headers, numCol } = parseContactsFile(file.buffer, file.mimetype, file.originalname);
    if (!contacts.length) throw createHttpError(400, 'No valid contacts found. Need a number column.');
    return { contacts, headers, total: contacts.length, numCol };
  }

  async function parseContactsFromSheet(url) {
    if (!url) throw createHttpError(400, "URL required");
    try {
      const csvUrl = getGoogleSheetCsvUrl(url);
      const response = await axios.get(csvUrl, { responseType: "arraybuffer", timeout: 10000 });
      const buffer = Buffer.from(response.data);
      const { contacts, headers, numCol } = parseContactsFile(buffer, "text/csv", "sheet.csv");
      if (!contacts.length) throw createHttpError(400, "No valid contacts found in sheet.");
      return { contacts, headers, total: contacts.length, numCol };
    } catch (error) {
      throw createHttpError(400, \`Failed to parse Google Sheet: \${error.message}\`);
    }
  }

  function resolveWaIdFromLookup(result, fallbackWaId) {
    if (!result) return fallbackWaId;
    if (typeof result === "string") return result;
    if (result._serialized) return result._serialized;
    if (result.user && result.server) return \`\${result.user}@\${result.server}\`;
    if (result.user) return \`\${result.user}@c.us\`;
    return fallbackWaId;
  }

  function isNonWhatsAppError(message) {
    const text = String(message || "").toLowerCase();
    return /not on whatsapp|not a whatsapp user|invalid wid|not registered|does not exist/.test(text);
  }

  async function verifyWhatsAppRecipient(botClient, waId) {
    if (!botClient?.getNumberId) throw new Error("Bot client not ready for verification.");
    try {
      const lookupId = await botClient.getNumberId(waId);
      if (!lookupId) return { registered: false, waId };
      return { registered: true, waId: resolveWaIdFromLookup(lookupId, waId) };
    } catch (error) {
      if (isNonWhatsAppError(error?.message)) return { registered: false, waId };
      throw new Error(\`Verification failed: \${error?.message || String(error)}\`);
    }
  }

  function emitJobProgress(id, job) {
    io.emit("verifier_progress", {
      id,
      status: job.status,
      total: job.total,
      valid: job.valid,
      invalid: job.invalid,
      failed: job.failed,
      processed: job.valid + job.invalid + job.failed
    });
  }

  async function runJobLoop(id, job, contacts) {
    addLog('info', \`Bulk verification started for \${contacts.length} numbers.\`);
    
    for (const contact of contacts) {
      if (job.status === "stopped") {
        addLog('info', 'Bulk verification stopped.');
        break;
      }

      const numCol = Object.keys(contact).find(k => /number|phone|mobile|contact|whatsapp|cell|no\\b|num/i.test(k)) || Object.keys(contact)[0];
      const rawNum = contact[numCol];
      const waId = toWAId(rawNum);

      let verifierClient = state.botVerifierClient || state.botClient;
      if (!verifierClient || (state.botVerifierStatus !== 'ready' && state.botStatus !== 'ready')) {
        job.status = "stopped";
        addLog('error', 'Verifier stopped - WhatsApp not connected.');
        emitJobProgress(id, job);
        break;
      }

      try {
        const verification = await verifyWhatsAppRecipient(verifierClient, waId);
        if (verification.registered) {
          job.valid++;
          job.cleanContacts.push(contact);
        } else {
          job.invalid++;
        }
      } catch (err) {
        job.failed++;
        addLog('warn', \`Verification failed for \${rawNum}: \${err.message}\`);
      }

      emitJobProgress(id, job);
      // Small delay to prevent rate limit (200ms - 600ms)
      await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
    }

    if (job.status !== "stopped") {
      job.status = "done";
      addLog('success', \`Verification finished! Valid: \${job.valid}/{job.total}\`);
      emitJobProgress(id, job);
    }
    if (state.activeVerifierId === id) state.activeVerifierId = null;
  }

  function startJob(contacts) {
    const id = Date.now().toString();
    const job = {
      id,
      status: "running",
      total: contacts.length,
      valid: 0,
      invalid: 0,
      failed: 0,
      cleanContacts: [],
    };
    jobs.set(id, job);
    state.activeVerifierId = id;

    void runJobLoop(id, job, contacts);
    return { id };
  }

  function stopJob(id) {
    const job = jobs.get(id);
    if (job) job.status = "stopped";
    return { ok: true };
  }

  function getActiveJob() {
    const id = state.activeVerifierId;
    if (!id) return { active: false };
    const job = jobs.get(id);
    if (!job) return { active: false };
    return {
      active: true,
      job: {
        id,
        status: job.status,
        total: job.total,
        valid: job.valid,
        invalid: job.invalid,
        failed: job.failed,
        processed: job.valid + job.invalid + job.failed
      }
    };
  }

  function getJobLog(id) {
    const job = jobs.get(id);
    if (!job || !job.cleanContacts.length) {
      throw createHttpError(404, "No valid contacts found for download");
    }
    const headers = [...new Set(job.cleanContacts.flatMap(r => Object.keys(r)))];
    const csv = [
      headers.join(","),
      ...job.cleanContacts.map(r => headers.map(h => \`"\${(r[h] || "").toString().replace(/"/g, '""')}"\`).join(","))
    ].join("\\n");
    return { filename: \`verified_contacts_\${id}.csv\`, csv };
  }

  return {
    parseContactsFromUpload,
    parseContactsFromSheet,
    startJob,
    stopJob,
    getActiveJob,
    getJobLog
  };
};
`;
fs.writeFileSync(path.join('src', 'services', 'verifier.service.js'), verifierServiceContent.trim());

// 2. Create src/routes/verifier.routes.js
const verifierRoutesContent = `
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
      const { filename, csv } = verifierService.getJobLog(req.params.id);
      res.setHeader("Content-Disposition", \`attachment; filename="\${filename}"\`);
      res.setHeader("Content-Type", "text/csv");
      res.send(csv);
    } catch (err) {
      res.status(err.status || 500).send(err.message);
    }
  });
};
`;
fs.writeFileSync(path.join('src', 'routes', 'verifier.routes.js'), verifierRoutesContent.trim());

// 3. Edit server.js to require verifier routes
let serverJs = fs.readFileSync('server.js', 'utf8');
if (!serverJs.includes('verifier.routes')) {
    serverJs = serverJs.replace(
        "require('./src/routes/email.routes')(app, io, state, addLog, path, fs);",
        "require('./src/routes/email.routes')(app, io, state, addLog, path, fs);\nrequire('./src/routes/verifier.routes')(app, io, state, addLog, path, fs);"
    );
    fs.writeFileSync('server.js', serverJs);
}

// 4. Edit index.html
let html = fs.readFileSync('public/index.html', 'utf8');
if (!html.includes('data-page="verify"')) {
    html = html.replace(
        '<div class="nav-item" data-page="email"><span class="icon">📧</span> Email Campaign</div>',
        '<div class="nav-item" data-page="email"><span class="icon">📧</span> Email Campaign</div>\n      <div class="nav-item" data-page="verify"><span class="icon">🔍</span> Bulk Verifier</div>'
    );

    const verifierHTML = `
      <div id="page-verify" class="page">
        <div class="page-header">
          <h1>Bulk Number Verifier</h1>
          <p>Scan a list of numbers to check if they are available on WhatsApp, and download the cleaned list.</p>
        </div>
        <div class="card">
          <div class="form-group">
            <label>Upload Contacts (CSV/Excel)</label>
            <input type="file" id="verify-file" accept=".csv, .xlsx, .xls">
          </div>
          <div class="form-group" style="text-align:center"><b>OR</b></div>
          <div class="form-group">
            <label>Google Sheet URL</label>
            <div style="display:flex;gap:10px;">
              <input type="text" id="verify-sheet-url" placeholder="https://docs.google.com/spreadsheets/...">
              <button class="btn btn-purple" id="btn-verify-load-sheet">Load Sheet</button>
            </div>
            <p class="hint">Ensure "Anyone with the link can view"</p>
          </div>
          
          <div id="verify-parsed-info" class="hint" style="margin-bottom:15px;color:var(--success);display:none;"></div>
          
          <div class="controls">
            <button class="btn btn-green" id="btn-verify-start" disabled>Start Verification</button>
            <button class="btn btn-red" id="btn-verify-stop" style="display:none;">Stop</button>
          </div>
        </div>
        
        <div class="card" id="verify-progress-card" style="display:none;">
          <h3>Verification Progress</h3>
          <div class="progress-bar"><div class="progress-fill" id="verify-progress-fill" style="width:0%"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:14px;">
            <span>Total: <b id="verify-stat-total">0</b></span>
            <span style="color:var(--success)">Valid: <b id="verify-stat-valid">0</b></span>
            <span style="color:var(--red)">Invalid: <b id="verify-stat-invalid">0</b></span>
            <span style="color:var(--yellow)">Failed: <b id="verify-stat-failed">0</b></span>
          </div>
          <div style="margin-top:20px;text-align:center;">
             <a class="btn btn-purple" id="btn-verify-download" style="display:none" href="#" target="_blank">Download Valid Numbers</a>
          </div>
        </div>
      </div>
    `;

    html = html.replace('</div> <!-- MAIN CONTENT -->', verifierHTML + '\n    </div> <!-- MAIN CONTENT -->');
    fs.writeFileSync('public/index.html', html);
}

// 5. Edit dashboard.js
let dash = fs.readFileSync('public/assets/dashboard.js', 'utf8');
if (!dash.includes('const btnVerifyStart')) {
    const dashAddition = `
let verifyParsedContacts = [];
let activeVerifyJobId = null;

const btnVerifyLoadSheet = document.getElementById('btn-verify-load-sheet');
const verifyFileInput = document.getElementById('verify-file');
const btnVerifyStart = document.getElementById('btn-verify-start');
const btnVerifyStop = document.getElementById('btn-verify-stop');

if (verifyFileInput) {
  verifyFileInput.addEventListener('change', () => {
    if (!verifyFileInput.files[0]) return;
    const fd = new FormData();
    fd.append('file', verifyFileInput.files[0]);
    btnVerifyStart.textContent = 'Parsing...';
    btnVerifyStart.disabled = true;
    fetch('/api/verifier/parse-upload', { method: 'POST', body: fd })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        verifyParsedContacts = d.contacts;
        document.getElementById('verify-parsed-info').textContent = \`Loaded \${d.total} valid rows.\`;
        document.getElementById('verify-parsed-info').style.display = 'block';
        btnVerifyStart.disabled = false;
        btnVerifyStart.textContent = 'Start Verification';
      }).catch(e => {
        toast('Parse Error: ' + e.message);
        btnVerifyStart.textContent = 'Start Verification';
      });
  });
}

if (btnVerifyLoadSheet) {
  btnVerifyLoadSheet.addEventListener('click', () => {
    const url = document.getElementById('verify-sheet-url').value.trim();
    if (!url) return toast('Enter Google Sheet URL');
    btnVerifyLoadSheet.disabled = true;
    btnVerifyLoadSheet.textContent = 'Loading...';
    fetch('/api/verifier/parse-sheet', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url })
    }).then(r => r.json()).then(d => {
      btnVerifyLoadSheet.disabled = false;
      btnVerifyLoadSheet.textContent = 'Load Sheet';
      if (d.error) throw new Error(d.error);
      verifyParsedContacts = d.contacts;
      document.getElementById('verify-parsed-info').textContent = \`Loaded \${d.total} valid rows.\`;
      document.getElementById('verify-parsed-info').style.display = 'block';
      btnVerifyStart.disabled = false;
    }).catch(e => toast('Sheet Error: ' + e.message));
  });
}

if (btnVerifyStart) {
  btnVerifyStart.addEventListener('click', () => {
    if (!verifyParsedContacts.length) return toast('Load contacts first');
    btnVerifyStart.disabled = true;
    fetch('/api/verifier/start', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ contacts: verifyParsedContacts })
    }).then(r => r.json()).then(d => {
      if (d.error) {
        btnVerifyStart.disabled = false;
        return toast('Start Error: ' + d.error);
      }
      activeVerifyJobId = d.id;
      document.getElementById('verify-progress-card').style.display = 'block';
      btnVerifyStart.style.display = 'none';
      btnVerifyStop.style.display = 'block';
      document.getElementById('btn-verify-download').style.display = 'none';
      toast('Verification started!');
    });
  });
}

if (btnVerifyStop) {
  btnVerifyStop.addEventListener('click', () => {
    if (!activeVerifyJobId) return;
    fetch('/api/verifier/stop', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: activeVerifyJobId })
    }).then(() => toast('Stopping verifier...'));
  });
}

socket.on('verifier_progress', (job) => {
  activeVerifyJobId = job.id;
  document.getElementById('verify-progress-card').style.display = 'block';
  
  if (btnVerifyStart) {
    if (job.status === 'running') {
      btnVerifyStart.style.display = 'none';
      btnVerifyStop.style.display = 'inline-block';
    } else {
      btnVerifyStart.style.display = 'inline-block';
      btnVerifyStart.disabled = false;
      btnVerifyStop.style.display = 'none';
    }
  }

  document.getElementById('verify-stat-total').textContent = job.total;
  document.getElementById('verify-stat-valid').textContent = job.valid;
  document.getElementById('verify-stat-invalid').textContent = job.invalid;
  document.getElementById('verify-stat-failed').textContent = job.failed;
  
  const pct = job.total > 0 ? ((job.processed / job.total) * 100).toFixed(1) : 0;
  document.getElementById('verify-progress-fill').style.width = pct + '%';
  
  const dlBtn = document.getElementById('btn-verify-download');
  if ((job.status === 'done' || job.status === 'stopped') && job.valid > 0) {
    dlBtn.style.display = 'inline-block';
    dlBtn.href = '/api/verifier/log/' + job.id;
  } else {
    dlBtn.style.display = 'none';
  }
});
`;
    // Find where page navigation is attached, we can just append.
    dash += '\n' + dashAddition;
    
    // add verify link to navigation logic
    dash = dash.replace(
        "if (item.dataset.page === 'training') loadTraining();",
        "if (item.dataset.page === 'verify') document.getElementById('page-verify').classList.add('active');\n    if (item.dataset.page === 'training') loadTraining();"
    );

    fs.writeFileSync('public/assets/dashboard.js', dash);
}

console.log("Verifier build completed.");
