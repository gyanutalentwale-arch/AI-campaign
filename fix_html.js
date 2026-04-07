const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

if (!html.includes('id="page-verify"')) {
    html = html.replace('<!-- Config -->', `
<!-- Bulk Verifier -->
<div class="page" id="page-verify">
  <div class="page-header">
    <h1>Bulk Number Verifier</h1>
    <p>Scan a list of numbers to check if they are available on WhatsApp, and download the cleaned list.</p>
  </div>
  <div class="card" style="padding:18px;margin-bottom:16px;">
    <div class="form-group" style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px;">Upload Contacts (CSV/Excel)</label>
      <input type="file" id="verify-file" accept=".csv,.xlsx,.xls" style="background:#f4f6ff;border:1px solid var(--border);border-radius:8px;padding:8px;font-size:12px;color:var(--text);width:100%;">
    </div>
    <div style="font-size:12px;font-weight:700;text-align:center;margin-bottom:12px;color:var(--muted)">OR</div>
    <div class="form-group">
      <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px;">Google Sheet URL</label>
      <div style="display:flex;gap:10px;">
        <input type="text" id="verify-sheet-url" placeholder="https://docs.google.com/spreadsheets/..." style="flex:1;background:#f4f6ff;border:1px solid var(--border);border-radius:8px;padding:8px;font-size:12px;color:var(--text);">
        <button class="btn btn-purple" id="btn-verify-load-sheet">Load Sheet</button>
      </div>
      <p class="hint" style="font-size:11px;color:var(--muted);margin-top:4px;">Ensure "Anyone with the link can view"</p>
    </div>
    
    <div id="verify-parsed-info" class="hint" style="margin-bottom:15px;color:var(--green);display:none;font-weight:600;font-size:13px;"></div>
    
    <div class="controls" style="margin-top:20px;">
      <button class="btn btn-green" id="btn-verify-start" disabled>Start Verification</button>
      <button class="btn btn-red" id="btn-verify-stop" style="display:none;">Stop</button>
    </div>
  </div>
  
  <div class="card" id="verify-progress-card" style="display:none;padding:18px;">
    <h3 style="font-size:13px;margin-bottom:12px;color:var(--text);font-weight:bold;">Verification Progress</h3>
    <div style="background:var(--border);border-radius:4px;height:8px;overflow:hidden;margin-bottom:12px;">
      <div id="verify-progress-fill" style="background:var(--green);height:100%;width:0%;transition:width .4s;"></div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:14px;font-weight:600;">
      <span style="color:var(--muted)">Total: <b id="verify-stat-total" style="color:var(--text)">0</b></span>
      <span style="color:var(--green)">Valid: <b id="verify-stat-valid">0</b></span>
      <span style="color:var(--red)">Invalid: <b id="verify-stat-invalid">0</b></span>
      <span style="color:var(--yellow)">Failed: <b id="verify-stat-failed">0</b></span>
    </div>
    <div style="margin-top:20px;text-align:center;">
       <a class="btn btn-purple" id="btn-verify-download" style="display:none;text-decoration:none;display:inline-block;padding:8px 16px;border-radius:6px;font-weight:600;" href="#" target="_blank">Download Valid Numbers</a>
    </div>
  </div>
</div>

<!-- Config -->`);
}

html = html.replace(
      '<div class="nav-item" data-page="campaign" data-short="BC">Bulk Campaign</div>\n      <div class="nav-item" data-page="email" data-short="EM">Email Campaign</div>\n      <div class="nav-item" data-page="config"',
      '<div class="nav-item" data-page="campaign" data-short="BC">Bulk Campaign</div>\n      <div class="nav-item" data-page="email" data-short="EM">Email Campaign</div>\n      <div class="nav-item" data-page="verify" data-short="VF">Bulk Verifier</div>\n      <div class="nav-item" data-page="config"'
);

html = html.replace(
      '<div class="nav-item" data-page="email" data-short="EM">Email Campaign</div>\r\n      <div class="nav-item" data-page="config"',
      '<div class="nav-item" data-page="email" data-short="EM">Email Campaign</div>\r\n      <div class="nav-item" data-page="verify" data-short="VF">Bulk Verifier</div>\r\n      <div class="nav-item" data-page="config"'
);

fs.writeFileSync('public/index.html', html, 'utf8');
console.log('Fixed HTML robustly');
