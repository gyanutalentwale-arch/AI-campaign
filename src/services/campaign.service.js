const axios = require('axios');
const XLSX = require('xlsx');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  extractTextFromContent,
  generateContentWithGoogleOauth,
  isGoogleOauthSessionValid,
} = require("./gemini-oauth.service");

module.exports = function createCampaignService({
  io,
  state,
  addLog,
  path,
  fs,
  recordModelCallUsage = () => {},
}) {
const campaigns = new Map();
const CAMPAIGN_PRESET_PATH = path.join(process.cwd(), "campaign_preset.json");
const MAX_REAL_FAILURES_BEFORE_STOP = 3;
const DEFAULT_CAMPAIGN_PRESET = {
  template: "",
  minDelaySec: 15,
  maxDelaySec: 45,
  batchSize: 15,
  useAI: false,
  aiAuthMode: "",
  imageCaption: "",
};

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeCampaignAiAuthMode(value, fallback = "api_key") {
  if (value === "google_oauth") return "google_oauth";
  if (value === "api_key") return "api_key";
  return fallback;
}

function normalizeCampaignPreset(input = {}) {
  const minDelaySec = Math.max(
    parseInt(input.minDelaySec, 10) || DEFAULT_CAMPAIGN_PRESET.minDelaySec,
    8,
  );
  const maxDelaySec = Math.max(
    parseInt(input.maxDelaySec, 10) || DEFAULT_CAMPAIGN_PRESET.maxDelaySec,
    minDelaySec + 5,
  );
  return {
    template: String(input.template || "").trim(),
    minDelaySec,
    maxDelaySec,
    batchSize: Math.min(
      Math.max(
        parseInt(input.batchSize, 10) || DEFAULT_CAMPAIGN_PRESET.batchSize,
        1,
      ),
      20,
    ),
    useAI: !!input.useAI,
    aiAuthMode: normalizeCampaignAiAuthMode(input.aiAuthMode, ""),
    imageCaption: String(input.imageCaption || "").trim(),
  };
}

function loadCampaignPreset() {
  try {
    const raw = fs.readFileSync(CAMPAIGN_PRESET_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeCampaignPreset(parsed);
  } catch (_) {
    return { ...DEFAULT_CAMPAIGN_PRESET };
  }
}

function saveCampaignPreset(input = {}) {
  const preset = normalizeCampaignPreset(input);
  fs.writeFileSync(CAMPAIGN_PRESET_PATH, JSON.stringify(preset, null, 2));
  return preset;
}

// Parse file -> { contacts: [{...allColumns}], headers: [] }
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

function parseContactsFile(buffer, mimetype, originalname) {
  const { rows, headers } = parseRowsFromFile(buffer, mimetype, originalname);
  const numCol = headers.find((h) =>
    /number|phone|mobile|contact|whatsapp|cell|ph\b|no\b|num/i.test(h),
  );
  const contacts = rows
    .map((row) => {
      const num = numCol ? normalizeRawPhoneDigits(row[numCol]) : "";
      return num.length >= 10 ? row : null;
    })
    .filter(Boolean);

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

// Normalize and format number to WhatsApp ID.
function normalizeRawPhoneDigits(value) {
  if (value === null || value === undefined) return "";
  let raw = String(value).trim();
  if (!raw) return "";

  // Sheets/Excel may output long numbers in scientific notation.
  const sci = raw.replace(/,/g, "");
  if (/^[+-]?\d*\.?\d+e[+-]?\d+$/i.test(sci)) {
    const parsed = Number(sci);
    if (Number.isFinite(parsed)) {
      raw = parsed.toLocaleString("en-US", {
        useGrouping: false,
        maximumFractionDigits: 20,
      });
    }
  }

  // Spreadsheet decimal style: 9876543210.0
  raw = raw.replace(/\.0+$/, "");
  return raw.replace(/\D/g, "");
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
  return /not on whatsapp|not a whatsapp user|invalid wid|not registered|does not exist/.test(
    text,
  );
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

async function verifyWhatsAppRecipient(botClient, waId) {
  if (!botClient?.getNumberId) {
    throw new Error("Bot client does not support WhatsApp number verification.");
  }

  try {
    const lookupId = await botClient.getNumberId(waId);
    if (!lookupId) {
      return { registered: false, waId };
    }
    return {
      registered: true,
      waId: resolveWaIdFromLookup(lookupId, waId),
    };
  } catch (error) {
    if (isNonWhatsAppError(error?.message)) {
      return { registered: false, waId };
    }
    throw new Error(
      `Pre-send verification failed: ${error?.message || String(error)}`,
    );
  }
}

// Human-like random delay with non-uniform distribution
function humanDelay(minMs, maxMs) {
  // Use gaussian-like distribution (more natural than pure random)
  const u1 = Math.random(),
    u2 = Math.random();
  const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mid = (minMs + maxMs) / 2;
  const sigma = (maxMs - minMs) / 6;
  const base = Math.min(maxMs, Math.max(minMs, mid + gaussian * sigma));

  // 15% chance: long "distraction" pause (human went away briefly)
  const spike = Math.random() < 0.15 ? 8000 + Math.random() * 20000 : 0;
  return Math.floor(base + spike);
}

// Long break between batches (simulates human taking a break)
function batchBreak(batchNum) {
  // Every batch: 45s-3min break
  const base = 45000 + Math.random() * 135000;
  // Every 3rd batch: extra long break (5-10 min)
  const extra = batchNum % 3 === 0 ? 300000 + Math.random() * 300000 : 0;
  return Math.floor(base + extra);
}

// --- AI Message Variation ---

// Tones to rotate through - each message gets a different personality
const TONES = [
  "friendly and warm",
  "professional and concise",
  "casual and conversational",
  "enthusiastic and energetic",
  "polite and formal",
  "brief and direct",
  "empathetic and helpful",
];

let toneIndex = 0;

function getEnvInt(name, fallback, minValue = null) {
  const parsed = parseInt(process.env[name], 10);
  if (Number.isNaN(parsed)) return fallback;
  return minValue !== null ? Math.max(parsed, minValue) : parsed;
}

function getEnvList(name, fallback = []) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getCampaignAIConfig() {
  return {
    enabled:
      String(process.env.WA_CAMPAIGN_AI_ENABLED || "true").toLowerCase() ===
      "true",
    model:
      process.env.WA_CAMPAIGN_AI_MODEL ||
      process.env.FALLBACK_MODEL ||
      "gemini-2.0-flash",
    maxChars: getEnvInt("WA_AI_MAX_CHARS", 1100, 400),
    minChars: getEnvInt("WA_AI_MIN_CHARS", 20, 1),
    maxParagraphs: getEnvInt("WA_AI_MAX_PARAGRAPHS", 8, 1),
    blockedTerms: getEnvList("WA_AI_BLOCKED_TERMS", [
      "as an ai",
      "i am an ai",
      "i cannot",
      "i can not",
      "language model",
      "generated message",
      "here is your message",
      "subject:",
      "dear sir/madam",
    ]),
  };
}

function createCampaignAiUsage() {
  return {
    total: 0,
    api: 0,
    googleOauth: 0,
  };
}

function getCampaignProcessedCount(campaign) {
  return (
    (Number(campaign?.sent) || 0) +
    (Number(campaign?.failed) || 0) +
    (Number(campaign?.skipped) || 0)
  );
}

function buildCampaignProgressPayload(id, campaign, extra = {}) {
  return {
    id,
    sent: campaign.sent,
    failed: campaign.failed,
    skipped: campaign.skipped || 0,
    processed: getCampaignProcessedCount(campaign),
    total: campaign.total,
    status: campaign.status,
    aiAuthMode: campaign.aiAuthMode || "api_key",
    aiUsage: { ...(campaign.aiUsage || createCampaignAiUsage()) },
    ...extra,
  };
}

function emitCampaignProgress(id, campaign, extra = {}) {
  io.emit("campaign_progress", buildCampaignProgressPayload(id, campaign, extra));
}

function trackCampaignAiUsage(campaign, mode) {
  if (!campaign) return;
  if (!campaign.aiUsage) {
    campaign.aiUsage = createCampaignAiUsage();
  }
  campaign.aiUsage.total++;
  if (mode === "google_oauth") {
    campaign.aiUsage.googleOauth++;
  } else {
    campaign.aiUsage.api++;
  }
}

function extractUrls(text) {
  return Array.from(
    new Set(String(text || "").match(/https?:\/\/[^\s)]+/g) || []),
  );
}

function extractPhoneNumbers(text) {
  return Array.from(
    new Set(
      (String(text || "").match(/(?:\+?\d[\d\s\-()]{7,}\d)/g) || []).map(
        (item) => item.replace(/\s+/g, " ").trim(),
      ),
    ),
  );
}

function extractSquarePlaceholders(text) {
  return Array.from(new Set(String(text || "").match(/\[[^\]]+\]/g) || []));
}

function normalizeTemplateForAI(rawTemplate) {
  let out = String(rawTemplate || "").replace(/\r/g, "");
  // Remove code-style wrapping around placeholders that breaks WhatsApp rendering.
  out = out.replace(
    /`{1,3}\s*\{\{([^}]+)\}\}\s*`{1,3}/g,
    (_, key) => `{{${String(key).trim()}}}`,
  );
  out = out.replace(
    /`{1,3}\s*\[([^\]]+)\]\s*`{1,3}/g,
    (_, key) => `[${String(key).trim()}]`,
  );
  // Remove accidental fenced blocks from templates.
  out = out.replace(/```+/g, "");
  return out;
}

function sanitizeAIMessage(rawText) {
  let out = String(rawText || "")
    .replace(/\r/g, "")
    .trim();
  // If model returned escaped newlines as text, convert to actual line breaks.
  if (out.includes("\\n") && !out.includes("\n"))
    out = out.replace(/\\n/g, "\n");
  // Strip optional fenced wrappers.
  out = out.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "");
  // Remove code-style wrapping around placeholders.
  out = out.replace(/`+\s*(\[[^\]]+\]|\{\{[^}]+\}\})\s*`+/g, "$1");
  // Backticks make WhatsApp text look broken in campaign messages.
  out = out.replace(/`/g, "");
  return out.trim();
}

