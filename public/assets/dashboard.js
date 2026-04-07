// Dashboard script extracted from index.html so UI behavior is easier to maintain.

const socket = io();
let autoScroll = true;
let selectedUser = null;
let botStatus = 'stopped';
let aiAuthState = null;
let googleTokenClient = null;
let googleAccessToken = '';
let campaignAiAuthMode = '';
const SIDEBAR_STATE_KEY = 'tw_sidebar_collapsed';
const SIDEBAR_ANIM_MS = 320;
let sidebarAnimTimer = null;

// --- Navigation ---------------------------------------------------------------

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + item.dataset.page).classList.add('active');
    if (item.dataset.page === 'training') loadTraining();
    if (item.dataset.page === 'config') loadConfig();
    if (item.dataset.page === 'usage') loadUsageLog();
    if (item.dataset.page === 'campaign') {
      updatePreview();
      if (!campaignPresetLoaded) loadCampaignPreset();
      if (!parsedContacts.length) restoreCampaignParsedState();
      restoreActiveCampaignState();
    }
    if (item.dataset.page === 'email') {
      updateEmailPreview();
      loadEmailAccounts();
      if (!emailPresetLoaded) loadEmailPreset();
    }
  });
});

function applySidebarState(collapsed, options = {}) {
  const { animate = false } = options;
  const isMobile = window.matchMedia('(max-width: 980px)').matches;
  const effectiveCollapsed = !isMobile && collapsed;
  if (animate && !isMobile) {
    document.body.classList.add('sidebar-animating');
    if (sidebarAnimTimer) clearTimeout(sidebarAnimTimer);
    sidebarAnimTimer = setTimeout(() => {
      document.body.classList.remove('sidebar-animating');
      sidebarAnimTimer = null;
    }, SIDEBAR_ANIM_MS);
  } else if (isMobile && document.body.classList.contains('sidebar-animating')) {
    document.body.classList.remove('sidebar-animating');
    if (sidebarAnimTimer) {
      clearTimeout(sidebarAnimTimer);
      sidebarAnimTimer = null;
    }
  }
  document.body.classList.toggle('sidebar-collapsed', effectiveCollapsed);
  const btn = document.getElementById('sidebar-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!effectiveCollapsed));
    btn.title = effectiveCollapsed ? 'Expand menu' : 'Collapse menu';
  }
}

function toggleSidebar(forceCollapsed) {
  if (document.body.classList.contains('sidebar-animating')) return;
  const next = typeof forceCollapsed === 'boolean'
    ? forceCollapsed
    : !document.body.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_STATE_KEY, next ? '1' : '0');
  window.requestAnimationFrame(() => applySidebarState(next, { animate: true }));
}

(() => {
  const savedCollapsed = localStorage.getItem(SIDEBAR_STATE_KEY) === '1';
  applySidebarState(savedCollapsed, { animate: false });
  window.addEventListener('resize', () => {
    const saved = localStorage.getItem(SIDEBAR_STATE_KEY) === '1';
    applySidebarState(saved, { animate: false });
  });
})();

// Keep QR panel directly under WhatsApp connect controls
(() => {
  const controls = document.querySelector('#page-overview .controls');
  const qrContainer = document.getElementById('qr-container');
  if (controls && qrContainer) controls.insertAdjacentElement('afterend', qrContainer);
})();

loadGoogleAiAuthStatus();

// --- Socket Events ------------------------------------------------------------
socket.on('init', (data) => {
  updateStatus(data.botStatus);
  updateVerifierStatus(data.botVerifierStatus || 'stopped');
  updateStats(data.stats);
  updateEmailStats(data.emailStats);
  data.logs.forEach(addLogEntry);
  updateUsers(data.activeUsers);
  if (data.qrCode) showQR(data.qrCode);
  if (data.verifierQrCode) showVerifierQR(data.verifierQrCode);
  if (data.autoReply !== undefined) setAutoReplyUI(data.autoReply);
  if (data.aiAuth) renderGoogleAiAuth(data.aiAuth);
  if (!campaignPresetLoaded) loadCampaignPreset();
  if (!parsedContacts.length) restoreCampaignParsedState();
  restoreActiveCampaignState();
  if (!emailPresetLoaded) loadEmailPreset();
});

socket.on('autoreply', setAutoReplyUI);
socket.on('ai_auth_status', renderGoogleAiAuth);

socket.on('log', addLogEntry);
socket.on('status_verifier', updateVerifierStatus);
socket.on('qr_verifier', showVerifierQR);
socket.on('status', updateStatus);
socket.on('stats', updateStats);
socket.on('email_stats', updateEmailStats);
socket.on('qr', showQR);
socket.on('users_update', updateUsers);
socket.on('history_update', (data) => {
  if (selectedUser === data.userId) renderChat(data.history);
});
socket.on('history_cleared', (userId) => {
  const box = document.getElementById('chat-box');
  if (selectedUser === userId && box) {
    box.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;margin-top:40px">History cleared</div>';
  }
});

function loadGoogleAiAuthStatus() {
  return fetch('/api/ai-auth/status')
    .then(r => r.json())
    .then(renderGoogleAiAuth)
    .catch(() => {});
}

function getConfiguredGoogleClientId() {
  return aiAuthState?.googleOauth?.configured?.clientId || '';
}

function getConfiguredGoogleProjectId() {
  return aiAuthState?.googleOauth?.configured?.projectId || '';
}

function normalizeCampaignAiAuthMode(mode) {
  if (mode === 'google_oauth') return 'google_oauth';
  if (mode === 'api_key') return 'api_key';
  return '';
}

function getCampaignAiAuthMode() {
  return normalizeCampaignAiAuthMode(campaignAiAuthMode)
    || normalizeCampaignAiAuthMode(aiAuthState?.mode)
    || 'api_key';
}

function setCampaignAiAuthMode(mode) {
  campaignAiAuthMode = normalizeCampaignAiAuthMode(mode) || 'api_key';
  renderCampaignAiAuth();
}

function ensureGoogleTokenClient() {
  if (!window.google?.accounts?.oauth2) {
    toast('Google Identity script is still loading');
    return null;
  }

  const clientId = getConfiguredGoogleClientId();
  if (!clientId) {
    toast('Save GOOGLE_OAUTH_CLIENT_ID first');
    return null;
  }

  if (!googleTokenClient) {
    googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: aiAuthState?.googleOauth?.scope || 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever openid email profile',
      callback: async (tokenResponse) => {
        if (tokenResponse?.error) {
          toast(tokenResponse.error);
          return;
        }

        googleAccessToken = tokenResponse.access_token || '';
        const expiresAt = Date.now() + ((Number(tokenResponse.expires_in) || 3600) * 1000) - 30000;
        const projectId = getConfiguredGoogleProjectId();

        if (!projectId) {
          toast('Save GOOGLE_OAUTH_PROJECT_ID first');
          return;
        }

        fetch('/api/ai-auth/google-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: googleAccessToken,
            expiresAt,
            grantedScope: tokenResponse.scope || '',
            projectId,
          }),
        })
          .then(async (response) => {
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not save Google OAuth session');
            renderGoogleAiAuth(data);
            toast('Google OAuth connected');
          })
          .catch((error) => {
            toast(error.message || 'Google OAuth sign-in failed');
          });
      },
      error_callback: () => {
        toast('Google sign-in was cancelled');
      },
    });
  }

  return googleTokenClient;
}

function startGoogleOauthLogin() {
  const tokenClient = ensureGoogleTokenClient();
  if (!tokenClient) return;
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function setGeminiAuthMode(mode) {
  fetch('/api/ai-auth/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not switch Gemini auth mode');
      renderGoogleAiAuth(data);
      toast(mode === 'google_oauth' ? 'Gemini auth mode set to Google OAuth' : 'Gemini auth mode set to API key');
    })
    .catch((error) => {
      toast(error.message || 'Could not switch Gemini auth mode');
    });
}

function disconnectGoogleOauth() {
  const accessToken = googleAccessToken;
  const finalize = () => {
    fetch('/api/ai-auth/google-session', { method: 'DELETE' })
      .then(r => r.json())
      .then((data) => {
        googleAccessToken = '';
        googleTokenClient = null;
        renderGoogleAiAuth(data);
        toast('Google OAuth disconnected');
      })
      .catch(() => {
        toast('Could not disconnect Google OAuth');
      });
  };

  if (window.google?.accounts?.oauth2 && accessToken) {
    google.accounts.oauth2.revoke(accessToken, finalize);
    return;
  }

  finalize();
}

