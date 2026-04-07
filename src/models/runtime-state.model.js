const fs = require("fs");
const path = require("path");
const { isGoogleOauthSessionValid } = require("../services/gemini-oauth.service");

const RUNTIME_STATE_PATH = path.join(process.cwd(), "data", "runtime_state.json");

function getDefaultGeminiAuthMode() {
  return process.env.GEMINI_AUTH_MODE === "google_oauth"
    ? "google_oauth"
    : "api_key";
}

function createEmptyGoogleOauthSession(projectId = "") {
  return {
    accessToken: "",
    expiresAt: 0,
    email: "",
    name: "",
    picture: "",
    grantedScope: "",
    projectId: String(
      projectId || process.env.GOOGLE_OAUTH_PROJECT_ID || "",
    ).trim(),
  };
}

function sanitizeGoogleOauthSession(session = {}) {
  return {
    ...createEmptyGoogleOauthSession(session?.projectId),
    accessToken: String(session?.accessToken || "").trim(),
    expiresAt: Number(session?.expiresAt || 0),
    email: String(session?.email || "").trim(),
    name: String(session?.name || "").trim(),
    picture: String(session?.picture || "").trim(),
    grantedScope: String(session?.grantedScope || "").trim(),
    projectId: String(
      session?.projectId || process.env.GOOGLE_OAUTH_PROJECT_ID || "",
    ).trim(),
  };
}

function loadRuntimeState() {
  try {
    const raw = fs.readFileSync(RUNTIME_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const persistedGoogleOauth = sanitizeGoogleOauthSession(
      parsed?.aiAuth?.googleOauth,
    );
    const hasValidGoogleOauth = isGoogleOauthSessionValid(persistedGoogleOauth);
    const persistedMode =
      parsed?.aiAuth?.mode === "google_oauth"
        ? "google_oauth"
        : parsed?.aiAuth?.mode === "api_key"
          ? "api_key"
          : getDefaultGeminiAuthMode();

    return {
      autoReply: !!parsed.autoReply,
      aiAuth: {
        mode:
          persistedMode === "google_oauth" && hasValidGoogleOauth
            ? "google_oauth"
            : "api_key",
        googleOauth: hasValidGoogleOauth
          ? persistedGoogleOauth
          : createEmptyGoogleOauthSession(persistedGoogleOauth.projectId),
      },
    };
  } catch (_) {
    return {
      autoReply: false,
      aiAuth: {
        mode: "api_key",
        googleOauth: createEmptyGoogleOauthSession(),
      },
    };
  }
}

function saveRuntimeState(runtimeState = {}) {
  try {
    const googleOauth = sanitizeGoogleOauthSession(
      runtimeState?.aiAuth?.googleOauth,
    );
    const hasValidGoogleOauth = isGoogleOauthSessionValid(googleOauth);

    fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      RUNTIME_STATE_PATH,
      JSON.stringify(
        {
          autoReply: !!runtimeState.autoReply,
          aiAuth: {
            mode:
              runtimeState?.aiAuth?.mode === "google_oauth" && hasValidGoogleOauth
                ? "google_oauth"
                : "api_key",
            googleOauth: hasValidGoogleOauth
              ? googleOauth
              : createEmptyGoogleOauthSession(googleOauth.projectId),
          },
        },
        null,
        2,
      ),
    );
  } catch (_) {}
}

module.exports = {
  RUNTIME_STATE_PATH,
  createEmptyGoogleOauthSession,
  getDefaultGeminiAuthMode,
  loadRuntimeState,
  saveRuntimeState,
  sanitizeGoogleOauthSession,
};
