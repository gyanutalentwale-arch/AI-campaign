const fs = require('fs');
let css = fs.readFileSync('public/assets/dashboard.css', 'utf8');

// We will inject some premium overrides at the end of the file.
const enhancements = `

/* --- PREMIUM UI ENHANCEMENTS FOR EMAIL CAMPAIGN --- */

#page-email .card.email-panel {
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03), 0 1px 3px rgba(0, 0, 0, 0.02);
  border-radius: 14px;
  padding: 24px;
}

#page-email .card.email-panel:hover {
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.05), 0 2px 5px rgba(0, 0, 0, 0.03);
  transform: translateY(-2px);
  border-color: rgba(38, 50, 145, 0.15);
}

#page-email .section-title {
  font-family: var(--font-head);
  font-size: 16px;
  font-weight: 700;
  color: #111827;
  letter-spacing: -0.3px;
  margin-bottom: 6px;
}

#page-email .email-helper {
  color: #6b7280;
  font-size: 13px;
  line-height: 1.5;
  margin-top: 2px;
}

.email-page-header {
  padding: 0 0 24px 0;
  background: transparent;
  border: none;
  box-shadow: none;
  margin-bottom: 0;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  border-radius: 0;
}

.email-page-title h1 {
  font-family: var(--font-head);
  font-weight: 700;
  font-size: 28px;
  color: #111827;
  letter-spacing: -0.5px;
}

.email-page-subtitle {
  color: #6b7280;
  font-size: 14px;
  max-width: 600px;
  margin-top: 6px;
}

.email-layout {
  grid-template-columns: 420px minmax(0, 1fr);
  gap: 24px;
  margin-top: 24px;
}

.email-accounts-card {
  margin-top: 24px;
  margin-bottom: 0;
}

.email-tab-row {
  background: #f3f4f6;
  padding: 4px;
  border-radius: 10px;
  gap: 4px;
}

.email-tab-btn {
  background: transparent;
  color: #6b7280;
  border: none;
  box-shadow: none;
  font-weight: 600;
  padding: 8px 12px;
  border-radius: 8px;
  transition: all 0.2s;
}

.email-tab-btn.btn-purple {
  background: #ffffff;
  color: #111827;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.email-tab-btn:hover:not(.btn-purple) {
  color: #374151;
  background: rgba(0,0,0,0.02);
}

.email-upload-input, .email-input-row input, .email-field input {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px 14px;
  color: #111827;
  font-size: 13px;
  transition: all 0.2s;
}

.email-upload-input:focus, .email-input-row input:focus, .email-field input:focus {
  background: #ffffff;
  border-color: #6366f1;
  box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
}

.email-field label {
  color: #374151;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
  font-size: 13px;
  margin-bottom: 6px;
}

.email-toolbar {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-bottom: none;
  padding: 8px 12px;
  border-radius: 12px 12px 0 0;
}

.email-editor-shell {
  border: 1px solid #e5e7eb;
  border-radius: 0 0 12px 12px;
  background: #ffffff;
}

.tb-btn {
  background: transparent;
  color: #4b5563;
  border: none;
  border-radius: 6px;
  font-weight: 500;
}

.tb-btn:hover {
  background: #f3f4f6;
  color: #111827;
  transform: none;
  border-color: transparent;
}

.tb-btn.active {
  background: #e0e7ff;
  color: #4338ca;
  border-color: transparent;
}

.tb-sep {
  background: #e5e7eb;
}

#btn-send-email {
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  padding: 14px;
  transition: all 0.2s;
}

#btn-send-email:not(:disabled):hover {
  background: #1f2937;
  transform: translateY(-1px);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

.email-preview-shell {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}

.email-preview-head {
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  padding: 16px 20px;
}

.email-preview-row span:last-child {
  color: #111827;
}

.email-preview-canvas {
  background: #ffffff;
  padding: 32px;
  font-size: 14px;
  color: #374151;
  min-height: 400px;
}

.email-account-card {
  border-color: #e5e7eb;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.email-account-card.active {
  border-color: #6366f1;
  box-shadow: 0 0 0 1px #6366f1, 0 4px 6px -1px rgba(0, 0, 0, 0.1);
}

.email-account-meta div {
  background: #f9fafb;
  border-color: #e5e7eb;
}

.email-account-meta span {
  color: #6b7280;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}

.email-account-meta strong {
  color: #111827;
}

/* Make headers look like minimal pills */
.email-pill {
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  color: #374151;
  font-weight: 600;
}

.email-status-note, #email-ready-note {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #475569;
  border-radius: 8px;
  padding: 12px 14px;
}

/* Minimalist forms */
.email-form-grid {
  gap: 16px;
}

/* Beautiful placeholders */
.email-placeholder-chip {
  background: #e0e7ff;
  border: 1px solid #c7d2fe;
  color: #4338ca;
  font-weight: 600;
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 6px;
}

.email-placeholder-chip:hover {
  background: #c7d2fe;
  color: #3730a3;
  transform: none;
}
`;

if (!css.includes('PREMIUM UI ENHANCEMENTS')) {
    fs.writeFileSync('public/assets/dashboard.css', css + enhancements);
    console.log('CSS patch applied!');
} else {
    console.log('Patch already applied.');
}
