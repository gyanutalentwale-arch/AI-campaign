const {
  sanitizeGoogleOauthSession,
} = require("./runtime-state.model");

function createEmptyMessageStats() {
  return {
    total: 0,
    today: 0,
    gemini: 0,
    openai: 0,
    api: 0,
    googleOauth: 0,
  };
}

function createEmptyEmailStats() {
  return {
    totalSent: 0,
    totalFailed: 0,
    todaySent: 0,
    todayFailed: 0,
    accountsConfigured: 0,
    accountsAtLimit: 0,
    activeAccount: "-",
    dailyLimit: 0,
    remainingToday: 0,
  };
}

function createInitialState(persistedRuntimeState = {}) {
  return {
    botStatus: "stopped",
    qrCode: null,
    logs: [],
    chatHistory: new Map(),
    messageStats: createEmptyMessageStats(),
    emailStats: createEmptyEmailStats(),
    activeUsers: new Map(),
    botClient: null,
    botInitFn: null,
    botDestroyFn: null,
    botLogoutFn: null,
    botVerifierClient: null,
    botVerifierInitFn: null,
    botVerifierDestroyFn: null,
    botVerifierLogoutFn: null,
    botVerifierStatus: "stopped",
    verifierQrCode: null,
    activeCampaignId: null,
    activeVerifierId: null,
    lastVerifierJobId: null,
    campaignRecipients: new Set(),
    processUnreadFn: null,
    autoReply: !!persistedRuntimeState?.autoReply,
    aiAuth: {
      mode:
        persistedRuntimeState?.aiAuth?.mode === "google_oauth"
          ? "google_oauth"
          : "api_key",
      googleOauth: sanitizeGoogleOauthSession(
        persistedRuntimeState?.aiAuth?.googleOauth,
      ),
    },
  };
}

module.exports = {
  createEmptyEmailStats,
  createEmptyMessageStats,
  createInitialState,
};
