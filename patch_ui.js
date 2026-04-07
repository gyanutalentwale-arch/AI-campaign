const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

// Replace status badge with two badges
html = html.replace(
`<div class="page-header">
        <h1>Overview</h1>
        <span class="status-badge stopped" id="status-badge"><span class="dot"></span> <span id="status-text">Stopped</span></span>
      </div>`,
`<div class="page-header">
        <h1>Overview</h1>
        <div style="display:flex;gap:10px;">
          <span class="status-badge stopped" id="status-badge"><span class="dot"></span> <span id="status-text">Sender: Stopped</span></span>
          <span class="status-badge stopped" id="status-badge-verifier"><span class="dot"></span> <span id="status-text-verifier">Verifier: Stopped</span></span>
        </div>
      </div>`
);

// Replace controls
html = html.replace(
`<div class="controls">
        <button class="btn btn-green" id="btn-start" onclick="connectWhatsApp()">WhatsApp Connect</button>
        <button class="btn btn-red" id="btn-stop" onclick="botControl('stop')">Stop Bot</button>
        <button class="btn btn-yellow" id="btn-restart" onclick="botControl('restart')">Restart</button>
        <button class="btn btn-ghost" id="btn-logout" onclick="botLogout()">Logout Session</button>
      </div>`,
`<div class="controls">
        <div style="display:flex;flex-direction:column;gap:5px;">
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn btn-green" id="btn-start" onclick="connectWhatsApp()">Connect Sender</button>
          <button class="btn btn-red" id="btn-stop" onclick="botControl('stop')">Stop Sender</button>
          <button class="btn btn-yellow" id="btn-restart" onclick="botControl('restart')">Restart Sender</button>
          <button class="btn btn-ghost" id="btn-logout" onclick="botLogout()">Logout Sender</button>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn btn-green" id="btn-verifier-start" onclick="connectVerifier()">Connect Verifier</button>
          <button class="btn btn-red" id="btn-verifier-stop" onclick="botVerifierControl('stop')">Stop Verifier</button>
          <button class="btn btn-yellow" id="btn-verifier-restart" onclick="botVerifierControl('restart')">Restart Verifier</button>
          <button class="btn btn-ghost" id="btn-verifier-logout" onclick="botVerifierLogout()">Logout Verifier</button>
        </div>
        </div>
      </div>`
);

// Add verifier QR container
html = html.replace(
`<div id="qr-container">
        <p style="margin-bottom:12px;color:var(--text);font-weight:600;">Scan QR Code</p>
        <img id="qr-img" src="" alt="QR Code" />
        <p>WhatsApp -> Linked Devices -> Link a Device</p>
      </div>`,
`<div id="qr-container">
        <p style="margin-bottom:12px;color:var(--text);font-weight:600;">Sender QR Code</p>
        <img id="qr-img" src="" alt="QR Code" />
      </div>
      <div id="qr-verifier-container" style="display:none;margin-top:10px;">
        <p style="margin-bottom:12px;color:var(--text);font-weight:600;">Verifier QR Code</p>
        <img id="qr-verifier-img" src="" alt="Verifier QR Code" />
      </div>`
);

fs.writeFileSync('public/index.html', html);
console.log('UI HTML updated');

let dash = fs.readFileSync('public/assets/dashboard.js', 'utf8');

dash = dash.replace(
`socket.on('init', (data) => {
  updateStatus(data.botStatus);
  updateStats(data.stats);
  updateEmailStats(data.emailStats);
  data.logs.forEach(addLogEntry);
  updateUsers(data.activeUsers);
  if (data.qrCode) showQR(data.qrCode);
  if (data.autoReply !== undefined) setAutoReplyUI(data.autoReply);
  if (data.aiAuth) renderGoogleAiAuth(data.aiAuth);
  if (!campaignPresetLoaded) loadCampaignPreset();
  if (!parsedContacts.length) restoreCampaignParsedState();
  restoreActiveCampaignState();
  if (!emailPresetLoaded) loadEmailPreset();
});`,
`socket.on('init', (data) => {
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
});`
);

dash = dash.replace(
`socket.on('log', addLogEntry);`,
`socket.on('log', addLogEntry);
socket.on('status_verifier', updateVerifierStatus);
socket.on('qr_verifier', showVerifierQR);`
);

const newUpdates = `
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
`;

dash += newUpdates;
fs.writeFileSync('public/assets/dashboard.js', dash);
console.log('UI Dash updated');