function testGoogleOauthGemini() {
  fetch('/api/ai-auth/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Gemini test failed');
      toast(`Gemini test ok: ${data.text.slice(0, 90)}`);
    })
    .catch((error) => {
      toast(error.message || 'Gemini test failed');
    });
}

function renderCampaignAiAuth() {
  const mode = getCampaignAiAuthMode();
  const oauth = aiAuthState?.googleOauth || {};
  const configured = oauth.configured || {};
  const statusEl = document.getElementById('campaign-ai-auth-status');
  const sessionEl = document.getElementById('campaign-ai-auth-session');
  const hintEl = document.getElementById('campaign-ai-auth-hint');
  const apiBtn = document.getElementById('btn-campaign-use-api');
  const oauthBtn = document.getElementById('btn-campaign-use-google-oauth');
  const loginBtn = document.getElementById('btn-campaign-google-login');

  if (statusEl) {
    statusEl.textContent = mode === 'google_oauth'
      ? 'Campaign AI will use Google Login.'
      : 'Campaign AI will use API mode.';
  }

  if (sessionEl) {
    sessionEl.textContent = oauth.signedIn
      ? `Google session ready for ${oauth.email || oauth.name || 'Google user'}.`
      : 'No Google Login session connected yet.';
  }

  if (hintEl) {
    if (mode === 'google_oauth') {
      hintEl.textContent = oauth.signedIn
        ? 'Bulk AI variation will call Gemini through Google Login.'
        : (oauth.prompt || 'Sign in with Google to use Campaign AI in Google Login mode.');
    } else {
      hintEl.textContent = 'Bulk AI variation will call Gemini with GEMINI_API_KEY when AI variation is enabled.';
    }
  }

  if (apiBtn) {
    apiBtn.disabled = mode === 'api_key';
    apiBtn.className = 'btn ' + (mode === 'api_key' ? 'btn-purple' : 'btn-ghost');
  }
  if (oauthBtn) {
    oauthBtn.disabled = mode === 'google_oauth';
    oauthBtn.className = 'btn ' + (mode === 'google_oauth' ? 'btn-purple' : 'btn-ghost');
  }
  if (loginBtn) {
    loginBtn.disabled = !configured.clientId || !configured.projectId;
  }
}

function renderGoogleAiAuth(status) {
  aiAuthState = status || null;
  const mode = aiAuthState?.mode || 'api_key';
  const oauth = aiAuthState?.googleOauth || {};
  const configured = oauth.configured || {};

  if (!oauth.signedIn) {
    googleAccessToken = '';
  }

  const modeEl = document.getElementById('ai-auth-mode');
  const sessionEl = document.getElementById('ai-auth-session');
  const hintEl = document.getElementById('ai-auth-hint');
  const loginBtn = document.getElementById('btn-google-login');
  const logoutBtn = document.getElementById('btn-google-logout');
  const testBtn = document.getElementById('btn-google-test');
  const apiKeyBtn = document.getElementById('btn-use-api-key');
  const oauthBtn = document.getElementById('btn-use-google-oauth');

  if (modeEl) {
    modeEl.textContent = mode === 'google_oauth'
      ? 'Active mode: Google OAuth'
      : 'Active mode: API key';
  }

  if (sessionEl) {
    if (oauth.signedIn) {
      const expires = oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleString() : 'soon';
      const scopeNote = oauth.grantedScope && !oauth.grantedScope.includes('generative-language.retriever')
        ? ' | Gemini scope missing'
        : '';
      sessionEl.textContent = `Signed in as ${oauth.email || oauth.name || 'Google user'} | token valid until ${expires}${scopeNote}`;
    } else {
      sessionEl.textContent = configured.ready
        ? 'Google OAuth is configured but not signed in.'
        : 'Google OAuth is not configured yet.';
    }
  }

  if (hintEl) {
    hintEl.textContent = oauth.prompt || 'Google OAuth session is ready for Gemini testing.';
  }

  if (loginBtn) loginBtn.disabled = !configured.clientId || !configured.projectId;
  if (logoutBtn) logoutBtn.disabled = !oauth.signedIn;
  if (testBtn) testBtn.disabled = !oauth.signedIn;
  if (apiKeyBtn) apiKeyBtn.disabled = mode === 'api_key';
  if (oauthBtn) oauthBtn.disabled = !oauth.signedIn || mode === 'google_oauth';
  renderCampaignAiAuth();
}

// --- Status ------------------------------------------------------------------?
function updateStatus(status) {
  botStatus = status;
  const badge = document.getElementById('status-badge');
  const text = document.getElementById('status-text');
  const connectBtn = document.getElementById('btn-start');
  badge.className = 'status-badge ' + status;
  const labels = { ready: 'Connected', stopped: 'Stopped', starting: 'Starting...', qr: 'Waiting QR' };
  text.textContent = labels[status] || status;
  if (connectBtn) {
    connectBtn.disabled = status !== 'stopped';
    connectBtn.textContent = status === 'ready'
      ? 'WhatsApp Connected'
      : status === 'starting'
        ? 'Connecting...'
        : status === 'qr'
          ? 'Waiting for QR Scan'
          : 'WhatsApp Connect';
  }
  document.getElementById('btn-stop').disabled = status === 'stopped';
  if (status !== 'qr') document.getElementById('qr-container').style.display = 'none';
  updateUnreadScanUI();
}

function animateStat(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const next = Number(value) || 0;
  const prev = Number(el.dataset.value || 0);
  if (prev === next) { el.textContent = next; return; }

  const duration = 420;
  const start = performance.now();
  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(prev + (next - prev) * eased);
    el.textContent = current;
    if (progress < 1) requestAnimationFrame(frame);
  }
  el.dataset.value = String(next);
  requestAnimationFrame(frame);
}

function updateStats(stats) {
  if (!stats) return;
  animateStat('stat-total', stats.total || 0);
  animateStat('stat-today', stats.today || 0);
  animateStat('stat-api', stats.api || 0);
  animateStat('stat-google-oauth', stats.googleOauth || 0);
  animateStat('stat-gemini', stats.gemini || 0);
  animateStat('stat-openai', stats.openai || 0);
}

function updateEmailStats(stats) {
  if (!stats) return;
  animateStat('stat-email-today-sent', stats.todaySent || 0);
  animateStat('stat-email-today-failed', stats.todayFailed || 0);
  animateStat('stat-email-total-sent', stats.totalSent || 0);
  animateStat('stat-email-total-failed', stats.totalFailed || 0);
  animateStat('stat-email-accounts', stats.accountsConfigured || 0);
  animateStat('stat-email-at-limit', stats.accountsAtLimit || 0);
  animateStat('stat-email-daily-limit', stats.dailyLimit || 0);
  animateStat('stat-email-remaining', stats.remainingToday || 0);
  const active = document.getElementById('stat-email-active');
  if (active) active.textContent = stats.activeAccount || '-';
}

function showQR(qrDataUrl) {
  const c = document.getElementById('qr-container');
  c.style.display = 'block';
  document.getElementById('qr-img').src = qrDataUrl;
  updateStatus('qr');
}

// --- Users -------------------------------------------------------------------
function updateUsers(users) {
  const list = Array.isArray(users) ? users : [];
  const tbody = document.getElementById('users-table');
  if (tbody) {
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:20px">No active users yet</td></tr>';
    } else {
      tbody.innerHTML = list.map(u => `
    <tr>
      <td style="font-family:monospace;font-size:11px">${u.id}</td>
      <td>${u.name || 'â€”'}</td>
      <td>${u.msgCount || 0}</td>
      <td style="color:var(--muted);font-size:12px">${u.lastSeen ? new Date(u.lastSeen).toLocaleString() : 'â€”'}</td>
    </tr>`).join('');
    }
  }

  // Update user list in history tab
  const ul = document.getElementById('user-list');
  if (!ul) return;
  if (!list.length) {
    ul.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">No users yet</div>';
    return;
  }
  ul.innerHTML = list.map(u => `
    <div class="user-item ${selectedUser === u.id ? 'selected' : ''}" onclick="selectUser('${u.id}', '${u.name || u.id}')">
      <div>
        <div class="user-name">${u.name || u.id}</div>
        <div class="user-meta">${u.id} Â· ${u.msgCount || 0} msgs</div>
      </div>
    </div>`).join('');
}

