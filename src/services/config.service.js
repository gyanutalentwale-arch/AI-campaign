function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = function createConfigService({ state, addLog, fs }) {
  function getStats() {
    return {
      botStatus: state.botStatus,
      stats: state.messageStats,
      emailStats: state.emailStats,
      activeUsers: Array.from(state.activeUsers.entries()).map(([id, user]) => ({
        id,
        ...user,
      })),
      qrCode: state.qrCode,
    };
  }

  function getLogs(limit = 100) {
    return state.logs.slice(-Math.max(parseInt(limit, 10) || 100, 1));
  }

  function getUsageLog() {
    try {
      return fs.readFileSync("bot_usage.log", "utf8");
    } catch (_) {
      return "";
    }
  }

  function getConfigLines() {
    try {
      return fs
        .readFileSync(".env", "utf8")
        .split("\n")
        .map((line) => {
          if (!line.includes("=")) return null;
          const [key, ...rest] = line.split("=");
          const value = rest.join("=");
          return {
            key: key.trim(),
            value: value.trim(),
            masked: /KEY|SECRET|TOKEN/i.test(key),
          };
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function updateConfig(key, value) {
    if (!key) {
      throw createHttpError(400, "key required");
    }

    let raw = "";
    try {
      raw = fs.readFileSync(".env", "utf8");
    } catch (_) {}

    let found = false;
    const updated = raw.split("\n").map((line) => {
      if (line.startsWith(key + "=")) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });

    if (!found) {
      updated.push(`${key}=${value}`);
    }

    fs.writeFileSync(".env", updated.join("\n"));
    process.env[key] = value;

    addLog("info", `Config updated: ${key}`);
    return { ok: true };
  }

  async function listGroups() {
    if (!state.botClient) {
      throw createHttpError(400, "Bot not connected");
    }

    const chats = await state.botClient.getChats();
    return {
      groups: chats
        .filter((chat) => chat.isGroup)
        .map((chat) => ({
          id: chat.id._serialized,
          name: chat.name,
          participants: chat.participants?.length || 0,
        })),
    };
  }

  async function exportGroupCsv(groupId) {
    if (!state.botClient) {
      throw createHttpError(400, "Bot not connected");
    }

    const chat = await state.botClient.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      throw createHttpError(404, "Group not found");
    }

    const rows = chat.participants.map((participant) => ({
      number: participant.id.user,
    }));
    const csv = ["number", ...rows.map((row) => `"${row.number}"`)].join("\n");

    return {
      filename: `${chat.name.replace(/[^a-z0-9]/gi, "_")}_contacts.csv`,
      csv,
    };
  }

  return {
    exportGroupCsv,
    getConfigLines,
    getLogs,
    getStats,
    getUsageLog,
    listGroups,
    updateConfig,
  };
};
