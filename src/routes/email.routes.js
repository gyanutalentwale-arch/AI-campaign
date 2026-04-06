const multer = require("multer");
const axios = require("axios");
const XLSX = require("xlsx");
const nodemailer = require("nodemailer");
const dns = require("dns").promises;
const createEmailController = require("../controllers/email.controller");

const upload = multer({ storage: multer.memoryStorage() });

module.exports = function (app, io, state, addLog, path, fs) {
  const emailCampaigns = new Map();
  const mxCache = new Map();

  const EMAIL_PRESET_PATH = path.join(process.cwd(), "email_preset.json");
  const EMAIL_USAGE_STATE_PATH = path.join(
    process.cwd(),
    "email_usage_state.json",
  );
  const DEFAULT_EMAIL_PRESET = {
    subject: "",
    template: "",
    delaySec: 5,
  };
  const DAILY_LIMIT = parseInt(process.env.EMAIL_DAILY_LIMIT, 10) || 2000;

  function normalizeEmailPreset(input = {}) {
    return {
      subject: String(input.subject || "").trim(),
      template: String(input.template || ""),
      delaySec: Math.min(
        Math.max(
          parseInt(input.delaySec, 10) || DEFAULT_EMAIL_PRESET.delaySec,
          1,
        ),
        300,
      ),
    };
  }

  function loadEmailPreset() {
    try {
      const raw = fs.readFileSync(EMAIL_PRESET_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeEmailPreset(parsed);
    } catch (_) {
      return { ...DEFAULT_EMAIL_PRESET };
    }
  }

  function saveEmailPreset(input = {}) {
    const preset = normalizeEmailPreset(input);
    fs.writeFileSync(EMAIL_PRESET_PATH, JSON.stringify(preset, null, 2));
    return preset;
  }

  function parseRowsFromFile(buffer, mimetype, originalname) {
    const ext = path.extname(originalname).toLowerCase();
    let rows = [];
    let headers = [];

    if (ext === ".csv" || mimetype === "text/csv") {
      const csv = buffer
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      const lines = csv ? csv.split("\n") : [];
      if (!lines.length) return { rows: [], headers: [] };
      headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      lines.slice(1).forEach((line) => {
        const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        if (cols.every((c) => !c)) return;
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = cols[i] || "";
        });
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

  function parseEmailContactsFile(buffer, mimetype, originalname) {
    const { rows, headers } = parseRowsFromFile(buffer, mimetype, originalname);
    const emailCol = headers.find((h) => /email|mail/i.test(h));
    const contacts = rows
      .map((row) => {
        const email = emailCol ? String(row[emailCol] || "").trim() : "";
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? row : null;
      })
      .filter(Boolean);

    return { contacts, headers, emailCol };
  }

  function getGoogleSheetCsvUrl(url) {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("Invalid Google Sheets URL");
    const sheetId = match[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  }

  function todayIso() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function createDefaultEmailUsageState() {
    const today = todayIso();
    return {
      day: today,
      activeAccountIdx: 0,
      totalSent: 0,
      totalFailed: 0,
      todaySent: 0,
      todayFailed: 0,
      accounts: {},
    };
  }

  function loadEmailUsageState() {
    try {
      const raw = fs.readFileSync(EMAIL_USAGE_STATE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...createDefaultEmailUsageState(),
        ...parsed,
        accounts:
          parsed.accounts && typeof parsed.accounts === "object"
            ? parsed.accounts
            : {},
      };
    } catch (_) {
      return createDefaultEmailUsageState();
    }
  }

  let emailUsageState = loadEmailUsageState();
  let emailAccounts = [];
  let activeAccountIdx = 0;
  let emailUsageResetTimer = null;

  function saveEmailUsageState() {
    emailUsageState.activeAccountIdx = activeAccountIdx;
    fs.writeFileSync(
      EMAIL_USAGE_STATE_PATH,
      JSON.stringify(emailUsageState, null, 2),
    );
  }

  function ensureEmailUsageEntry(user) {
    const today = todayIso();
    if (!emailUsageState.accounts[user]) {
      emailUsageState.accounts[user] = {
        dailySent: 0,
        lastReset: today,
        totalSent: 0,
        totalFailed: 0,
      };
    }
    return emailUsageState.accounts[user];
  }

  function ensureEmailUsageDayReset() {
    const today = todayIso();
    let changed = false;
    if (emailUsageState.day !== today) {
      emailUsageState.day = today;
      emailUsageState.todaySent = 0;
      emailUsageState.todayFailed = 0;
      changed = true;
    }
    Object.entries(emailUsageState.accounts).forEach(([user, acc]) => {
      if (acc.lastReset !== today) {
        acc.lastReset = today;
        acc.dailySent = 0;
        changed = true;
      }
      const runtimeAcc = emailAccounts.find((a) => a.user === user);
      if (runtimeAcc) {
        runtimeAcc.dailySent = acc.dailySent || 0;
        runtimeAcc.lastReset = acc.lastReset || today;
        runtimeAcc.totalSent = acc.totalSent || 0;
        runtimeAcc.totalFailed = acc.totalFailed || 0;
      }
    });
    return changed;
  }

  function loadEmailAccountsFromEnv() {
    const accounts = [];
    for (let i = 1; i <= 10; i++) {
      const user = process.env[`EMAIL_${i}_USER`];
      const pass = process.env[`EMAIL_${i}_PASSWORD`];
      const name = process.env[`EMAIL_${i}_NAME`] || "Talentwale";
      if (
        !user ||
        !pass ||
        user.includes("yourdomain") ||
        user === `your${i}@yourdomain.com`
      ) {
        continue;
      }
      accounts.push({ user, pass, name });
    }
    return accounts;
  }

  function buildEmailStats() {
    const usedToday = emailAccounts.reduce(
      (sum, a) => sum + (a.dailySent || 0),
      0,
    );
    const totalCapacity = emailAccounts.length * DAILY_LIMIT;
    const accountsAtLimit = emailAccounts.filter(
      (a) => (a.dailySent || 0) >= DAILY_LIMIT,
    ).length;
    return {
      totalSent: emailUsageState.totalSent || 0,
      totalFailed: emailUsageState.totalFailed || 0,
      todaySent: emailUsageState.todaySent || 0,
      todayFailed: emailUsageState.todayFailed || 0,
      accountsConfigured: emailAccounts.length,
      accountsAtLimit,
      activeAccount: emailAccounts[activeAccountIdx]?.user || "-",
      dailyLimit: DAILY_LIMIT,
      remainingToday: Math.max(totalCapacity - usedToday, 0),
    };
  }

  function refreshEmailStats(emit = true) {
    const changed = ensureEmailUsageDayReset();
    if (changed) saveEmailUsageState();
    state.emailStats = buildEmailStats();
    if (emit) io.emit("email_stats", state.emailStats);
  }

  function syncEmailAccountsFromEnv() {
    ensureEmailUsageDayReset();
    const configured = loadEmailAccountsFromEnv();
    emailAccounts = configured.map((acc) => {
      const usage = ensureEmailUsageEntry(acc.user);
      return {
        ...acc,
        dailySent: usage.dailySent || 0,
        lastReset: usage.lastReset || todayIso(),
        totalSent: usage.totalSent || 0,
        totalFailed: usage.totalFailed || 0,
      };
    });

    if (!emailAccounts.length) {
      activeAccountIdx = 0;
      saveEmailUsageState();
      refreshEmailStats(false);
      return;
    }

    const savedIdx = parseInt(emailUsageState.activeAccountIdx, 10);
    activeAccountIdx = Number.isInteger(savedIdx)
      ? Math.min(Math.max(savedIdx, 0), emailAccounts.length - 1)
      : 0;
    saveEmailUsageState();
    refreshEmailStats(false);
  }

  function recordEmailSend(acc) {
    ensureEmailUsageDayReset();
    const usage = ensureEmailUsageEntry(acc.user);
    usage.dailySent += 1;
    usage.totalSent = (usage.totalSent || 0) + 1;
    emailUsageState.todaySent = (emailUsageState.todaySent || 0) + 1;
    emailUsageState.totalSent = (emailUsageState.totalSent || 0) + 1;
    acc.dailySent = usage.dailySent;
    acc.totalSent = usage.totalSent;
    saveEmailUsageState();
  }

  function recordEmailFailure(acc = null) {
    ensureEmailUsageDayReset();
    emailUsageState.todayFailed = (emailUsageState.todayFailed || 0) + 1;
    emailUsageState.totalFailed = (emailUsageState.totalFailed || 0) + 1;
    if (acc && acc.user) {
      const usage = ensureEmailUsageEntry(acc.user);
      usage.totalFailed = (usage.totalFailed || 0) + 1;
      acc.totalFailed = usage.totalFailed;
    }
    saveEmailUsageState();
  }

  function millisecondsUntilNextMidnight() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return Math.max(next.getTime() - now.getTime(), 1000);
  }

  function scheduleEmailUsageMidnightReset() {
    if (emailUsageResetTimer) clearTimeout(emailUsageResetTimer);
    emailUsageResetTimer = setTimeout(() => {
      try {
        const changed = ensureEmailUsageDayReset();
        if (changed) {
          saveEmailUsageState();
          refreshEmailStats();
          addLog("info", "Email daily limit reset for all accounts (00:00).");
        } else {
          refreshEmailStats();
        }
      } catch (e) {
        addLog("warn", `Could not run midnight email usage reset: ${e.message}`);
      } finally {
        scheduleEmailUsageMidnightReset();
      }
    }, millisecondsUntilNextMidnight());

    if (typeof emailUsageResetTimer.unref === "function") {
      emailUsageResetTimer.unref();
    }
  }

  function getActiveAccount() {
    ensureEmailUsageDayReset();
    for (let i = 0; i < emailAccounts.length; i++) {
      const idx = (activeAccountIdx + i) % emailAccounts.length;
      const acc = emailAccounts[idx];
      if (acc.dailySent < DAILY_LIMIT) {
        activeAccountIdx = idx;
        saveEmailUsageState();
        refreshEmailStats();
        return acc;
      }
    }
    refreshEmailStats();
    return null;
  }

  function makeTransporter(acc) {
    return nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: acc.user, pass: acc.pass },
    });
  }

  function getEmailProviderLimitInfo(user) {
    const domain =
      String(user || "")
        .split("@")[1]
        ?.toLowerCase() || "";
    const overrideLimit = parseInt(
      process.env.EMAIL_PROVIDER_DAILY_LIMIT || "",
      10,
    );
    if (!Number.isNaN(overrideLimit) && overrideLimit > 0) {
      return {
        estimatedDailyLimit: overrideLimit,
        source: "env_override",
        note: "Using EMAIL_PROVIDER_DAILY_LIMIT from .env as provider limit estimate.",
        exactAvailable: false,
      };
    }

    if (!domain) {
      return {
        estimatedDailyLimit: null,
        source: "unknown",
        note: "Could not detect provider from email domain.",
        exactAvailable: false,
      };
    }

    if (domain === "gmail.com" || domain === "googlemail.com") {
      return {
        estimatedDailyLimit: 500,
        source: "gmail_personal_estimate",
        note: "Estimated personal Gmail daily limit. Provider can change this at any time.",
        exactAvailable: false,
      };
    }

    return {
      estimatedDailyLimit: 2000,
      source: "google_workspace_estimate",
      note: "Estimated Google Workspace daily limit on smtp.gmail.com. Exact remaining quota is not exposed by SMTP.",
      exactAvailable: false,
    };
  }

  async function isValidEmail(email) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { valid: false, reason: "Invalid format" };
    }
    const domain = email.split("@")[1].toLowerCase();
    if (mxCache.has(domain)) {
      return mxCache.get(domain)
        ? { valid: true }
        : { valid: false, reason: "No MX record" };
    }
    try {
      const records = await dns.resolveMx(domain);
      const hasMx = records && records.length > 0;
      mxCache.set(domain, hasMx);
      return hasMx
        ? { valid: true }
        : { valid: false, reason: "No MX record - domain cannot receive email" };
    } catch (_) {
      mxCache.set(domain, false);
      return { valid: false, reason: `Domain not found: ${domain}` };
    }
  }

  const fillTpl = (tpl, contact) =>
    tpl.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const k = key.trim();
      const match = Object.keys(contact).find(
        (c) => c.toLowerCase() === k.toLowerCase(),
      );
      return match !== undefined ? contact[match] : "";
    });

  syncEmailAccountsFromEnv();
  scheduleEmailUsageMidnightReset();
  const emailController = createEmailController({
    axios,
    addLog,
    io,
    DAILY_LIMIT,
    emailCampaigns,
    parseEmailContactsFile,
    getGoogleSheetCsvUrl,
    syncEmailAccountsFromEnv,
    getEmailAccounts: () => emailAccounts,
    getEmailProviderLimitInfo,
    makeTransporter,
    loadEmailPreset,
    saveEmailPreset,
    isValidEmail,
    recordEmailFailure,
    getActiveAccount,
    fillTpl,
    recordEmailSend,
    refreshEmailStats,
    getActiveAccountIdx: () => activeAccountIdx,
    setActiveAccountIdx: (nextIdx) => {
      activeAccountIdx = nextIdx;
    },
    saveEmailUsageState,
  });

  app.post("/api/email/parse", upload.single("file"), emailController.parseFile);
  app.post("/api/email/parse-sheet", emailController.parseSheet);
  app.get("/api/email/test", emailController.testAccounts);
  app.get("/api/email/accounts", emailController.listAccounts);
  app.get("/api/email/preset", emailController.getPreset);
  app.post("/api/email/preset", emailController.savePreset);
  app.post("/api/email/start", emailController.startCampaign);
  app.post("/api/email/stop/:id", emailController.stopCampaign);
  app.get("/api/email/:id/log", emailController.downloadLog);
};
