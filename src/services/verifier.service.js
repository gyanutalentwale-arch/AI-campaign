const axios = require('axios');
const XLSX = require('xlsx');
const createTalentwaleCandidateService = require("./talentwale-candidate.service");

module.exports = function createVerifierService({
  io,
  state,
  addLog,
  talentwaleCandidateService = createTalentwaleCandidateService({ addLog }),
}) {
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

  function findContactColumn(contact, pattern) {
    return Object.keys(contact || {}).find((key) => pattern.test(key));
  }

  function normalizeEmailValue(value) {
    return String(value || "").trim().toLowerCase();
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

  function getProcessedCount(job) {
    return (job.valid || 0) + (job.skipped || 0) + (job.invalid || 0) + (job.failed || 0);
  }

  function buildJobSummary(job) {
    return {
      id: job.id,
      status: job.status,
      total: job.total,
      valid: job.valid,
      skipped: job.skipped,
      invalid: job.invalid,
      failed: job.failed,
      processed: getProcessedCount(job),
      useTalentwaleVerification: !!job.useTalentwaleVerification,
    };
  }

  function buildVerifierRecord(contact, status, extra = {}) {
    const row = {
      ...contact,
      Verification_Status: status,
      ...extra,
    };
    const reason = row.Verification_Reason || row.Verification_Error || "";
    if (reason) {
      row.Verification_Error = reason;
      row.Verification_Reason = reason;
    }
    return row;
  }

  function emitJobProgress(id, job) {
    io.emit("verifier_progress", buildJobSummary({ ...job, id }));
  }

  function getReadyVerifierClient() {
    if (state.botStatus === "ready" && state.botClient) {
      return state.botClient;
    }
    return null;
  }

  async function runJobLoop(id, job) {
    if (job.loopRunning) return;

    job.loopRunning = true;
    const isResume = job.nextIndex > 0;
    addLog(
      "info",
      isResume
        ? `Bulk verification resumed from ${job.nextIndex + 1}/${job.total}.`
        : `Bulk verification started for ${job.total} numbers.`,
    );
    emitJobProgress(id, job);

    try {
      while (job.nextIndex < job.contacts.length) {
        if (job.status === "paused" || job.status === "stopped") {
          return;
        }

        const contact = job.contacts[job.nextIndex];
        const numCol = findContactColumn(contact, /number|phone|mobile|contact|whatsapp|cell|no\b|num/i) || Object.keys(contact)[0];
        const emailCol = findContactColumn(contact, /email|mail/i);
        const rawNum = contact[numCol];
        const rawEmail = emailCol ? contact[emailCol] : "";
        const normalizedNum = normalizeRawPhoneDigits(rawNum);
        const last10Digits = normalizedNum.slice(-10);
        const normalizedEmail = normalizeEmailValue(rawEmail);
        const waId = toWAId(rawNum);

        try {
          if (job.useTalentwaleVerification && job.talentwaleSession) {
            const talentwaleMatch = typeof job.talentwaleSession.findCandidate === "function"
              ? await job.talentwaleSession.findCandidate({ phone: last10Digits, email: normalizedEmail })
              : (await job.talentwaleSession.hasCandidate({ phone: last10Digits, email: normalizedEmail }))
                ? { found: true, matchType: normalizedEmail ? "phone_or_email" : "phone", candidate: {} }
                : null;

            if (talentwaleMatch?.found) {
              const matchType = talentwaleMatch.matchType || "phone";
              const matchLabel = matchType === "email" ? "Email" : "Phone";
              job.skipped++;
              job.skippedContacts.push(buildVerifierRecord(contact, "Skipped", {
                Talentwale_Status: "Found",
                Talentwale_Match_Type: matchType,
                Talentwale_Candidate_Id: talentwaleMatch.candidate?.id || "",
                Talentwale_Candidate_Name: talentwaleMatch.candidate?.name || "",
                Talentwale_Candidate_Phone: talentwaleMatch.candidate?.phone || last10Digits,
                Talentwale_Candidate_Email: talentwaleMatch.candidate?.email || "",
                Verification_Reason: `Found in Talentwale (${matchLabel})`,
              }));
              addLog("warn", `Skipped ${rawNum || normalizedEmail || "record"} - found in Talentwale by ${matchLabel.toLowerCase()}.`);
              job.nextIndex++;
              emitJobProgress(id, job);
              continue;
            }
          }

          if (!normalizedNum || !waId) {
            job.invalid++;
            job.invalidContacts.push(buildVerifierRecord(contact, "Invalid", {
              Verification_Reason: "Invalid phone number",
            }));
            job.nextIndex++;
            emitJobProgress(id, job);
            continue;
          }

          const verifierClient = getReadyVerifierClient();
          if (!verifierClient) {
            if (job.useTalentwaleVerification) {
              job.failed++;
              job.failedContacts.push(buildVerifierRecord(contact, "Failed", {
                Talentwale_Status: "Not Found",
                Verification_Reason: "WhatsApp not connected for fallback verification",
              }));
              addLog("warn", `Verification failed for ${rawNum}: WhatsApp not connected for fallback verification`);
              job.nextIndex++;
              emitJobProgress(id, job);
              continue;
            }

            job.status = "stopped";
            state.activeVerifierId = null;
            state.lastVerifierJobId = id;
            addLog("error", "Verifier stopped - WhatsApp not connected.");
            emitJobProgress(id, job);
            return;
          }

          const verification = await verifyWhatsAppRecipient(verifierClient, waId);
          if (verification.registered) {
            job.valid++;
            job.validContacts.push(buildVerifierRecord(contact, "Valid", {
              WhatsApp_Status: "Available",
              ...(job.useTalentwaleVerification ? { Talentwale_Status: "Not Found" } : {}),
            }));
          } else {
            job.invalid++;
            job.invalidContacts.push(buildVerifierRecord(contact, "Invalid", {
              ...(job.useTalentwaleVerification ? { Talentwale_Status: "Not Found" } : {}),
              Verification_Reason: "Not on WhatsApp",
            }));
          }
        } catch (err) {
          job.failed++;
          job.failedContacts.push(buildVerifierRecord(contact, "Failed", {
            Verification_Reason: `Failed: ${err.message}`,
          }));
          addLog('warn', `Verification failed for ${rawNum}: ${err.message}`);
        }

        job.nextIndex++;
        emitJobProgress(id, job);

        if (job.status === "paused" || job.status === "stopped") {
          return;
        }

        if (job.nextIndex < job.contacts.length) {
          await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 400));
        }
      }

      if (job.status === "running") {
        job.status = "done";
        state.activeVerifierId = null;
        state.lastVerifierJobId = id;
        addLog('success', `Verification finished! Valid: ${job.valid}/${job.total}`);
        emitJobProgress(id, job);
      }
    } finally {
      job.loopRunning = false;
    }
  }

  function normalizeStartPayload(input) {
    if (Array.isArray(input)) {
      return {
        contacts: input,
        useTalentwaleVerification: false,
      };
    }
    return {
      contacts: Array.isArray(input?.contacts) ? input.contacts : [],
      useTalentwaleVerification: !!input?.useTalentwaleVerification,
    };
  }

  async function startJob(input) {
    const { contacts, useTalentwaleVerification } = normalizeStartPayload(input);
    if (!Array.isArray(contacts) || !contacts.length) {
      throw createHttpError(400, "No contacts provided");
    }

    const activeJob = state.activeVerifierId ? jobs.get(state.activeVerifierId) : null;
    if (activeJob && (activeJob.status === "running" || activeJob.status === "paused")) {
      throw createHttpError(
        409,
        activeJob.status === "paused"
          ? "A verification job is paused. Resume or stop it before starting a new one."
          : "A verification job is already running.",
      );
    }

    if (!useTalentwaleVerification && !getReadyVerifierClient()) {
      throw createHttpError(400, "Connect WhatsApp first before starting verification.");
    }

    let talentwaleSession = null;
    if (useTalentwaleVerification) {
      try {
        talentwaleSession = await talentwaleCandidateService.createSession();
      } catch (error) {
        throw createHttpError(500, `Talentwale verification login failed: ${error.message}`);
      }
    }

    const id = Date.now().toString();
    const job = {
      id,
      status: "running",
      total: contacts.length,
      valid: 0,
      skipped: 0,
      invalid: 0,
      failed: 0,
      nextIndex: 0,
      loopRunning: false,
      useTalentwaleVerification,
      contacts,
      talentwaleSession,
      validContacts: [],
      invalidContacts: [],
      skippedContacts: [],
      failedContacts: [],
    };
    jobs.set(id, job);
    state.activeVerifierId = id;
    state.lastVerifierJobId = id;

    void runJobLoop(id, job);
    return buildJobSummary(job);
  }

  function pauseJob(id) {
    const job = jobs.get(id);
    if (!job) throw createHttpError(404, "No verification job found");
    if (job.status !== "running") {
      throw createHttpError(409, "Only a running verification job can be paused.");
    }

    job.status = "paused";
    addLog("info", "Bulk verification paused.");
    emitJobProgress(id, job);
    return { ok: true, job: buildJobSummary(job) };
  }

  async function resumeJob(id) {
    const job = jobs.get(id);
    if (!job) throw createHttpError(404, "No verification job found");
    if (job.status !== "paused") {
      throw createHttpError(409, "Only a paused verification job can be resumed.");
    }

    if (job.useTalentwaleVerification) {
      try {
        job.talentwaleSession = await talentwaleCandidateService.createSession();
      } catch (error) {
        throw createHttpError(500, `Talentwale verification login failed: ${error.message}`);
      }
    }

    job.status = "running";
    state.activeVerifierId = id;
    emitJobProgress(id, job);
    void runJobLoop(id, job);
    return { ok: true, job: buildJobSummary(job) };
  }

  function stopJob(id) {
    const job = jobs.get(id);
    if (!job) throw createHttpError(404, "No verification job found");
    if (job.status === "done" || job.status === "stopped") {
      return { ok: true, job: buildJobSummary(job) };
    }

    job.status = "stopped";
    state.activeVerifierId = null;
    state.lastVerifierJobId = id;
    addLog("info", "Bulk verification stopped.");
    emitJobProgress(id, job);
    return { ok: true, job: buildJobSummary(job) };
  }

  function getActiveJob() {
    const activeId = state.activeVerifierId;
    const activeJob = activeId ? jobs.get(activeId) : null;
    if (activeJob) {
      return {
        active: activeJob.status === "running" || activeJob.status === "paused",
        job: buildJobSummary(activeJob),
      };
    }

    const lastId = state.lastVerifierJobId;
    const lastJob = lastId ? jobs.get(lastId) : null;
    if (!lastJob) return { active: false };
    return {
      active: false,
      job: buildJobSummary(lastJob),
    };
  }

  function getJobLog(id, type = 'valid') {
    const job = jobs.get(id);
    if (!job) throw createHttpError(404, "No verification job found");

    let targetContacts = [];
    if (type === "valid") targetContacts = job.validContacts;
    else if (type === "invalid") targetContacts = job.invalidContacts;
    else if (type === "skipped") targetContacts = job.skippedContacts;
    else if (type === "failed") targetContacts = job.failedContacts;
    else if (type === "all") {
      targetContacts = [
        ...job.validContacts,
        ...job.skippedContacts,
        ...job.invalidContacts,
        ...job.failedContacts,
      ];
    } else {
      throw createHttpError(400, `Unsupported log type: ${type}`);
    }

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
    pauseJob,
    resumeJob,
    stopJob,
    getActiveJob,
    getJobLog
  };
};
