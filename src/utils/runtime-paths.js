const fs = require("fs");
const path = require("path");

function isAzureAppService() {
  return Boolean(process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_INSTANCE_ID);
}

function getAppDataDir() {
  if (process.env.APP_DATA_DIR) {
    return path.resolve(process.env.APP_DATA_DIR);
  }

  if (isAzureAppService()) {
    return "/home/site/data";
  }

  return process.cwd();
}

const appDataDir = getAppDataDir();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolveRuntimePath(target, options = {}) {
  const { migrateFromCwd = false } = options;
  const normalizedTarget = String(target || "").replace(/^[/\\]+/, "");

  ensureDir(appDataDir);
  const runtimePath = path.join(appDataDir, normalizedTarget);
  ensureDir(path.dirname(runtimePath));

  if (migrateFromCwd) {
    const cwdPath = path.join(process.cwd(), normalizedTarget);
    if (!fs.existsSync(runtimePath) && fs.existsSync(cwdPath)) {
      try {
        if (fs.statSync(cwdPath).isFile()) {
          fs.copyFileSync(cwdPath, runtimePath);
        }
      } catch (_) {}
    }
  }

  return runtimePath;
}

function ensureRuntimeStorage() {
  ensureDir(appDataDir);
  ensureDir(resolveRuntimePath("whatsapp_session"));
  ensureDir(resolveRuntimePath(".wwebjs_cache"));
  ensureDir(resolveRuntimePath(".wwebjs_auth"));
}

module.exports = {
  appDataDir,
  ensureRuntimeStorage,
  isAzureAppService,
  resolveRuntimePath,
};
