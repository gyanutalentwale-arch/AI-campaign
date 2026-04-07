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
    if (/^[+-]?\d*\.?\d+e[+-]?\d+$/i.test(sci)) {
      const parsed = Number(sci);
      if (Number.isFinite(parsed)) {
        raw = parsed.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
      }
    }

    raw = raw.replace(/\.0+$/, "");
    return raw.replace(/\D/g, "");
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
      const csv = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
      const lines = csv ? csv.split("\n") : [];
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
    const numCol = headers.find((h) => /number|phone|mobile|contact|whatsapp|cell|ph\b|no\b|num/i.test(h));
    const contacts = rows.map((row) => {
      const num = numCol ? normalizeRawPhoneDigits(row[numCol]) : "";
      return num.length >= 10 ? row : null;
    }).filter(Boolean);

    return { contacts, headers, numCol };
  }

  function getGoogleSheetCsvUrl(url) {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("Invalid Google Sheets URL");
    const sheetId = match[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
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
      throw createHttpError(400, `Failed to parse Google Sheet: ${error.message}`);
    }
  }

  function resolveWaIdFromLookup(result, fallbackWaId) {
    if (!result) return fallbackWaId;
    if (typeof result === "string") return result;
    if (result._serialized) return result._serialized;
    if (result.user && result.server) return `${result.user}@${result.server}`;
    if (result.user) return `${result.user}@c.us`;
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
      throw new Error(`Verification failed: ${error?.message || String(error)}`);
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

  function getReadyVerifierClient() {
    if (state.botVerifierStatus === "ready" && state.botVerifierClient) {
      return state.botVerifierClient;
    }
    if (state.botStatus === "ready" && state.botClient) {
      return state.botClient;
    }
    return null;
  }

  async function runJobLoop(id, job, contacts) {
    addLog('info', `Bulk verification started for ${contacts.length} numbers.`);
    
    for (const contact of contacts) {
      if (job.status === "stopped") {
        addLog('info', 'Bulk verification stopped.');
        break;
      }

      const numCol = Object.keys(contact).find(k => /number|phone|mobile|contact|whatsapp|cell|no\b|num/i.test(k)) || Object.keys(contact)[0];
      const rawNum = contact[numCol];
      const waId = toWAId(rawNum);

      const verifierClient = getReadyVerifierClient();
      if (!verifierClient) {
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
          job.invalidContacts.push({ ...contact, Verification_Error: "Not on WhatsApp" });
        }
      } catch (err) {
        job.failed++;
        job.invalidContacts.push({ ...contact, Verification_Error: `Failed: ${err.message}` });
        addLog('warn', `Verification failed for ${rawNum}: ${err.message}`);
      }

      emitJobProgress(id, job);
      // Small delay to prevent rate limit (200ms - 600ms)
      await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
    }

    if (job.status !== "stopped") {
      job.status = "done";
      addLog('success', `Verification finished! Valid: ${job.valid}/${job.total}`);
      emitJobProgress(id, job);
    }
    if (state.activeVerifierId === id) state.activeVerifierId = null;
  }

  function startJob(contacts) {
    if (!Array.isArray(contacts) || !contacts.length) {
      throw createHttpError(400, "No contacts provided");
    }

    const activeJob = state.activeVerifierId ? jobs.get(state.activeVerifierId) : null;
    if (activeJob && activeJob.status === "running") {
      throw createHttpError(409, "A verification job is already running.");
    }

    if (!getReadyVerifierClient()) {
      throw createHttpError(400, "Connect WhatsApp sender or verifier before starting verification.");
    }

    const id = Date.now().toString();
    const job = {
      id,
      status: "running",
      total: contacts.length,
      valid: 0,
      invalid: 0,
      failed: 0,
      cleanContacts: [],
      invalidContacts: [],
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

  function getJobLog(id, type = 'valid') {
    const job = jobs.get(id);
    if (!job) throw createHttpError(404, "No active job found");
    
    const targetContacts = type === 'invalid' ? job.invalidContacts : job.cleanContacts;
    if (!targetContacts || !targetContacts.length) {
      throw createHttpError(404, `No ${type} contacts found for download`);
    }
    
    const headers = [...new Set(targetContacts.flatMap(r => Object.keys(r)))];
    const csv = [
      headers.join(","),
      ...targetContacts.map(r => headers.map(h => `"${(r[h] || "").toString().replace(/"/g, '""')}"`).join(","))
    ].join("\n");
    return { filename: `verified_${type}_contacts_${id}.csv`, csv };
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
