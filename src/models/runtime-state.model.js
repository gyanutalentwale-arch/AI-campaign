const fs = require("fs");
const path = require("path");

const RUNTIME_STATE_PATH = path.join(process.cwd(), "data", "runtime_state.json");

function loadRuntimeState() {
  try {
    const raw = fs.readFileSync(RUNTIME_STATE_PATH, "utf8");
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function saveRuntimeState(runtimeState = {}) {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      RUNTIME_STATE_PATH,
      JSON.stringify(runtimeState || {}, null, 2),
    );
  } catch (_) {}
}

module.exports = {
  RUNTIME_STATE_PATH,
  loadRuntimeState,
  saveRuntimeState,
};
