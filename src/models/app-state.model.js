function createEmptyMessageStats() {
  return {
    total: 0,
    today: 0,
    gemini: 0,
    api: 0,
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

function createInitialState() {
  return {
    botStatus: "stopped",
    qrCode: null,
    logs: [],
    messageStats: createEmptyMessageStats(),
    emailStats: createEmptyEmailStats(),
    activeUsers: new Map(),
    botClient: null,
    botInitFn: null,
    botDestroyFn: null,
    botLogoutFn: null,
    activeCampaignId: null,
    activeVerifierId: null,
    lastVerifierJobId: null,
    campaignRecipients: new Set(),
    processUnreadFn: null,
    persistRuntimeState: () => {},
  };
}

module.exports = {
  createEmptyEmailStats,
  createEmptyMessageStats,
  createInitialState,
};
