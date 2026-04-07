const axios = require("axios");
const nodemailer = require("nodemailer");
const dns = require("dns").promises;

module.exports = function createEmailService({
  io,
  state,
  addLog,
  path,
  fs,
}) {
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
  let emailUsageResetTimer = null;
  let emailUsageState = loadEmailUsageState();
  let emailAccounts = [];
  let activeAccountIdx = 0;

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
      return normalizeEmailPreset(
        JSON.parse(fs.readFileSync(EMAIL_PRESET_PATH, "utf8")),
      );
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
    const XLSX = require("xlsx");
    const ext = path.extname(originalname).toLowerCase();
    let rows = [];
    let headers = [];

    if (ext === ".csv" || mimetype === "text/csv") {
      const csv = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
      const lines = csv ? csv.split("\n") : [];
      if (!lines.length) return { rows: [], headers: [] };
      headers = lines[0].split(",").map((header) => header.trim().replace(/^"|"$/g, ""));
      lines.slice(1).forEach((line) => {
        const cols = line.split(",").map((col) => col.trim().replace(/^"|"$/g, ""));
        if (cols.every((col) => !col)) return;
        const row = {};
        headers.forEach((header, index) => {
          row[header] = cols[index] || "";
        });
        rows.push(row);
      });
    } else {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
      if (rows.length) headers = Object.keys(rows[0]);
    }

    return { rows, headers };
  }

  function parseEmailContactsFile(buffer, mimetype, originalname) {
    const { rows, headers } = parseRowsFromFile(buffer, mimetype, originalname);
    const emailCol = headers.find((header) => /email|mail/i.test(header));
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
    return {
      day: todayIso(),
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
      const parsed = JSON.parse(fs.readFileSync(EMAIL_USAGE_STATE_PATH, "utf8"));
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

  function saveEmailUsageState() {
    emailUsageState.activeAccountIdx = activeAccountIdx;
    fs.writeFileSync(
      EMAIL_USAGE_STATE_PATH,
      JSON.stringify(emailUsageState, null, 2),
    );
  }

  function ensureEmailUsageEntry(user) {
    if (!emailUsageState.accounts[user]) {
      emailUsageState.accounts[user] = {
        dailySent: 0,
        lastReset: todayIso(),
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

    Object.entries(emailUsageState.accounts).forEach(([user, account]) => {
      if (account.lastReset !== today) {
        account.lastReset = today;
        account.dailySent = 0;
        changed = true;
      }

      const runtimeAccount = emailAccounts.find((item) => item.user === user);
      if (runtimeAccount) {
        runtimeAccount.dailySent = account.dailySent || 0;
        runtimeAccount.lastReset = account.lastReset || today;
        runtimeAccount.totalSent = account.totalSent || 0;
        runtimeAccount.totalFailed = account.totalFailed || 0;
      }
    });

    return changed;
  }

  function loadEmailAccountsFromEnv() {
    const accounts = [];
    for (let index = 1; index <= 10; index++) {
      const user = process.env[`EMAIL_${index}_USER`];
      const pass = process.env[`EMAIL_${index}_PASSWORD`];
      const name = process.env[`EMAIL_${index}_NAME`] || "Talentwale";
      if (
        !user ||
        !pass ||
        user.includes("yourdomain") ||
        user === `your${index}@yourdomain.com`
      ) {
        continue;
      }
      accounts.push({ user, pass, name });
    }
    return accounts;
  }

  function buildEmailStats() {
    const usedToday = emailAccounts.reduce(
      (sum, account) => sum + (account.dailySent || 0),
      0,
    );
    const totalCapacity = emailAccounts.length * DAILY_LIMIT;
    const accountsAtLimit = emailAccounts.filter(
      (account) => (account.dailySent || 0) >= DAILY_LIMIT,
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
    const configuredAccounts = loadEmailAccountsFromEnv();
    emailAccounts = configuredAccounts.map((account) => {
      const usage = ensureEmailUsageEntry(account.user);
      return {
        ...account,
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

  function recordEmailSend(account) {
    ensureEmailUsageDayReset();
    const usage = ensureEmailUsageEntry(account.user);
    usage.dailySent += 1;
    usage.totalSent = (usage.totalSent || 0) + 1;
    emailUsageState.todaySent = (emailUsageState.todaySent || 0) + 1;
    emailUsageState.totalSent = (emailUsageState.totalSent || 0) + 1;
    account.dailySent = usage.dailySent;
    account.totalSent = usage.totalSent;
    saveEmailUsageState();
  }

  function recordEmailFailure(account = null) {
    ensureEmailUsageDayReset();
    emailUsageState.todayFailed = (emailUsageState.todayFailed || 0) + 1;
    emailUsageState.totalFailed = (emailUsageState.totalFailed || 0) + 1;
    if (account?.user) {
      const usage = ensureEmailUsageEntry(account.user);
      usage.totalFailed = (usage.totalFailed || 0) + 1;
      account.totalFailed = usage.totalFailed;
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
      } catch (error) {
        addLog("warn", `Could not run midnight email usage reset: ${error.message}`);
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
    for (let offset = 0; offset < emailAccounts.length; offset++) {
      const idx = (activeAccountIdx + offset) % emailAccounts.length;
      const account = emailAccounts[idx];
      if (account.dailySent < DAILY_LIMIT) {
        activeAccountIdx = idx;
        saveEmailUsageState();
        refreshEmailStats();
        return account;
      }
    }
    refreshEmailStats();
    return null;
  }

  function makeTransporter(account) {
    return nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: account.user, pass: account.pass },
    });
  }

  function getEmailProviderLimitInfo(user) {
    const domain = String(user || "").split("@")[1]?.toLowerCase() || "";
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

  function fillTpl(template, contact) {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const normalized = key.trim();
      const match = Object.keys(contact).find(
        (column) => column.toLowerCase() === normalized.toLowerCase(),
      );
      return match !== undefined ? contact[match] : "";
    });
  }

  syncEmailAccountsFromEnv();
  scheduleEmailUsageMidnightReset();

  return {
    DAILY_LIMIT,
    addLog,
    axios,
    emailCampaigns,
    fillTpl,
    getActiveAccount,
    getActiveAccountIdx: () => activeAccountIdx,
    getEmailAccounts: () => emailAccounts,
    getEmailProviderLimitInfo,
    getGoogleSheetCsvUrl,
    io,
    isValidEmail,
    loadEmailPreset,
    makeTransporter,
    parseEmailContactsFile,
    recordEmailFailure,
    recordEmailSend,
    refreshEmailStats,
    saveEmailPreset,
    saveEmailUsageState,
    setActiveAccountIdx: (nextIdx) => {
      activeAccountIdx = nextIdx;
    },
    syncEmailAccountsFromEnv,
  };
};
