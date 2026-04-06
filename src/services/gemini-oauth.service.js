const axios = require("axios");

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_OAUTH_SCOPE =
  [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/generative-language.retriever",
    "openid",
    "email",
    "profile",
  ].join(" ");
const OAUTH_EXPIRY_SKEW_MS = 15 * 1000;

function normalizeSchemaTypes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSchemaTypes(item));
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      const allowed = new Set([
        "object",
        "string",
        "number",
        "integer",
        "boolean",
        "array",
      ]);
      return allowed.has(normalized) ? normalized : value;
    }
    return value;
  }

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = normalizeSchemaTypes(child);
  }
  return next;
}

function normalizeToolsForRest(tools = []) {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") {
      return tool;
    }

    const next = { ...tool };
    if (Array.isArray(next.functionDeclarations)) {
      next.functionDeclarations = next.functionDeclarations.map((fnDecl) => ({
        ...fnDecl,
        parameters: normalizeSchemaTypes(fnDecl.parameters),
      }));
    }
    return next;
  });
}

function normalizeSystemInstruction(systemInstruction) {
  if (!systemInstruction || typeof systemInstruction !== "object") {
    return null;
  }

  if (Array.isArray(systemInstruction.parts)) {
    return { parts: systemInstruction.parts };
  }

  return null;
}

function extractTextFromContent(content) {
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractFunctionCallsFromContent(content) {
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts
    .map((part) => part?.functionCall)
    .filter(Boolean);
}

function createTextOnlyHistory(cleanHistory = [], userMessage = "", modelText = "") {
  return [
    ...cleanHistory,
    { role: "user", parts: [{ text: String(userMessage || "") }] },
    { role: "model", parts: [{ text: String(modelText || "") }] },
  ];
}

function isGoogleOauthSessionValid(session) {
  return Boolean(
    session?.accessToken &&
      session?.projectId &&
      Number(session?.expiresAt || 0) > Date.now() + OAUTH_EXPIRY_SKEW_MS,
  );
}

function getGoogleOauthPrompt(state) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const projectId =
    state?.aiAuth?.googleOauth?.projectId || process.env.GOOGLE_OAUTH_PROJECT_ID || "";

  if (!clientId || !projectId) {
    return "Save GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_PROJECT_ID first.";
  }

  if (!isGoogleOauthSessionValid(state?.aiAuth?.googleOauth)) {
    return "Google login is configured. Sign in and run a Gemini test.";
  }

  if (
    !String(state?.aiAuth?.googleOauth?.grantedScope || "").includes(
      "https://www.googleapis.com/auth/generative-language.retriever",
    )
  ) {
    return "Google login succeeded, but the Gemini scope is missing. Sign in again after updating the OAuth consent screen scopes.";
  }

  return "";
}

function getGoogleOauthPublicState(state) {
  const session = state?.aiAuth?.googleOauth || {};
  const signedIn = isGoogleOauthSessionValid(session);
  const projectId = session.projectId || process.env.GOOGLE_OAUTH_PROJECT_ID || "";

  return {
    mode: state?.aiAuth?.mode === "google_oauth" ? "google_oauth" : "api_key",
    googleOauth: {
      scope: GOOGLE_OAUTH_SCOPE,
      configured: {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
        projectId,
        ready: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && projectId),
      },
      signedIn,
      expiresAt: signedIn ? Number(session.expiresAt) : null,
      email: signedIn ? session.email || "" : "",
      name: signedIn ? session.name || "" : "",
      picture: signedIn ? session.picture || "" : "",
      grantedScope: signedIn ? session.grantedScope || "" : "",
      prompt: getGoogleOauthPrompt(state),
    },
  };
}

async function fetchGoogleUserProfile(accessToken) {
  const response = await axios.get(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return response.data || {};
}

async function generateContentWithGoogleOauth({
  accessToken,
  projectId,
  model,
  contents,
  systemInstruction,
  tools,
  generationConfig,
}) {
  try {
    const response = await axios.post(
      `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(Array.isArray(tools) && tools.length
          ? { tools: normalizeToolsForRest(tools) }
          : {}),
        ...(generationConfig ? { generationConfig } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "x-goog-user-project": projectId,
        },
      },
    );

    return response.data;
  } catch (error) {
    const apiMessage =
      error?.response?.data?.error?.message ||
      error?.response?.data?.error?.status ||
      error?.message ||
      "Google OAuth Gemini request failed.";
    const wrapped = new Error(apiMessage);
    wrapped.status = error?.response?.status || error?.status;
    wrapped.payload = error?.response?.data || null;
    throw wrapped;
  }
}

async function runGeminiOAuthChat({
  accessToken,
  projectId,
  modelName,
  cleanHistory,
  userMessage,
  systemInstruction,
  tools,
  generationConfig,
  executeFunctionCall,
}) {
  const contents = [
    ...(Array.isArray(cleanHistory) ? cleanHistory : []),
    { role: "user", parts: [{ text: String(userMessage || "") }] },
  ];

  const normalizedSystemInstruction =
    normalizeSystemInstruction(systemInstruction);
  const firstResponse = await generateContentWithGoogleOauth({
    accessToken,
    projectId,
    model: modelName,
    contents,
    systemInstruction: normalizedSystemInstruction,
    tools,
    generationConfig,
  });

  const firstCandidate = firstResponse?.candidates?.[0];
  if (!firstCandidate?.content) {
    throw new Error(
      firstResponse?.promptFeedback?.blockReason ||
        "Gemini returned no response candidates.",
    );
  }

  const functionCalls = extractFunctionCallsFromContent(firstCandidate.content);
  if (!functionCalls.length) {
    const text = extractTextFromContent(firstCandidate.content);
    return {
      text,
      newHistory: createTextOnlyHistory(cleanHistory, userMessage, text),
      rawResponse: firstResponse,
    };
  }

  const functionResponseParts = [];
  for (const call of functionCalls) {
    const result = await executeFunctionCall(call);
    const functionResponse = {
      name: call.name,
      response:
        result && typeof result === "object" ? result : { result: result ?? null },
    };
    if (call.id) {
      functionResponse.id = call.id;
    }
    functionResponseParts.push({ functionResponse });
  }

  const secondContents = [
    ...contents,
    firstCandidate.content,
    { role: "user", parts: functionResponseParts },
  ];

  const secondResponse = await generateContentWithGoogleOauth({
    accessToken,
    projectId,
    model: modelName,
    contents: secondContents,
    systemInstruction: normalizedSystemInstruction,
    tools,
    generationConfig,
  });

  const secondCandidate = secondResponse?.candidates?.[0];
  if (!secondCandidate?.content) {
    throw new Error(
      secondResponse?.promptFeedback?.blockReason ||
        "Gemini returned no final response after function execution.",
    );
  }

  const text = extractTextFromContent(secondCandidate.content);
  return {
    text,
    newHistory: createTextOnlyHistory(cleanHistory, userMessage, text),
    rawResponse: secondResponse,
  };
}

module.exports = {
  GOOGLE_OAUTH_SCOPE,
  extractTextFromContent,
  extractFunctionCallsFromContent,
  fetchGoogleUserProfile,
  generateContentWithGoogleOauth,
  getGoogleOauthPublicState,
  isGoogleOauthSessionValid,
  runGeminiOAuthChat,
};