function extractLayoutAnchors(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n");
  const anchors = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const numericMarker = trimmed.match(/^(\d+\uFE0F?\u20E3|\d+[.)])/u);
    if (numericMarker) anchors.push(`token:${numericMarker[1]}`);
    const symbolMarker = trimmed.match(/^([^\p{L}\p{N}\[\]{}()"'`*_\s])/u);
    if (symbolMarker) anchors.push(`token:${symbolMarker[1]}`);
    const platformMatch = trimmed.match(/^\*?(android|ios)\*?:/i);
    if (platformMatch)
      anchors.push(`platform:${platformMatch[1].toLowerCase()}`);
  }
  return anchors;
}

function hasCompatibleLayout(variedText, templateText) {
  const msgLines = String(variedText || "")
    .replace(/\r/g, "")
    .split("\n");
  const tplLines = String(templateText || "")
    .replace(/\r/g, "")
    .split("\n");

  if (msgLines.length !== tplLines.length) return false;

  const msgBlankPattern = msgLines.map((line) => line.trim() === "");
  const tplBlankPattern = tplLines.map((line) => line.trim() === "");
  for (let i = 0; i < tplBlankPattern.length; i++) {
    if (msgBlankPattern[i] !== tplBlankPattern[i]) return false;
  }

  const msgAnchors = extractLayoutAnchors(variedText);
  const tplAnchors = extractLayoutAnchors(templateText);
  return msgAnchors.join("|") === tplAnchors.join("|");
}

function formatForWhatsApp(text) {
  let out = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  out = out
    .split("\n")
    .map((line) => {
      const clean = line.trim();
      if (/^https?:\/\//i.test(clean)) return `-> ${clean}`;
      return line.trimEnd();
    })
    .join("\n");

  return out;
}

function isUrlOnlyLine(line) {
  return /^(?:->\s*)?https?:\/\/[^\s)]+$/i.test(String(line || "").trim());
}

function stripOuterMarkdown(text) {
  let out = String(text || "").trim();
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (const marker of ["*", "_", "~"]) {
      if (out.startsWith(marker) && out.endsWith(marker) && out.length > 2) {
        out = out.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return out;
}

function stripLeadingLayoutToken(text) {
  let out = String(text || "").trim();
  out = out.replace(/^(\d+\uFE0F?\u20E3|\d+[.)])\s*/u, "");
  out = out.replace(/^([^\p{L}\p{N}\[\]{}()"'`*_\s])\s*/u, "");
  return out.trim();
}

function expandAIMessageLines(text) {
  const expanded = [];
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      expanded.push("");
      continue;
    }

    const urls = line.match(/https?:\/\/[^\s)]+/g) || [];
    if (
      urls.length === 1 &&
      !isUrlOnlyLine(line) &&
      line.replace(urls[0], "").trim()
    ) {
      const [url] = urls;
      const before = line.replace(url, "").trim();
      if (before) expanded.push(before);
      expanded.push(url);
      continue;
    }

    expanded.push(line);
  }

  return expanded;
}

function alignLineToTemplate(candidateLine, templateLine) {
  const tpl = String(templateLine || "").trim();
  if (!tpl) return "";
  if (isUrlOnlyLine(tpl)) return tpl;

  let out = String(candidateLine || "").trim();
  if (!out) return tpl;

  const tplWrappedParen = tpl.match(/^\*\((.+)\)\*$/u);
  if (tplWrappedParen) {
    const inner = stripOuterMarkdown(out)
      .replace(/^\(+/, "")
      .replace(/\)+$/, "")
      .trim();
    return `*(${inner || tplWrappedParen[1]})*`;
  }

  const numericMarker = tpl.match(/^(\d+\uFE0F?\u20E3|\d+[.)])\s*/u);
  if (numericMarker) {
    out = `${numericMarker[1]} ${stripLeadingLayoutToken(out)}`.trim();
  }

  const symbolMarker = tpl.match(/^([^\p{L}\p{N}\[\]{}()"'`*_\s])\s*/u);
  if (symbolMarker) {
    const currentSymbol = out.match(/^([^\p{L}\p{N}\[\]{}()"'`*_\s])\s*/u);
    if (!currentSymbol || currentSymbol[1] !== symbolMarker[1]) {
      out = `${symbolMarker[1]} ${stripLeadingLayoutToken(out)}`.trim();
    }
  }

  if (/^_.*_$/u.test(tpl) && !/^_.*_$/u.test(out)) {
    out = `_${stripOuterMarkdown(out)}_`;
  } else if (/^\*.*\*$/u.test(tpl) && !/^\*.*\*$/u.test(out)) {
    out = `*${stripOuterMarkdown(out)}*`;
  }

  return out.trim();
}

function repairAIMessageLayout(variedText, templateText) {
  const tplLines = String(templateText || "")
    .replace(/\r/g, "")
    .split("\n");
  const templateNonEmpty = tplLines.filter((line) => line.trim() !== "");
  const variedNonEmpty = expandAIMessageLines(variedText).filter(
    (line) => line.trim() !== "",
  );

  if (!templateNonEmpty.length || !variedNonEmpty.length) {
    return sanitizeAIMessage(variedText);
  }

  const lineDelta = Math.abs(variedNonEmpty.length - templateNonEmpty.length);
  if (lineDelta > 2) {
    return sanitizeAIMessage(variedText);
  }

  let srcIndex = 0;
  const repaired = tplLines.map((tplLine) => {
    if (!tplLine.trim()) return "";
    const candidate = variedNonEmpty[srcIndex++] || tplLine.trim();
    return alignLineToTemplate(candidate, tplLine);
  });

  return sanitizeAIMessage(repaired.join("\n"));
}

function isSafeAIMessage(variedText, templateWithPlaceholders, config) {
  const text = String(variedText || "");
  if (!text || text.length < config.minChars || text.length > config.maxChars) {
    return { valid: false, reason: "length_out_of_bounds" };
  }

  if (/```|<script|<\/script>|<html|<\/html>/i.test(text)) {
    return { valid: false, reason: "unsafe_markup" };
  }

  if ((text.match(/\n\s*\n/g) || []).length + 1 > config.maxParagraphs) {
    return { valid: false, reason: "too_many_paragraphs" };
  }

  if (/[!?]{4,}|[.]{4,}/.test(text)) {
    return { valid: false, reason: "spammy_punctuation" };
  }

  if (/[`]/.test(text)) {
    return { valid: false, reason: "backticks_not_allowed" };
  }

  if (!hasCompatibleLayout(text, templateWithPlaceholders)) {
    return { valid: false, reason: "layout_mismatch" };
  }

  const normalized = text.toLowerCase();
  if (
    config.blockedTerms.some((term) => normalized.includes(term.toLowerCase()))
  ) {
    return { valid: false, reason: "blocked_phrase_detected" };
  }

  const mustKeepUrls = extractUrls(templateWithPlaceholders);
  const mustKeepPhones = extractPhoneNumbers(templateWithPlaceholders);
  const mustKeepPlaceholders = extractSquarePlaceholders(
    templateWithPlaceholders,
  );
  const foundUrls = extractUrls(text);
  const foundPhones = extractPhoneNumbers(text);
  const foundPlaceholders = extractSquarePlaceholders(text);

  for (const url of mustKeepUrls) {
    if (!text.includes(url)) return { valid: false, reason: "missing_url" };
  }
  if (foundUrls.some((url) => !mustKeepUrls.includes(url))) {
    return { valid: false, reason: "unexpected_url" };
  }

  for (const phone of mustKeepPhones) {
    if (!text.includes(phone)) return { valid: false, reason: "missing_phone" };
  }
  if (foundPhones.some((phone) => !mustKeepPhones.includes(phone))) {
    return { valid: false, reason: "unexpected_phone" };
  }

  for (const ph of mustKeepPlaceholders) {
    if (!text.includes(ph))
      return { valid: false, reason: "missing_placeholder" };
  }
  if (foundPlaceholders.some((ph) => !mustKeepPlaceholders.includes(ph))) {
    return { valid: false, reason: "unexpected_placeholder" };
  }

  return { valid: true, reason: "ok" };
}

// Generate one unique variation per contact - fresh every time
async function getUniqueVariation(
  templateWithPlaceholders,
  filledMsg,
  contactData,
  aiRuntime,
  campaign,
) {
  const tone = TONES[toneIndex % TONES.length];
  toneIndex++;
  const aiConfig = aiRuntime?.config || getCampaignAIConfig();
  const modelName = aiRuntime?.model || aiConfig.model;
  const authMode = aiRuntime?.mode || "api_key";

  // Build context about the recipient so AI can personalize further
  const contactContext = Object.entries(contactData)
    .filter(([k]) => !/number|phone|mobile|_status|_error|_msg/i.test(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const formattedTemplate = formatForWhatsApp(templateWithPlaceholders);

  const prompt = `You are writing a personalized WhatsApp message. Rewrite the template below in a ${tone} tone.

Rules:
- Keep ALL placeholders like [Name], [City] EXACTLY as-is - do NOT replace or translate them
- Keep ALL URLs and phone numbers EXACTLY as-is
- Use ONLY English
- Keep the SAME visual structure as template: same line count, same line order, same blank lines
- Rewrite line-by-line: each non-empty output line must match the same non-empty template line
- Never merge two template lines into one, and never split one template line into two
- Keep standalone CTA, URL, and signature lines as standalone lines
- Keep bullets/emoji starters and numbering style exactly in the same positions
- Keep Markdown emphasis style clean (bold/italic), and do NOT use backticks (\`)
- Make it feel natural and human, but only wording should change
- Keep it concise and WhatsApp-friendly (max 1100 characters)
- Use short paragraphs and clear spacing (avoid big text blocks)
- Return ONLY the final message, nothing else

Recipient context (use to make it feel personal if relevant): ${contactContext || "general user"}

Template:
${templateWithPlaceholders}`;

  try {
    const usageLabel =
      authMode === "google_oauth"
        ? `Gemini OAuth (${modelName})`
        : `Gemini API Key (${modelName})`;

    recordModelCallUsage(usageLabel, "wa_campaign_ai");
    trackCampaignAiUsage(campaign, authMode);

    const fallback = formatForWhatsApp(filledMsg);
    let rawText = "";

    if (authMode === "google_oauth") {
      const oauthResult = await generateContentWithGoogleOauth({
        accessToken: aiRuntime.googleOauth.accessToken,
        projectId: aiRuntime.googleOauth.projectId,
        model: modelName,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: {
          parts: [{ text: "Reply in plain text only with the final WhatsApp message." }],
        },
        generationConfig: {
          maxOutputTokens: parseInt(process.env.WA_AI_MAX_OUTPUT_TOKENS, 10) || 900,
        },
      });
      rawText = extractTextFromContent(oauthResult?.candidates?.[0]?.content);
    } else {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      rawText = result.response.text();
    }

    if (!rawText) {
      throw new Error("Campaign AI returned an empty response.");
    }

    const rawVaried = sanitizeAIMessage(rawText);
    let varied = formatForWhatsApp(rawVaried);
    let validation = isSafeAIMessage(varied, formattedTemplate, aiConfig);

    if (!validation.valid && validation.reason === "layout_mismatch") {
      const repaired = formatForWhatsApp(
        repairAIMessageLayout(rawVaried, formattedTemplate),
      );
      const repairedValidation = isSafeAIMessage(
        repaired,
        formattedTemplate,
        aiConfig,
      );
      if (repairedValidation.valid) {
        varied = repaired;
        validation = repairedValidation;
        addLog("info", `AI variation layout repaired via ${aiConfig.model}`);
      }
    }

    if (!validation.valid) {
      addLog(
        "warn",
        `AI variation rejected (${validation.reason}) via ${usageLabel}; fallback used`,
      );
      return fallback;
    }
    addLog("info", `AI variation accepted via ${usageLabel}`);
    return varied;
  } catch (e) {
    addLog("warn", `AI variation failed: ${e.message}`);
    return formatForWhatsApp(filledMsg);
  }
}

// Micro-variation: small random human-like tweaks on top of AI output
function microVary(text) {
  // Keep final text clean; avoid typo-like mutations in campaign mode.
  return formatForWhatsApp(String(text || ""));
}

function parseContactsFromUpload(file) {
  if (!file) throw createHttpError(400, "No file uploaded");
  const { contacts, headers, numCol } = parseContactsFile(
    file.buffer,
    file.mimetype,
    file.originalname,
  );
  if (!contacts.length) {
    throw createHttpError(
      400,
      `No valid contacts found. Columns detected: [${headers.join(", ")}]. Need a number/phone/mobile column.`,
    );
  }
  return { contacts, headers, total: contacts.length, numCol };
}

async function parseContactsFromSheet(url) {
  if (!url) throw createHttpError(400, "URL required");
  try {
    const csvUrl = getGoogleSheetCsvUrl(url);
    const response = await axios.get(csvUrl, {
      responseType: "arraybuffer",
      timeout: 10000,
    });
    const buffer = Buffer.from(response.data);
    const { contacts, headers, numCol } = parseContactsFile(
      buffer,
      "text/csv",
      "sheet.csv",
    );
    if (!contacts.length) {
      throw createHttpError(
        400,
        `No valid contacts found. Columns detected: [${headers.join(", ")}]. Need a number/phone/mobile column.`,
      );
    }
    return { contacts, headers, total: contacts.length, numCol };
  } catch (e) {
    if (e.status) throw e;
    const msg =
      e.response?.status === 403
        ? 'Sheet is private. Share it as "Anyone with the link can view".'
        : "Fetch error: " + e.message;
    throw createHttpError(500, msg);
  }
}

function buildUploadedImagePayload(file) {
  if (!file) throw createHttpError(400, "No image uploaded");
  const b64 = file.buffer.toString("base64");
  const mime = file.mimetype;
  return {
    dataUrl: `data:${mime};base64,${b64}`,
    mimetype: mime,
    originalname: file.originalname,
  };
}

function getCampaignPreset() {
  return loadCampaignPreset();
}

function saveCampaignPresetData(input = {}) {
  return saveCampaignPreset(input);
}

function resolveCampaignAiRuntime(requestedMode) {
  const aiConfig = getCampaignAIConfig();
  const mode = normalizeCampaignAiAuthMode(
    requestedMode,
    state.aiAuth?.mode === "google_oauth" ? "google_oauth" : "api_key",
  );

  return {
    mode,
    model: aiConfig.model,
    config: aiConfig,
    googleOauth: state.aiAuth?.googleOauth || null,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    hasGoogleOauthSession: isGoogleOauthSessionValid(state.aiAuth?.googleOauth),
  };
}

async function runCampaignLoop(id, campaign, payload) {
  const {
    contacts,
    template,
    minDelay,
    maxDelay,
    batchSize,
    useAI,
    aiAuthMode,
    imageDataUrl,
    imageMime,
    imageCaption,
  } = payload;

  const min = Math.max(parseInt(minDelay, 10) || 15000, 8000);
  const max = Math.max(parseInt(maxDelay, 10) || 45000, min + 5000);
  const batch = Math.min(parseInt(batchSize, 10) || 15, 20);
  const { MessageMedia } = require("whatsapp-web.js");
  const aiRuntime = resolveCampaignAiRuntime(aiAuthMode);
  const campaignAI = aiRuntime.config;
  campaign.aiAuthMode = aiRuntime.mode;

  if (useAI) {
    const modeLabel =
      aiRuntime.mode === "google_oauth" ? "Google Login" : "API Key";
    addLog(
      "info",
      `Campaign AI enabled with model ${campaignAI.model} via ${modeLabel}`,
    );
  }

  // --- Login to Talentwale API ---
  let talentwaleToken = null;
  try {
    const loginRes = await axios.post("https://production.talentwale.com/api/login", {
      email: "Dataentry3.intelliworkz@gmail.com",
      password: "Gyanu@123",
      role: "admin"
    });
    if (loginRes.data && loginRes.data.api_token) {
      talentwaleToken = loginRes.data.api_token;
      addLog("info", "Connected to Talentwale API successfully.");
    } else {
      addLog("warn", "Talentwale API login failed: No token in response.");
    }
  } catch (error) {
    addLog("warn", `Talentwale API login failed: ${error.message}`);
  }

  const checkTalentwaleCandidate = async (searchQuery) => {
    if (!talentwaleToken || !searchQuery) return false;
    try {
      const res = await axios.post("https://production.talentwale.com/api/admin/candidate/list", {
        page: 1,
        startDate: "",
        endDate: "",
        registrationBy: "",
        limit: 10,
        search: String(searchQuery)
      }, {
        headers: { "authorization": `Bearer ${talentwaleToken}` }
      });
      if (res.data && res.data.data && res.data.data.length > 0) {
        return true;
      }
    } catch (e) {
       addLog("warn", `Talentwale search error for ${searchQuery}: ${e.message}`);
    }
    return false;
  };

  // AI uses a normalized template to avoid broken code-style placeholders.
  const aiTemplate = normalizeTemplateForAI(template);
  const templateWithPlaceholders = aiTemplate.replace(
    /\{\{([^}]+)\}\}/g,
    (_, key) => `[${key.trim()}]`,
  );

  const fillPlaceholders = (tpl, contact) =>
    tpl
      .replace(/\{\{([^}]+)\}\}/g, (_, key) => {
        const k = key.trim();
        const match = Object.keys(contact).find(
          (col) => col.toLowerCase() === k.toLowerCase(),
        );
        return match !== undefined ? contact[match] : "";
      })
      .replace(/\[([^\]]+)\]/g, (_, key) => {
        const k = key.trim();
        const match = Object.keys(contact).find(
          (col) => col.toLowerCase() === k.toLowerCase(),
        );
        return match !== undefined ? contact[match] : `[${k}]`;
      });

  let batchCount = 0;
  let inBatch = 0;

  try {
    for (const contact of contacts) {
      if (campaign.status === "stopped") break;

      // Pick message: fresh AI variation per contact, or plain template
      let baseTpl;
      if (useAI) {
        // Get fresh unique variation for this specific contact
        const filledFallback = fillPlaceholders(aiTemplate, contact);
        baseTpl = await getUniqueVariation(
          templateWithPlaceholders,
          filledFallback,
          contact,
          aiRuntime,
          campaign,
        );
        baseTpl = microVary(baseTpl); // add micro human-like tweaks on top
      } else {
        baseTpl = template;
      }
      const msg = fillPlaceholders(baseTpl, contact);

      const numKey = Object.keys(contact).find((k) =>
        /number|phone|mobile|contact|whatsapp|cell|ph\b|no\b|num/i.test(k),
      );
      const rawNum = numKey ? contact[numKey] : "";
      
      const emailKey = Object.keys(contact).find((k) =>
        /email|e-mail|mail/i.test(k)
      );
      const rawEmail = emailKey ? contact[emailKey] : "";

      addLog("info", `[QUEUE] -> ${rawNum} | "${msg.substring(0, 50)}"`);

      // Check Talentwale condition BEFORE doing WhatsApp stuff
      if (talentwaleToken) {
        let skipReason = null;
        if (rawNum && await checkTalentwaleCandidate(rawNum)) {
          skipReason = `Found in Talentwale (Phone)`;
        } else if (rawEmail && await checkTalentwaleCandidate(rawEmail)) {
          skipReason = `Found in Talentwale (Email)`;
        }

        if (skipReason) {
          campaign.skipped = (campaign.skipped || 0) + 1;
          campaign.log.push({
            ...contact,
            _status: "skipped",
            _error: skipReason,
          });
          addLog("warn", `Skipped -> ${rawNum || rawEmail} - ${skipReason}`);
          inBatch++;
          emitCampaignProgress(id, campaign);
          const isLast = getCampaignProcessedCount(campaign) >= campaign.total;
          if (isLast || campaign.status === "stopped") break;
          continue;
        }
      }

      try {
        let waId = toWAId(rawNum);
        if (!waId) {
          campaign.skipped = (campaign.skipped || 0) + 1;
          campaign.log.push({
            ...contact,
            _status: "skipped",
            _error: "Invalid phone number",
          });
          addLog("warn", "Skipped " + rawNum + " - invalid phone number");
          inBatch++;
          emitCampaignProgress(id, campaign);
          const isLast = getCampaignProcessedCount(campaign) >= campaign.total;
          if (isLast || campaign.status === "stopped") break;
          continue;
        }

        const verification = await verifyWhatsAppRecipient(
          state.botClient,
          waId,
        );
        if (!verification.registered) {
          campaign.skipped = (campaign.skipped || 0) + 1;
          campaign.log.push({
            ...contact,
            _status: "skipped",
            _error: "Not on WhatsApp",
          });
          addLog("warn", "Skipped " + rawNum + " - not on WhatsApp");
          inBatch++;
          emitCampaignProgress(id, campaign);
          const isLast = getCampaignProcessedCount(campaign) >= campaign.total;
          if (isLast || campaign.status === "stopped") break;
          continue;
        }
        waId = verification.waId;

        // --- Human-like pre-send behavior ---
        // 1. Random pause before opening chat (like picking up phone)
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 2000));

        // 2. Typing duration = thinking time + actual typing time based on word count
        const wordsPerMin = 25 + Math.random() * 20; // 25-45 wpm
        const thinkTime = 1500 + Math.random() * 3000; // 1.5-4.5s
        const typeTime = Math.min(
          (msg.split(" ").length / wordsPerMin) * 60000,
          12000,
        );
        const totalTyping = Math.floor(thinkTime + typeTime);

        addLog(
          "info",
          `Typing for ${(totalTyping / 1000).toFixed(1)}s -> ${rawNum}`,
        );

        // 3. Get chat object for typing state
        let chatObj = null;
        try {
          chatObj = await state.botClient.getChatById(waId);
        } catch (_) {}

        // 4. Send typing indicator, refresh every 3.5s (WA auto-clears after 5s)
        if (chatObj) {
          try {
            await chatObj.sendStateTyping();
          } catch (_) {}
        }
        let waited = 0;
        while (waited < totalTyping) {
          const chunk = Math.min(3500, totalTyping - waited);
          await new Promise((r) => setTimeout(r, chunk));
          waited += chunk;
          if (waited < totalTyping && chatObj) {
            try {
              await chatObj.sendStateTyping();
            } catch (_) {}
          }
        }

        // 5. Small pause after finishing typing before hitting send (human hesitation)
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 500));

        // 6. Clear typing state
        try {
          if (chatObj) await chatObj.clearState();
        } catch (_) {}

        // 7. Send message
        if (imageDataUrl) {
          const media = new MessageMedia(
            imageMime,
            imageDataUrl.split(",")[1],
            "image",
          );
          await state.botClient.sendMessage(waId, media, {
            caption: fillPlaceholders(imageCaption || msg, contact),
          });
        } else {
          await state.botClient.sendMessage(waId, msg);
        }

        campaign.sent++;
        campaign.log.push({ ...contact, _status: "sent", _msg: msg });
        addLog(
          "success",
          `Sent -> ${rawNum} (${campaign.sent}/${campaign.total})`,
        );
      } catch (e) {
        const errMsg = e?.message || String(e || "Unknown error");
        if (isNonWhatsAppError(errMsg)) {
          campaign.skipped = (campaign.skipped || 0) + 1;
          campaign.log.push({
            ...contact,
            _status: "skipped",
            _error: "Not on WhatsApp",
          });
          addLog("warn", "Skipped " + rawNum + " - not on WhatsApp");
        } else {
          campaign.failed++;
          campaign.log.push({ ...contact, _status: "failed", _error: errMsg });
          addLog("error", "Failed -> " + rawNum + ": " + errMsg);
          if (campaign.failed >= MAX_REAL_FAILURES_BEFORE_STOP) {
            addLog(
              "error",
              `${MAX_REAL_FAILURES_BEFORE_STOP} real send failures reached - auto-stopping campaign to protect the WhatsApp account`,
            );
            campaign.status = "stopped";
            break;
          }
        }
      }

      inBatch++;
      emitCampaignProgress(id, campaign);

      const isLast = getCampaignProcessedCount(campaign) >= campaign.total;
      if (isLast || campaign.status === "stopped") break;

      if (inBatch >= batch) {
        batchCount++;
        inBatch = 0;
        const breakMs = batchBreak(batchCount);
        const breakMin = (breakMs / 60000).toFixed(1);
        addLog(
          "warn",
          `Batch ${batchCount} done. Anti-ban break: ${breakMin} min...`,
        );
        emitCampaignProgress(id, campaign, {
          status: `break_${breakMin}min`,
        });
        let waited = 0;
        while (waited < breakMs && campaign.status !== "stopped") {
          await new Promise((r) =>
            setTimeout(r, Math.min(10000, breakMs - waited)),
          );
          waited += 10000;
        }
      } else {
        const wait = humanDelay(min, max);
        addLog("info", `Next in ${(wait / 1000).toFixed(1)}s...`);
        // Wait in small chunks - check for pause or stop
        let waited = 0;
        while (waited < wait && campaign.status !== "stopped") {
          await new Promise((r) => setTimeout(r, Math.min(500, wait - waited)));
          waited += 500;
        }
      }
    }

    campaign.status = campaign.status === "stopped" ? "stopped" : "done";
  } catch (e) {
    campaign.status = "stopped";
    addLog("error", `Campaign aborted: ${e.message}`);
  } finally {
    state.activeCampaignId = null;
    state.campaignRecipients.clear();
    emitCampaignProgress(id, campaign, {
      status: campaign.status,
    });
    addLog(
      "info",
      `Campaign done - Sent: ${campaign.sent}, Failed: ${campaign.failed}, Skipped: ${campaign.skipped || 0}`,
    );
  }
}

function startCampaign(payload = {}) {
  const {
    contacts,
    template,
    minDelay,
    maxDelay,
    batchSize,
    useAI,
    aiAuthMode,
    imageDataUrl,
    imageMime,
    imageCaption,
  } = payload;

  if (!contacts?.length || !template) {
    throw createHttpError(400, "contacts and template required");
  }
  if (!state.botClient) {
    throw createHttpError(400, "Bot not connected. Start the bot first.");
  }

  const aiRuntime = resolveCampaignAiRuntime(aiAuthMode);
  if (useAI && !aiRuntime.config.enabled) {
    throw createHttpError(
      400,
      "Campaign AI is disabled. Enable WA_CAMPAIGN_AI_ENABLED or turn off AI Message Variation.",
    );
  }
  if (useAI && aiRuntime.mode === "google_oauth" && !aiRuntime.hasGoogleOauthSession) {
    throw createHttpError(
      400,
      "Google Login mode is selected for Campaign AI, but the Google session is missing or expired. Sign in again or switch to API Key.",
    );
  }
  if (useAI && aiRuntime.mode === "api_key" && !aiRuntime.hasApiKey) {
    throw createHttpError(
      400,
      "API Key mode is selected for Campaign AI, but GEMINI_API_KEY is missing. Add the key or switch to Google Login.",
    );
  }

  // Keep latest campaign form values persisted for quick reuse in UI.
  try {
    saveCampaignPreset({
      template,
      minDelaySec: Math.max(
        Math.round((parseInt(minDelay, 10) || 15000) / 1000),
        8,
      ),
      maxDelaySec: Math.max(
        Math.round((parseInt(maxDelay, 10) || 45000) / 1000),
        13,
      ),
      batchSize: parseInt(batchSize, 10) || 15,
      useAI: !!useAI,
      aiAuthMode: aiRuntime.mode,
      imageCaption: String(imageCaption || ""),
    });
  } catch (e) {
    addLog("warn", `Could not save campaign preset: ${e.message}`);
  }

  const id = Date.now().toString();
  const campaign = {
    id,
    status: "running",
    total: contacts.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    aiAuthMode: aiRuntime.mode,
    aiUsage: createCampaignAiUsage(),
    log: [],
  };
  campaigns.set(id, campaign);
  state.activeCampaignId = id;
  // Store plain 10-digit numbers (format-independent) so @lid vs @c.us doesn't matter
  state.campaignRecipients = new Set(
    contacts
      .map((c) => {
        const numKey = Object.keys(c).find((k) =>
          /number|phone|mobile|contact|whatsapp|cell|ph\b|no\b|num/i.test(k),
        );
        if (!numKey) return null;
        const n = normalizeRawPhoneDigits(c[numKey]);
        return n.slice(-10); // last 10 digits as key
      })
      .filter(Boolean),
  );

  void runCampaignLoop(id, campaign, {
    contacts,
    template,
    minDelay,
    maxDelay,
    batchSize,
    useAI,
    aiAuthMode: aiRuntime.mode,
    imageDataUrl,
    imageMime,
    imageCaption,
  });
  return { id, aiAuthMode: aiRuntime.mode };
}

function stopCampaign(id) {
  const campaign = campaigns.get(id);
  if (campaign) campaign.status = "stopped";
  return { ok: true };
}

function getActiveCampaign() {
  const id = state.activeCampaignId;
  if (!id) return { active: false };
  const campaign = campaigns.get(id);
  if (!campaign) return { active: false };
  return {
    active: true,
    campaign: buildCampaignProgressPayload(id, campaign),
  };
}

function getCampaignLog(id) {
  const campaign = campaigns.get(id);
  if (!campaign || !campaign.log.length) {
    throw createHttpError(404, "Not found");
  }
  const headers = [...new Set(campaign.log.flatMap((r) => Object.keys(r)))].filter(h => h !== '_msg');
  const csv = [
    headers.join(","),
    ...campaign.log.map((r) =>
      headers
        .map((h) => `"${(r[h] || "").toString().replace(/"/g, '""')}"`)
        .join(","),
    ),
  ].join("\n");
  return {
    filename: `campaign_${id}.csv`,
    csv,
  };
}

return {
  parseContactsFromUpload,
  parseContactsFromSheet,
  buildUploadedImagePayload,
  getCampaignPreset,
  saveCampaignPresetData,
  startCampaign,
  stopCampaign,
  getActiveCampaign,
  getCampaignLog,
};
};
