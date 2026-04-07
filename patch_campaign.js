const fs = require('fs');

let code = fs.readFileSync('src/services/campaign.service.js', 'utf8');

const targetStr = `        const verification = await verifyWhatsAppRecipient(
          state.botClient,
          waId,
        );`;

const newStr = `        // 1st login (Verifier) se number verify hoga
        const verifier = state.botVerifierClient || state.botClient; // fallback if verifier not running
        const verification = await verifyWhatsAppRecipient(
          verifier,
          waId,
        );`;

code = code.replace(targetStr, newStr);

fs.writeFileSync('src/services/campaign.service.js', code);
console.log('campaign verification logic updated');