function selectUser(userId, name) {
  selectedUser = userId;
  document.getElementById('chat-title').textContent = name;
  document.getElementById('btn-clear-history').style.display = 'inline-block';
  document.querySelectorAll('.user-item').forEach(el => el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  fetch('/api/history/' + encodeURIComponent(userId))
    .then(r => r.json()).then(d => renderChat(d.history));
}

function renderChat(history) {
  const box = document.getElementById('chat-box');
  if (!history || !history.length) { box.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;margin-top:40px">No messages yet</div>'; return; }
  box.innerHTML = history.map(m => {
    const text = m.parts && m.parts[0] ? m.parts[0].text : '';
    return `<div class="chat-msg ${m.role}">
      <div class="role">${m.role === 'model' ? 'Bot' : 'User'}</div>
      <div class="bubble">${escHtml(text)}</div>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function clearHistory() {
  if (!selectedUser || !confirm('Clear history for this user?')) return;
  fetch('/api/history/' + encodeURIComponent(selectedUser), { method: 'DELETE' }).then(() => toast('History cleared'));
}

// --- Logs ---------------------------------------------------------------------
function normalizeLogText(text) {
  const cp1252Map = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
  };
  const score = (value) => (String(value || '').match(/[ÃƒÃ‚Ã¢Ã°Ã¯Å“Å¾Å¡â‚¬â„¢]/g) || []).length;
  const toBytes = (value) => {
    const str = String(value || '');
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 0xFF) {
        bytes[i] = code;
        continue;
      }
      const mapped = cp1252Map[code];
      if (mapped === undefined) return null;
      bytes[i] = mapped;
    }
    return bytes;
  };

  let best = String(text || '');
  let bestScore = score(best);
  if (!bestScore) return best;

  for (let i = 0; i < 3; i++) {
    const bytes = toBytes(best);
    if (!bytes) break;
    const next = new TextDecoder('utf-8').decode(bytes);
    if (next === best) break;
    const nextScore = score(next);
    if (nextScore < bestScore) {
      best = next;
      bestScore = nextScore;
    } else {
      break;
    }
  }

  return best;
}

function addLogEntry(entry) {
  const box = document.getElementById('log-box');
  const msg = normalizeLogText(entry.message);
  const level = detectLevel(msg);
  const div = document.createElement('div');
  div.className = 'log-entry ' + level;
  div.innerHTML = `<span class="time">${new Date(entry.time).toLocaleTimeString()}</span><span class="msg">${escHtml(msg)}</span>`;
  box.appendChild(div);
  if (autoScroll) box.scrollTop = box.scrollHeight;
  if (box.children.length > 300) box.removeChild(box.firstChild);
}

function detectLevel(msg) {
  if (msg.includes('?') || msg.includes('Error') || msg.includes('error')) return 'error';
  if (msg.toLowerCase().includes('warn') || msg.toLowerCase().includes('warning')) return 'warn';
  if (msg.includes('?') || msg.includes('Reply sent')) return 'success';
  return 'info';
}

function clearLogs() { document.getElementById('log-box').innerHTML = ''; }
function toggleAutoScroll() { autoScroll = !autoScroll; document.getElementById('autoscroll-label').textContent = autoScroll ? 'ON' : 'OFF'; }

// --- Prompt Manager ----------------------------------------------------------
const PROMPT_HINTS = {
  'system_prompt.txt': 'Main system prompt.',
  'links.json':        'Links and contacts.',
  'industries.json':   'Industry IDs for jobs.',
};

let activePromptFile = null;

function loadTraining() {
  selectPromptFile(document.querySelector('.ptab'));
}

function selectPromptFile(btn) {
  const file = btn.dataset.file;
  activePromptFile = file;
  document.querySelectorAll('.ptab').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('prompt-hint').textContent = PROMPT_HINTS[file] || file;
  const editor = document.getElementById('training-editor');
  editor.value = 'Loading...';
  fetch('/api/prompt-file?file=' + encodeURIComponent(file))
    .then(r => r.json()).then(d => { editor.value = d.data || ''; });
}

function savePromptFile() {
  if (!activePromptFile) return toast('Select a file first');
  fetch('/api/prompt-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: activePromptFile, data: document.getElementById('training-editor').value })
  }).then(() => toast('? Saved! Changes apply on next message (no restart needed).'));
}

// --- Config ------------------------------------------------------------------?
const CONFIG_GROUPS = {
  'AI API Keys':    ['GEMINI_API_KEY', 'OPENAI_API_KEY'],
  'AI Authentication': ['GEMINI_AUTH_MODE', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_PROJECT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_JSON_PATH'],
  'AI Models':      ['PRIMARY_MODEL', 'FALLBACK_MODEL', 'OPENAI_MODEL'],
  'Campaign AI':    ['WA_CAMPAIGN_AI_ENABLED', 'WA_CAMPAIGN_AI_MODEL', 'WA_AI_MIN_CHARS', 'WA_AI_MAX_CHARS', 'WA_AI_MAX_PARAGRAPHS', 'WA_AI_BLOCKED_TERMS'],
  'Bot Settings':   ['MAX_HISTORY', 'MAX_OUTPUT_TOKENS'],
  'Dashboard':      ['DASHBOARD_PORT'],
  'Rate Limiting':  ['MIN_DELAY', 'MAX_DELAY', 'TYPING_MIN', 'TYPING_MAX', 'MAX_BURST', 'COOLDOWN_PERIOD'],
  'Email Accounts': ['EMAIL_1_USER', 'EMAIL_1_PASSWORD', 'EMAIL_1_NAME', 'EMAIL_2_USER', 'EMAIL_2_PASSWORD', 'EMAIL_2_NAME', 'EMAIL_3_USER', 'EMAIL_3_PASSWORD', 'EMAIL_3_NAME', 'EMAIL_DAILY_LIMIT'],
};

let configState = { groups: [], extras: [] };
const configOpenGroups = new Set(['AI API Keys', 'AI Authentication', 'AI Models', 'Campaign AI']);

function loadConfig() {
  fetch('/api/config').then(r => r.json()).then(d => {
    const map = {};
    d.lines.forEach(l => { if (l.key) map[l.key] = l; });

    const groups = [];
    for (const [group, keys] of Object.entries(CONFIG_GROUPS)) {
      const rows = [];
      keys.forEach(key => {
        const l = map[key] || { key, value: '', masked: false };
        rows.push(l);
        delete map[key];
      });
      groups.push({ group, rows });
    }

    configState = {
      groups,
      extras: Object.values(map).filter(l => l.key.trim())
    };
    setupConfigFilters();
    renderConfigList();
  });
}

function setupConfigFilters() {
  const filter = document.getElementById('config-group-filter');
  if (!filter) return;
  const previousValue = filter.value || 'all';
  const options = ['<option value="all">All groups</option>'];
  configState.groups.forEach(({ group }) => {
    options.push(`<option value="${escHtml(group)}">${escHtml(group)}</option>`);
  });
  if (configState.extras.length) options.push('<option value="Other">Other</option>');
  filter.innerHTML = options.join('');
  filter.value = Array.from(filter.options).some(opt => opt.value === previousValue) ? previousValue : 'all';
}

function renderConfigList() {
  const list = document.getElementById('config-list');
  if (!list) return;
  const query = (document.getElementById('config-search')?.value || '').trim().toLowerCase();
  const activeGroup = document.getElementById('config-group-filter')?.value || 'all';

  const groups = configState.groups
    .filter(({ group }) => activeGroup === 'all' || activeGroup === group)
    .map(({ group, rows }) => ({
      group,
      rows: rows.filter(l => {
        const keyText = String(l.key || '').toLowerCase();
        const valueText = String(l.value || '').toLowerCase();
        return !query || keyText.includes(query) || valueText.includes(query);
      })
    }))
    .filter(({ rows }) => rows.length);

  if (activeGroup === 'all' || activeGroup === 'Other') {
    const extraRows = configState.extras.filter(l => {
      const keyText = String(l.key || '').toLowerCase();
      const valueText = String(l.value || '').toLowerCase();
      return !query || keyText.includes(query) || valueText.includes(query);
    });
    if (extraRows.length) groups.push({ group: 'Other', rows: extraRows });
  }

  if (!groups.length) {
    list.innerHTML = '<div class="config-empty">No matching configuration keys found.</div>';
    return;
  }

  list.innerHTML = groups.map(({ group, rows }) => configGroupCard(group, rows)).join('');
}

function configGroupCard(group, rows) {
  const isOpen = configOpenGroups.has(group);
  const filledCount = rows.filter(r => String(r.value || '').trim()).length;
  return `<div class="config-group ${isOpen ? 'open' : ''}">
    <div class="config-group-header" onclick='toggleConfigGroup(${JSON.stringify(group)})'>
      <div class="config-group-title">${escHtml(group)}</div>
      <div class="config-group-meta">
        <span class="config-badge">${rows.length} keys</span>
        <span>${filledCount} filled</span>
        <span class="config-group-chevron">?</span>
      </div>
    </div>
    <div class="config-group-body">
      ${rows.map(configRow).join('')}
    </div>
  </div>`;
}

function configRow(l) {
  const safeKey = escHtml(l.key);
  const inputId = 'cfg-' + safeKey;
  return `<div class="config-row">
    <div class="config-key">${safeKey}</div>
    <div style="position:relative;display:flex;align-items:center">
      <input type="${l.masked ? 'password' : 'text'}" id="${inputId}" value="${escHtml(l.value)}" placeholder="${l.masked ? 'Enter new value' : ''}" style="width:100%;padding-right:${l.masked ? '36px' : '10px'}" />
      ${l.masked ? `<button onclick="toggleMask('${inputId}')" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;color:var(--muted);font-size:11px;font-weight:700" title="Show/Hide">SHOW</button>` : ''}
    </div>
    <button class="btn btn-purple" onclick="saveConfig('${safeKey}')">Save</button>
  </div>`;
}

function saveConfig(key) {
  const val = document.getElementById('cfg-' + key).value;
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: val })
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || ('Could not save ' + key));
      toast(key + ' updated');
      if (key === 'GOOGLE_OAUTH_CLIENT_ID' || key === 'GOOGLE_OAUTH_PROJECT_ID' || key === 'GEMINI_AUTH_MODE') {
        googleTokenClient = null;
        loadGoogleAiAuthStatus();
      }
    })
    .catch((error) => {
      toast(error.message || ('Could not save ' + key));
    });
}

function toggleConfigGroup(group) {
  if (configOpenGroups.has(group)) configOpenGroups.delete(group);
  else configOpenGroups.add(group);
  renderConfigList();
}

function toggleMask(inputId) {
  const el = document.getElementById(inputId);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function addConfigKey() {
  const key = prompt('Key name (e.g. MY_KEY):');
  if (!key) return;
  const val = prompt('Value:');
  if (val === null) return;
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: val }) })
    .then(() => {
      toast('Key added');
      loadConfig();
      if (key === 'GOOGLE_OAUTH_CLIENT_ID' || key === 'GOOGLE_OAUTH_PROJECT_ID' || key === 'GEMINI_AUTH_MODE') {
        googleTokenClient = null;
        loadGoogleAiAuthStatus();
      }
    });
}

// --- Usage Log ---------------------------------------------------------------?
function loadUsageLog() {
  fetch('/api/usage-log').then(r => r.json()).then(d => {
    const box = document.getElementById('usage-log-box');
    const lines = (d.log || '').trim().split('\n').reverse();
    box.innerHTML = lines.map(l => `<div class="log-entry info"><span class="msg">${escHtml(l)}</span></div>`).join('');
  });
}

// --- Bot Control -------------------------------------------------------------
function connectWhatsApp() {
  if (botStatus === 'ready') { toast('WhatsApp already connected'); return; }
  const qrBox = document.getElementById('qr-container');
  if (qrBox) qrBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  botControl('start');
}

function botControl(action) {
  fetch('/api/bot/' + action, { method: 'POST' }).then(r => r.json()).then(d => toast(d.msg || action + ' sent'));
}

function botLogout() {
  if (!confirm('Logout karega aur session delete hoga. Dobara QR scan karna padega. Continue?')) return;
  fetch('/api/bot/logout', { method: 'POST' }).then(r => r.json()).then(d => {
    toast(d.msg || 'Logged out');
    document.getElementById('qr-container').style.display = 'none';
  });
}

function scanUnreadMessages() {
  const btn = document.getElementById('btn-scan-unread');
  const desc = document.getElementById('unread-scan-desc');
  if (btn) {
    btn.dataset.loading = '1';
    btn.disabled = true;
    btn.textContent = 'Scanning...';
  }
  if (desc) {
    desc.textContent = 'Unread messages scan ho raha hai. Milne wale chats queue me jayenge.';
  }

  fetch('/api/bot/scan-unread', { method: 'POST' })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.msg || data.error || 'Unread scan failed');
      toast(data.msg || 'Unread scan completed');
    })
    .catch((error) => {
      toast(error.message || 'Unread scan failed');
    })
    .finally(() => {
      if (!btn) return;
      delete btn.dataset.loading;
      btn.disabled = false;
      btn.textContent = 'Scan Unread Now';
      updateUnreadScanUI();
    });
}

function updateUnreadScanUI() {
  const btn = document.getElementById('btn-scan-unread');
  const desc = document.getElementById('unread-scan-desc');
  const autoReplyEnabled = !!document.getElementById('autoreply-toggle')?.checked;
  const isReady = botStatus === 'ready';
  const isLoading = btn?.dataset.loading === '1';

  if (desc && !isLoading) {
    if (!isReady) {
      desc.textContent = 'Pehle WhatsApp Connect karo. Bot ready hone ke baad unread messages scan kar sakte ho.';
    } else if (!autoReplyEnabled) {
      desc.textContent = 'Unread scan tab reply queue start karega jab Auto Reply ON hoga.';
    } else {
      desc.textContent = 'Unread WhatsApp messages ko scan karega aur Auto Reply ON hone par unko queue me dal kar one-by-one reply start karega.';
    }
  }

  if (btn && !isLoading) {
    btn.disabled = !isReady;
  }
}

// --- Auto Reply Toggle -------------------------------------------------------
function setAutoReplyUI(enabled) {
  document.getElementById('autoreply-toggle').checked = enabled;
  document.getElementById('autoreply-slider').style.background = enabled ? 'var(--green)' : 'var(--border)';
  document.getElementById('autoreply-knob').style.left = enabled ? '25px' : '3px';
  document.getElementById('autoreply-desc').textContent = enabled
    ? 'ON - Replies enabled'
    : 'OFF - Replies disabled';
  updateUnreadScanUI();
}

function toggleAutoReply(enabled) {
  fetch('/api/autoreply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  }).then(r => r.json()).then(d => {
    setAutoReplyUI(d.enabled);
    toast(d.enabled ? 'Auto Reply ON' : 'Auto Reply OFF');
  });
}

// --- Bulk Campaign ------------------------------------------------------------
let parsedContacts = [], fileHeaders = [], activeCampaignId = null, campaignImageData = null;
let campaignPresetLoaded = false;
const CAMPAIGN_PARSED_STATE_KEY = 'tw_campaign_parsed_state_v1';
const CAMPAIGN_ACTIVE_ID_KEY = 'tw_campaign_active_id_v1';

function campaignPresetFromForm() {
  return {
    template: document.getElementById('campaign-template').value.trim(),
    minDelaySec: parseInt(document.getElementById('delay-min').value) || 15,
    maxDelaySec: parseInt(document.getElementById('delay-max').value) || 45,
    batchSize: parseInt(document.getElementById('batch-size').value) || 15,
    useAI: document.getElementById('use-ai-variation').checked,
    aiAuthMode: getCampaignAiAuthMode(),
    imageCaption: document.getElementById('img-caption').value.trim(),
  };
}

function setCampaignPresetNote(text, isError = false) {
  const el = document.getElementById('campaign-preset-note');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--muted)';
}

function applyCampaignPreset(preset) {
  if (!preset) return;
  document.getElementById('campaign-template').value = preset.template || '';
  document.getElementById('delay-min').value = String(preset.minDelaySec || 15);
  document.getElementById('delay-max').value = String(preset.maxDelaySec || 45);
  document.getElementById('batch-size').value = String(preset.batchSize || 15);
  document.getElementById('use-ai-variation').checked = !!preset.useAI;
  campaignAiAuthMode = normalizeCampaignAiAuthMode(preset.aiAuthMode) || campaignAiAuthMode || normalizeCampaignAiAuthMode(aiAuthState?.mode) || 'api_key';
  const caption = String(preset.imageCaption || '');
  document.getElementById('img-caption').value = caption;
  if (!campaignImageData && caption) document.getElementById('img-caption-wrap').style.display = 'block';
  renderCampaignAiAuth();
  updatePreview();
}

function loadCampaignPreset(showToast = false) {
  return fetch('/api/campaign/preset')
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error);
      applyCampaignPreset(d.preset || {});
      campaignPresetLoaded = true;
      setCampaignPresetNote('Preset loaded');
      if (showToast) toast('Saved campaign details loaded');
    })
    .catch(() => {
      setCampaignPresetNote('Preset not available yet');
      renderCampaignAiAuth();
    });
}

function saveCampaignPreset(showToast = false) {
  const payload = campaignPresetFromForm();
  return fetch('/api/campaign/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error);
      campaignPresetLoaded = true;
      setCampaignPresetNote('Preset saved');
      if (showToast) toast('Campaign details saved');
    })
    .catch(() => {
      setCampaignPresetNote('Could not save preset', true);
      if (showToast) toast('? Failed to save campaign details');
    });
}

function saveCampaignParsedState() {
  try {
    sessionStorage.setItem(CAMPAIGN_PARSED_STATE_KEY, JSON.stringify({
      contacts: parsedContacts,
      headers: fileHeaders,
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

function restoreCampaignParsedState() {
  try {
    const raw = sessionStorage.getItem(CAMPAIGN_PARSED_STATE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const headers = Array.isArray(data.headers) ? data.headers : [];
    if (!contacts.length) return false;

    parsedContacts = contacts;
    fileHeaders = headers;
    document.getElementById('parse-result').innerHTML = `<span style="color:var(--green)">Restored: ${contacts.length} contacts</span>`;
    document.getElementById('btn-send-campaign').disabled = false;
    document.getElementById('header-chips').innerHTML = '<span style="font-size:11px;color:var(--muted);margin-right:4px">Insert:</span>' +
      headers.map(h => `<span onclick="insertPlaceholder('${h}')" style="background:rgba(108,99,255,.2);color:var(--accent);padding:3px 10px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid rgba(108,99,255,.3)">{{${h}}}</span>`).join('');
    updatePreview();
    return true;
  } catch (_) {
    return false;
  }
}

function setCampaignActiveId(id) {
  activeCampaignId = id || null;
  try {
    if (activeCampaignId) sessionStorage.setItem(CAMPAIGN_ACTIVE_ID_KEY, activeCampaignId);
    else sessionStorage.removeItem(CAMPAIGN_ACTIVE_ID_KEY);
  } catch (_) {}
}

function applyCampaignProgress(d) {
  if (!d) return;
  if (d.id) setCampaignActiveId(d.id);
  const total = Number(d.total) || 0;
  const sent = Number(d.sent) || 0;
  const failed = Number(d.failed) || 0;
  const skipped = Number(d.skipped) || 0;
  const done = Number(d.processed) || sent + failed + skipped;
  const aiUsage = d.aiUsage || {};
  const aiMode = d.aiAuthMode === 'google_oauth'
    ? 'Google Login'
    : d.aiAuthMode === 'api_key'
      ? 'API'
      : 'Plain';

  document.getElementById('campaign-progress').style.display = 'block';
  document.getElementById('prog-sent').textContent = sent;
  document.getElementById('prog-failed').textContent = failed;
  document.getElementById('prog-skipped').textContent = skipped;
  document.getElementById('prog-total').textContent = total;
  document.getElementById('prog-remaining').textContent = Math.max(total - done, 0);
  document.getElementById('prog-bar').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  document.getElementById('prog-ai-mode').textContent = aiMode;
  document.getElementById('prog-ai-api').textContent = Number(aiUsage.api) || 0;
  document.getElementById('prog-ai-google-oauth').textContent = Number(aiUsage.googleOauth) || 0;

  if (d.status === 'done' || d.status === 'stopped') {
    document.getElementById('prog-status').textContent = d.status === 'done'
      ? `Done. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}`
      : `Stopped. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}`;
    document.getElementById('btn-download-log').style.display = 'inline-block';
    resetCampaignUI();
    return;
  }

  document.getElementById('btn-send-campaign').disabled = true;
  document.getElementById('btn-stop-campaign').style.display = 'inline-block';
  if (d.status && d.status.startsWith('break_')) {
    document.getElementById('prog-status').textContent = `Anti-ban break: ${d.status.replace('break_', '')} pause...`;
  } else if (d.status === 'paused') {
    document.getElementById('prog-status').textContent = 'Paused - handling incoming reply...';
  } else {
    document.getElementById('prog-status').textContent = 'Running...';
  }
}

function restoreActiveCampaignState() {
  return fetch('/api/campaign/active')
    .then(r => r.json())
    .then(d => {
      if (!d.active || !d.campaign) {
        setCampaignActiveId(null);
        return false;
      }
      applyCampaignProgress(d.campaign);
      return true;
    })
    .catch(() => false);
}

function switchContactTab(tab) {
  document.getElementById('contact-tab-file').style.display = tab === 'file' ? 'block' : 'none';
  document.getElementById('contact-tab-sheet').style.display = tab === 'sheet' ? 'block' : 'none';
  document.getElementById('contact-tab-group').style.display = tab === 'group' ? 'block' : 'none';
  document.getElementById('tab-file').className = 'btn ' + (tab === 'file' ? 'btn-purple' : 'btn-ghost');
  document.getElementById('tab-sheet').className = 'btn ' + (tab === 'sheet' ? 'btn-purple' : 'btn-ghost');
  document.getElementById('tab-group').className = 'btn ' + (tab === 'group' ? 'btn-purple' : 'btn-ghost');
  if (tab === 'group') loadGroups();
}

function loadGroups() {
  const sel = document.getElementById('group-select');
  sel.innerHTML = '<option>Loading...</option>';
  fetch('/api/groups').then(r => r.json()).then(d => {
    if (d.error) { sel.innerHTML = `<option>${d.error}</option>`; return; }
    if (!d.groups.length) { sel.innerHTML = '<option>No groups found</option>'; return; }
    sel.innerHTML = d.groups.map(g =>
      `<option value="${g.id}">${g.name} (${g.participants} members)</option>`
    ).join('');
  }).catch(() => { sel.innerHTML = '<option>Error loading groups</option>'; });
}

function exportGroupCSV() {
  const groupId = document.getElementById('group-select').value;
  if (!groupId || groupId.startsWith('â€”') || groupId === 'Loading...') return toast('Select a group first');
  window.open('/api/groups/' + encodeURIComponent(groupId) + '/export');
}

function importGroupContacts() {
  const groupId = document.getElementById('group-select').value;
  if (!groupId || groupId.startsWith('â€”') || groupId === 'Loading...') return toast('Select a group first');
  document.getElementById('parse-result').innerHTML = '<span style="color:var(--yellow)">? Fetching group members...</span>';
  fetch('/api/groups/' + encodeURIComponent(groupId) + '/export')
    .then(r => r.text()).then(csv => {
      // Parse CSV into contacts array
      const lines = csv.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''));
      const contacts = lines.slice(1).map(line => {
        const cols = line.match(/(".*?"|[^,]+)/g) || [];
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (cols[i] || '').replace(/^"|"$/g, ''); });
        return obj;
      }).filter(c => c.number);
      handleParseResult({ contacts, headers, total: contacts.length, numCol: 'number' });
    }).catch(() => toast('? Failed to fetch group members'));
}

function parseSheet() {
  const url = document.getElementById('sheet-url').value.trim();
  if (!url) return toast('Paste Google Sheet URL first');
  document.getElementById('parse-result').innerHTML = '<span style="color:var(--yellow)">? Fetching sheet...</span>';
  fetch('/api/campaign/parse-sheet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  }).then(r => r.json()).then(d => handleParseResult(d));
}

function parseContacts() {
  const file = document.getElementById('contacts-file').files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  document.getElementById('parse-result').innerHTML = '<span style="color:var(--yellow)">? Parsing...</span>';
  fetch('/api/campaign/parse', { method: 'POST', body: fd }).then(r => r.json()).then(d => handleParseResult(d));
}

function handleParseResult(d) {
  if (d.error) { document.getElementById('parse-result').innerHTML = `<span style="color:var(--red)">? ${d.error}</span>`; return; }
  parsedContacts = d.contacts; fileHeaders = d.headers;
  document.getElementById('parse-result').innerHTML = `<span style="color:var(--green)">Loaded: ${d.total} contacts</span>`;
  document.getElementById('btn-send-campaign').disabled = false;
  document.getElementById('header-chips').innerHTML = '<span style="font-size:11px;color:var(--muted);margin-right:4px">Insert:</span>' +
    d.headers.map(h => `<span onclick="insertPlaceholder('${h}')" style="background:rgba(108,99,255,.2);color:var(--accent);padding:3px 10px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid rgba(108,99,255,.3)">{{${h}}}</span>`).join('');
  saveCampaignParsedState();
  updatePreview();
}

function insertPlaceholder(header) {
  const ta = document.getElementById('campaign-template');
  const pos = ta.selectionStart;
  ta.value = ta.value.slice(0, pos) + `{{${header}}}` + ta.value.slice(pos);
  ta.focus(); ta.selectionStart = ta.selectionEnd = pos + header.length + 4;
  updatePreview();
}

function updatePreview() {
  const tpl = document.getElementById('campaign-template').value;
  const sample = parsedContacts[0] || fileHeaders.reduce((o, h) => ({ ...o, [h]: `[${h}]` }), {});
  const preview = tpl.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim();
    const match = Object.keys(sample).find(col => col.toLowerCase() === k.toLowerCase());
    return match !== undefined ? sample[match] : `{{${k}}}`;
  });
  document.getElementById('campaign-preview').textContent = preview || 'Preview appears here';
  if (parsedContacts[0]) {
    const numKey = Object.keys(parsedContacts[0]).find(k => /number|phone|mobile/i.test(k));
    document.getElementById('preview-contact-label').textContent = `Sample: ${parsedContacts[0][numKey] || ''}`;
  }
}

function previewImage() {
  const file = document.getElementById('campaign-image').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    campaignImageData = { dataUrl: e.target.result, mimetype: file.type };
    document.getElementById('img-thumb').src = e.target.result;
    document.getElementById('img-preview').style.display = 'block';
    document.getElementById('img-caption-wrap').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  campaignImageData = null;
  document.getElementById('campaign-image').value = '';
  document.getElementById('img-preview').style.display = 'none';
  document.getElementById('img-caption-wrap').style.display = 'none';
}

function startCampaign() {
  if (!parsedContacts.length) return toast('Upload contacts first');
  const template = document.getElementById('campaign-template').value.trim();
  if (!template) return toast('Write a message template first');
  const useAI = document.getElementById('use-ai-variation').checked;
  const aiAuthMode = getCampaignAiAuthMode();
  if (useAI && aiAuthMode === 'google_oauth' && !aiAuthState?.googleOauth?.signedIn) {
    return toast('Campaign AI is set to Google Login. Sign in first or switch to API.');
  }
  saveCampaignPreset(false);
  document.getElementById('btn-send-campaign').disabled = true;
  document.getElementById('btn-stop-campaign').style.display = 'inline-block';
  document.getElementById('campaign-progress').style.display = 'block';
  document.getElementById('prog-sent').textContent = '0';
  document.getElementById('prog-failed').textContent = '0';
  document.getElementById('prog-skipped').textContent = '0';
  document.getElementById('prog-total').textContent = parsedContacts.length;
  document.getElementById('prog-remaining').textContent = parsedContacts.length;
  document.getElementById('prog-bar').style.width = '0%';
  document.getElementById('prog-ai-mode').textContent = aiAuthMode === 'google_oauth' ? 'Google Login' : 'API';
  document.getElementById('prog-ai-api').textContent = '0';
  document.getElementById('prog-ai-google-oauth').textContent = '0';
  const body = { contacts: parsedContacts, template,
    minDelay: (parseInt(document.getElementById('delay-min').value) || 15) * 1000,
    maxDelay: (parseInt(document.getElementById('delay-max').value) || 45) * 1000,
    batchSize: parseInt(document.getElementById('batch-size').value) || 15,
    useAI,
    aiAuthMode };
  if (campaignImageData) { body.imageDataUrl = campaignImageData.dataUrl; body.imageMime = campaignImageData.mimetype; body.imageCaption = document.getElementById('img-caption').value.trim(); }
  fetch('/api/campaign/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).then(d => {
      if (d.error) { toast('? ' + d.error); resetCampaignUI(); return; }
      setCampaignActiveId(d.id);
      document.getElementById('prog-status').textContent = 'Running...';
    });
}

function stopCampaign() {
  if (!activeCampaignId) return;
  fetch('/api/campaign/stop/' + activeCampaignId, { method: 'POST' });
  document.getElementById('prog-status').textContent = '? Stopping after current message...';
}

function downloadLog() { if (activeCampaignId) window.open('/api/campaign/' + activeCampaignId + '/log'); }

function resetCampaignUI() {
  document.getElementById('btn-send-campaign').disabled = !parsedContacts.length;
  document.getElementById('btn-stop-campaign').style.display = 'none';
  document.getElementById('prog-ai-mode').textContent = getCampaignAiAuthMode() === 'google_oauth' ? 'Google Login' : 'API';
}

socket.on('campaign_progress', (d) => {
  applyCampaignProgress(d);
});



// --- Email Campaign ----------------------------------------------------------
let emailContacts = [], emailHeaders = [], emailAccountsState = [], activeEmailId = null;
let emailPresetLoaded = false;

function emailPresetFromForm() {
  return {
    subject: document.getElementById('email-subject').value.trim(),
    template: getEmailHTML(),
    delaySec: parseInt(document.getElementById('email-delay').value) || 5,
  };
}

function setEmailPresetNote(text, isError = false) {
  const el = document.getElementById('email-preset-note');
  if (!el) return;
  el.textContent = text;
  el.className = 'email-status-note' + (isError ? ' is-error' : '');
}

function renderEmailParseStatus(text, tone = 'neutral') {
  const el = document.getElementById('email-parse-result');
  if (!el) return;
  el.textContent = text;
  el.className = 'email-status-note'
    + (tone === 'success' ? ' is-success' : tone === 'error' ? ' is-error' : '');
}

function hasEmailBodyContent() {
  const html = getEmailHTML().trim();
  if (!html || html === '<br>') return false;
  const textOnly = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, '')
    .trim();
  return Boolean(textOnly || /<(img|table|a|button|section|article|div|p|ul|ol|h[1-6])\b/i.test(html));
}

function renderEmailHeaderChips(headers) {
  const box = document.getElementById('email-header-chips');
  if (!box) return;
  if (!headers.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<span class="email-chip-label">Insert fields:</span>' + headers.map((header) => {
    const safeLabel = escHtml(header);
    const safeArg = JSON.stringify(String(header));
    return `<button type="button" class="email-placeholder-chip" onclick='insertEmailPlaceholder(${safeArg})'>{{${safeLabel}}}</button>`;
  }).join('');
}

function updateEmailAudienceSummary() {
  const contactCountEl = document.getElementById('email-contact-count');
  const fieldCountEl = document.getElementById('email-field-count');
  const readyNoteEl = document.getElementById('email-ready-note');
  const sendBtn = document.getElementById('btn-send-email');
  const stopBtn = document.getElementById('btn-stop-email');
  const subject = document.getElementById('email-subject')?.value.trim() || '';
  const hasContacts = emailContacts.length > 0;
  const hasFields = emailHeaders.length > 0;
  const hasSubject = subject.length > 0;
  const hasBody = hasEmailBodyContent();
  const hasAccounts = emailAccountsState.length > 0;
  const isRunning = Boolean(stopBtn && stopBtn.style.display !== 'none');

  if (contactCountEl) contactCountEl.textContent = String(emailContacts.length);
  if (fieldCountEl) fieldCountEl.textContent = String(emailHeaders.length);
  if (sendBtn) sendBtn.disabled = isRunning || !hasAccounts || !hasContacts || !hasSubject || !hasBody;
  if (!readyNoteEl) return;

  if (!hasAccounts) {
    readyNoteEl.textContent = 'Add at least one SMTP account in .env before launching the campaign.';
    return;
  }
  if (isRunning) {
    readyNoteEl.textContent = `Campaign is running for ${emailContacts.length} contact${emailContacts.length === 1 ? '' : 's'}. You can monitor progress below or stop after the current send.`;
    return;
  }
  if (!hasContacts) {
    readyNoteEl.textContent = 'Import your audience first. CSV, XLSX, and Google Sheet sources are supported.';
    return;
  }
  if (!hasSubject && !hasBody) {
    readyNoteEl.textContent = 'Audience is ready. Add a subject line and write the email body to enable sending.';
    return;
  }
  if (!hasSubject) {
    readyNoteEl.textContent = 'Audience is ready. Add a personalized subject line before sending.';
    return;
  }
  if (!hasBody) {
    readyNoteEl.textContent = 'Audience is ready. Write the email body or switch to HTML mode to paste a template.';
    return;
  }

  readyNoteEl.textContent = `Ready to send to ${emailContacts.length} contact${emailContacts.length === 1 ? '' : 's'} with ${hasFields ? emailHeaders.length : 'no'} detected placeholder field${emailHeaders.length === 1 ? '' : 's'}.`;
}

function applyEmailPreset(preset) {
  if (!preset) return;
  const subject = String(preset.subject || '');
  const html = String(preset.template || '');
  const delaySec = parseInt(preset.delaySec, 10) || 5;
  document.getElementById('email-subject').value = subject;
  document.getElementById('email-editor').innerHTML = html;
  document.getElementById('email-html-src').value = html;
  document.getElementById('email-delay').value = String(delaySec);
  updateEmailPreview();
  updateEmailAudienceSummary();
}

function loadEmailPreset(showToast = false) {
  return fetch('/api/email/preset')
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error);
      applyEmailPreset(d.preset || {});
      emailPresetLoaded = true;
      setEmailPresetNote('Preset loaded');
      if (showToast) toast('Saved email details loaded');
    })
    .catch(() => {
      setEmailPresetNote('Preset not available yet');
    });
}

function saveEmailPreset(showToast = false) {
  const payload = emailPresetFromForm();
  return fetch('/api/email/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(r => r.json())
    .then(d => {
      if (d.error) throw new Error(d.error);
      emailPresetLoaded = true;
      setEmailPresetNote('Preset saved');
      if (showToast) toast('Email details saved');
    })
    .catch(() => {
      setEmailPresetNote('Could not save preset', true);
      if (showToast) toast('Failed to save email details');
    });
}

function loadEmailAccounts() {
  fetch('/api/email/accounts').then(r => r.json()).then(d => {
    const el = document.getElementById('email-accounts-list');
    const summary = document.getElementById('email-account-summary');
    const from = document.getElementById('preview-from');
    if (!el) return;
    emailAccountsState = Array.isArray(d.accounts) ? d.accounts : [];
    if (!emailAccountsState.length) {
      if (summary) summary.innerHTML = '<span class="email-pill danger">No SMTP accounts</span>';
      if (from) from.textContent = 'No active sender';
      el.innerHTML = '<div class="email-empty-state">No email accounts configured. Add <code>EMAIL_1_USER</code> and <code>EMAIL_1_PASSWORD</code> in <code>.env</code> to enable campaigns.</div>';
      updateEmailAudienceSummary();
      return;
    }
    const activeAccount = emailAccountsState.find(a => a.active) || emailAccountsState[0];
    const totalRemaining = emailAccountsState.reduce((sum, a) => (
      sum + (typeof a.remainingToday === 'number'
        ? a.remainingToday
        : Math.max((a.limit || 0) - (a.dailySent || 0), 0))
    ), 0);

    if (summary) {
      summary.innerHTML = [
        `<span class="email-pill">${emailAccountsState.length} account${emailAccountsState.length === 1 ? '' : 's'}</span>`,
        `<span class="email-pill ${totalRemaining === 0 ? 'danger' : 'good'}">${totalRemaining} sends left today</span>`,
        `<span class="email-pill active">Active: ${escHtml(activeAccount.name || activeAccount.user)}</span>`
      ].join('');
    }
    if (from) {
      from.textContent = activeAccount.name && activeAccount.name !== activeAccount.user
        ? `${activeAccount.name} <${activeAccount.user}>`
        : activeAccount.user;
    }

    el.innerHTML = emailAccountsState.map(a => {
      const pct = a.limit ? Math.min(Math.round((a.dailySent / a.limit) * 100), 100) : 0;
      const remaining = typeof a.remainingToday === 'number'
        ? a.remainingToday
        : Math.max((a.limit || 0) - (a.dailySent || 0), 0);
      const displayName = escHtml(a.name || a.user);
      const userLine = a.name && a.name !== a.user ? escHtml(a.user) : 'SMTP sender';
      return `<div class="email-account-card ${a.active ? 'active' : ''}">
        <div class="email-account-top">
          <div>
            <div class="email-account-name">${displayName}</div>
            <div class="email-account-sub">${userLine}</div>
          </div>
          <span class="email-account-badge ${a.active ? 'active' : 'idle'}">${a.active ? 'Active' : 'Standby'}</span>
        </div>
        <div class="email-account-meta">
          <div><span>Sent today</span><strong>${a.dailySent}/${a.limit}</strong></div>
          <div><span>Remaining</span><strong>${remaining}</strong></div>
          <div><span>Lifetime sent</span><strong>${a.totalSent || 0}</strong></div>
        </div>
        <div class="email-account-bar"><div style="width:${pct}%"></div></div>
      </div>`;
    }).join('');
    updateEmailAudienceSummary();
  }).catch(() => {
    emailAccountsState = [];
    updateEmailAudienceSummary();
  });
}

function testEmailConn(evt) {
  const btn = evt?.currentTarget;
  if (btn) {
    btn.textContent = 'Testing...';
    btn.disabled = true;
  }
  fetch('/api/email/test').then(r => r.json()).then(d => {
    if (btn) {
      btn.textContent = 'Test All Accounts';
      btn.disabled = false;
    }
    if (d.results) {
      const header = d.note ? `${d.note}\n\n` : '';
      const lines = d.results.map(r => {
        const status = r.ok
          ? `PASS  ${r.user} - OK (${r.sent}/${r.configuredLimit} today)`
          : `FAIL  ${r.user} - ${r.error}`;
        const providerLimit = r.estimatedOriginalLimit ? `${r.estimatedOriginalLimit}/day` : 'Unknown';
        const details = `   Config limit: ${r.configuredLimit}/day | Provider estimate: ${providerLimit}`;
        const note = r.limitNote ? `\n   Note: ${r.limitNote}` : '';
        return status + '\n' + details + note;
      }).join('\n\n');
      alert(header + lines);
      loadEmailAccounts();
    } else {
      toast(d.msg || (d.ok ? 'Connected' : 'Connection failed'));
    }
  }).catch(() => {
    if (btn) {
      btn.textContent = 'Test All Accounts';
      btn.disabled = false;
    }
    toast('Could not test email accounts');
  });
}

function switchEmailContactTab(tab) {
  document.getElementById('email-contact-tab-file').style.display = tab === 'file' ? 'block' : 'none';
  document.getElementById('email-contact-tab-sheet').style.display = tab === 'sheet' ? 'block' : 'none';
  document.getElementById('email-tab-file').className = 'btn ' + (tab === 'file' ? 'btn-purple' : 'btn-ghost');
  document.getElementById('email-tab-sheet').className = 'btn ' + (tab === 'sheet' ? 'btn-purple' : 'btn-ghost');
}

function parseEmailSheet() {
  const url = document.getElementById('email-sheet-url').value.trim();
  if (!url) return toast('Paste Google Sheet URL first');
  renderEmailParseStatus('Loading Google Sheet...');
  fetch('/api/email/parse-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  }).then(r => r.json()).then(d => handleEmailParseResult(d));
}

function parseEmailContacts() {
  const file = document.getElementById('email-contacts-file').files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  renderEmailParseStatus(`Parsing ${file.name}...`);
  fetch('/api/email/parse', { method: 'POST', body: fd }).then(r => r.json()).then(d => handleEmailParseResult(d));
}

function handleEmailParseResult(d) {
  if (d.error) {
    renderEmailParseStatus(d.error, 'error');
    return;
  }
  emailContacts = d.contacts;
  emailHeaders = d.headers;
  renderEmailParseStatus(`${d.total} contacts loaded and ready for personalization.`, 'success');
  renderEmailHeaderChips(d.headers || []);
  updateEmailAudienceSummary();
  updateEmailPreview();
}

function insertEmailPlaceholder(h) {
  const editor = document.getElementById('email-editor');
  // If source mode is open, insert into textarea
  const src = document.getElementById('email-html-src');
  if (src.style.display !== 'none') {
    const pos = src.selectionStart;
    src.value = src.value.slice(0, pos) + `{{${h}}}` + src.value.slice(pos);
    src.focus(); src.selectionStart = src.selectionEnd = pos + h.length + 4;
    syncEditorFromSource();
    return;
  }
  // Insert at cursor in contenteditable
  editor.focus();
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(`{{${h}}}`));
    range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
  } else {
    editor.innerHTML += `{{${h}}}`;
  }
  updateEmailPreview();
}

function getEmailHTML() {
  return document.getElementById('email-editor').innerHTML;
}

function efmt(cmd, val) {
  document.getElementById('email-editor').focus();
  document.execCommand(cmd, false, val || null);
  updateEmailPreview();
}

function insertEmailLink() {
  const url = prompt('Enter URL:', 'https://');
  if (!url) return;
  const text = prompt('Link text:', url);
  document.getElementById('email-editor').focus();
  document.execCommand('insertHTML', false, `<a href="${url}" style="color:#263291">${text || url}</a>`);
  updateEmailPreview();
}

function insertEmailImage() {
  const url = prompt('Image URL:');
  if (!url) return;
  document.getElementById('email-editor').focus();
  document.execCommand('insertHTML', false, `<img src="${url}" style="max-width:100%;border-radius:6px" />`);
  updateEmailPreview();
}

function toggleEmailSource() {
  const editor = document.getElementById('email-editor');
  const src = document.getElementById('email-html-src');
  const btn = document.getElementById('btn-html-src');
  if (src.style.display === 'none') {
    src.value = editor.innerHTML;
    src.style.display = 'block';
    editor.style.display = 'none';
    btn.classList.add('active');
  } else {
    editor.innerHTML = src.value;
    src.style.display = 'none';
    editor.style.display = 'block';
    btn.classList.remove('active');
    updateEmailPreview();
  }
  updateEmailAudienceSummary();
}

function syncEditorFromSource() {
  document.getElementById('email-editor').innerHTML = document.getElementById('email-html-src').value;
  updateEmailPreview();
}

function handleEditorTab(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
  }
}

function syncEmailPreviewFullscreenButton() {
  const btn = document.getElementById('btn-preview-fullscreen');
  if (!btn) return;
  const shell = document.querySelector('#page-email .email-preview-shell');
  const inFullscreen = document.fullscreenElement === shell;
  btn.textContent = inFullscreen ? 'Exit Full Screen' : 'Full Screen Preview';
}

async function toggleEmailPreviewFullscreen() {
  const shell = document.querySelector('#page-email .email-preview-shell');
  if (!shell) return;
  try {
    if (document.fullscreenElement === shell) {
      await document.exitFullscreen();
    } else if (!document.fullscreenElement) {
      await shell.requestFullscreen();
    }
  } catch (_) {
    toast('Fullscreen is not available in this browser');
  } finally {
    syncEmailPreviewFullscreenButton();
  }
}

document.addEventListener('fullscreenchange', syncEmailPreviewFullscreenButton);

function updateEmailPreview() {
  const html = getEmailHTML();
  const sample = emailContacts[0] || emailHeaders.reduce((o, h) => ({ ...o, [h]: `[${h}]` }), {});

  // Fill {{placeholders}} in HTML string
  const filled = html.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim();
    const match = Object.keys(sample).find(c => c.toLowerCase() === k.toLowerCase());
    return `<span style="background:#eef1ff;color:#263291;border-radius:3px;padding:0 2px">${match !== undefined ? escHtml(sample[match]) : `{{${k}}}`}</span>`;
  });

  document.getElementById('email-preview').innerHTML = filled
    ? `<div class="email-render-frame">${filled}</div>`
    : '<div class="email-preview-placeholder">Preview appears here</div>';

  // Update fake email chrome
  const subj = document.getElementById('email-subject').value;
  const subjFilled = subj.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const k = key.trim();
    const match = Object.keys(sample).find(c => c.toLowerCase() === k.toLowerCase());
    return match !== undefined ? (sample[match] || `{{${k}}}`) : `{{${k}}}`;
  });
  document.getElementById('preview-subject-line').textContent = subjFilled || '-';

  if (emailContacts[0]) {
    const emailKey = Object.keys(emailContacts[0]).find(k => /email|mail/i.test(k));
    document.getElementById('preview-to').textContent = emailKey ? emailContacts[0][emailKey] : 'recipient@example.com';
  } else {
    document.getElementById('preview-to').textContent = 'recipient@example.com';
  }
  updateEmailAudienceSummary();
}

function startEmailCampaign() {
  if (!emailContacts.length) return toast('Upload contacts first');
  const template = getEmailHTML().trim();
  const subject  = document.getElementById('email-subject').value.trim();
  if (!template || template === '<br>') return toast('Write email body first');
  if (!subject)  return toast('Write subject line first');
  saveEmailPreset(false);
  activeEmailId = null;
  document.getElementById('btn-send-email').disabled = true;
  document.getElementById('btn-stop-email').style.display = 'inline-block';
  document.getElementById('btn-download-email-log').style.display = 'none';
  document.getElementById('email-progress').style.display = 'block';
  document.getElementById('email-prog-total').textContent = emailContacts.length;
  document.getElementById('email-prog-status').textContent = 'Running...';
  updateEmailAudienceSummary();
  fetch('/api/email/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contacts: emailContacts, subject, template,
      delayMs: (parseInt(document.getElementById('email-delay').value) || 5) * 1000
    })
  }).then(r => r.json()).then(d => {
    if (d.error) { toast(d.error); resetEmailUI(); return; }
    activeEmailId = d.id;
  });
}

function stopEmailCampaign() {
  if (!activeEmailId) return;
  fetch('/api/email/stop/' + activeEmailId, { method: 'POST' });
  document.getElementById('email-prog-status').textContent = 'Stopping after the current send...';
}

function downloadEmailLog() { if (activeEmailId) window.open('/api/email/' + activeEmailId + '/log'); }

function resetEmailUI() {
  document.getElementById('btn-stop-email').style.display = 'none';
  updateEmailAudienceSummary();
}

socket.on('email_progress', (d) => {
  document.getElementById('email-prog-sent').textContent = d.sent;
  document.getElementById('email-prog-failed').textContent = d.failed;
  document.getElementById('email-prog-total').textContent = d.total;
  document.getElementById('email-prog-bar').style.width = d.total
    ? Math.round(((d.sent + d.failed) / d.total) * 100) + '%'
    : '0%';
  if (d.activeAccount) {
    document.getElementById('email-prog-status').textContent =
      `Running via ${d.activeAccount} (${d.accountSent}/${d.accountLimit} today)`;
  }
  if (d.status === 'done' || d.status === 'stopped') {
    document.getElementById('email-prog-status').textContent = d.status === 'done'
      ? `Done. Sent: ${d.sent}, Failed: ${d.failed}` : `Stopped. Sent: ${d.sent}`;
    document.getElementById('btn-download-email-log').style.display = 'inline-block';
    resetEmailUI();
    loadEmailAccounts(); // refresh account counters
  }
});
function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}


let botVerifierStatus = 'stopped';
function updateVerifierStatus(status) {
  botVerifierStatus = status;
  const badge = document.getElementById('status-badge-verifier');
  const text = document.getElementById('status-text-verifier');
  const connectBtn = document.getElementById('btn-verifier-start');
  if(!badge) return;
  badge.className = 'status-badge ' + status;
  const labels = { ready: 'Ready', stopped: 'Stopped', starting: 'Starting...', qr: 'Waiting QR' };
  text.textContent = "Verifier: " + (labels[status] || status);
  if (connectBtn) {
    connectBtn.disabled = status !== 'stopped';
    connectBtn.textContent = status === 'ready' ? 'Verifier Connected' : status === 'starting' ? 'Connecting...' : status === 'qr' ? 'Waiting QR' : 'Connect Verifier';
  }
  document.getElementById('btn-verifier-stop').disabled = status === 'stopped';
  if (status !== 'qr') document.getElementById('qr-verifier-container').style.display = 'none';
}

function showVerifierQR(qrDataUrl) {
  const c = document.getElementById('qr-verifier-container');
  c.style.display = 'block';
  document.getElementById('qr-verifier-img').src = qrDataUrl;
  updateVerifierStatus('qr');
}

function connectVerifier() {
  if (botVerifierStatus === 'ready') { toast('Verifier already connected'); return; }
  fetch('/api/botVerifier/start', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.ok) toast(d.msg || 'Start failed');
  });
}
function botVerifierControl(action) {
  fetch('/api/botVerifier/' + action, { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.ok) toast(d.msg || action + ' failed');
  });
}
function botVerifierLogout() {
  if (!confirm('Logout verifier session?')) return;
  fetch('/api/botVerifier/logout', { method: 'POST' }).then(r => r.json()).then(d => {
    toast(d.msg || 'Logged out');
  });
}
