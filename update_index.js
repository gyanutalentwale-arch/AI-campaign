const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const target2 = `// QR Code
client.on('qr', async (qr) => {
    console.log('QR code generated. Scan it from the dashboard.');
    state.botStatus = 'qr';
    io.emit('status', 'qr');
    try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        state.qrCode = qrDataUrl;
        io.emit('qr', qrDataUrl);
    } catch (_) {}
});`;

const repl2 = `// QR Code
client.on('qr', async (qr) => {
    console.log('Sender QR code generated. Scan it from the dashboard.');
    state.botStatus = 'qr';
    io.emit('status', 'qr');
    try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        state.qrCode = qrDataUrl;
        io.emit('qr', qrDataUrl);
    } catch (_) {}
});

clientVerifier.on('qr', async (qr) => {
    console.log('Verifier QR code generated. Scan it from the dashboard.');
    state.botVerifierStatus = 'qr';
    io.emit('status_verifier', 'qr');
    try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        state.verifierQrCode = qrDataUrl;
        io.emit('qr_verifier', qrDataUrl);
    } catch (_) {}
});`;

code = code.replace(target2, repl2);

const target3 = `// Auth failure & disconnection
client.on('auth_failure', (msg) => { console.error('❌ Auth failed:', msg); state.botStatus = 'stopped'; io.emit('status', 'stopped'); });
client.on('disconnected', (reason) => {
    const reasonText = String(reason || '').toLowerCase();
    state.botClient = null;
    state.botStatus = 'stopped';
    io.emit('status', 'stopped');
    // For manual stop/logout, wait for explicit dashboard start.
    if (reasonText.includes('navigation') || reasonText.includes('logout')) {
        console.log('Disconnected:', reason, '- Bot stopped. Use WhatsApp Connect to start again.');
        return;
    }
    console.log('Disconnected:', reason, '- Reconnecting...');
    state.botStatus = 'starting';
    io.emit('status', 'starting');
    client.initialize();
});
// Client Ready - Process unread messages
client.on('ready', async () => {
    console.log('✅ WhatsApp Bot is ready!');
    state.botStatus = 'ready';
    state.botClient = client;
    state.qrCode = null;
    io.emit('status', 'ready');

    if (!state.autoReply) {
        console.log('⏸️ Auto Reply is OFF — skipping unread messages. Enable from dashboard.');
        return;
    }
    await processUnreadMessages('ready');
});`;

const repl3 = `// Auth failure & disconnection
client.on('auth_failure', (msg) => { console.error('❌ Sender Auth failed:', msg); state.botStatus = 'stopped'; io.emit('status', 'stopped'); });
client.on('disconnected', (reason) => {
    const reasonText = String(reason || '').toLowerCase();
    state.botClient = null;
    state.botStatus = 'stopped';
    io.emit('status', 'stopped');
    // For manual stop/logout, wait for explicit dashboard start.
    if (reasonText.includes('navigation') || reasonText.includes('logout')) {
        console.log('Sender Disconnected:', reason, '- Bot stopped. Use WhatsApp Connect to start again.');
        return;
    }
    console.log('Sender Disconnected:', reason, '- Reconnecting...');
    state.botStatus = 'starting';
    io.emit('status', 'starting');
    client.initialize();
});

clientVerifier.on('auth_failure', (msg) => { console.error('❌ Verifier Auth failed:', msg); state.botVerifierStatus = 'stopped'; io.emit('status_verifier', 'stopped'); });
clientVerifier.on('disconnected', (reason) => {
    const reasonText = String(reason || '').toLowerCase();
    state.botVerifierClient = null;
    state.botVerifierStatus = 'stopped';
    io.emit('status_verifier', 'stopped');
    if (reasonText.includes('navigation') || reasonText.includes('logout')) {
        console.log('Verifier Disconnected:', reason, '- Bot stopped. Use Connect Verifier to start again.');
        return;
    }
    console.log('Verifier Disconnected:', reason, '- Reconnecting...');
    state.botVerifierStatus = 'starting';
    io.emit('status_verifier', 'starting');
    clientVerifier.initialize();
});

// Client Ready - Process unread messages
client.on('ready', async () => {
    console.log('✅ WhatsApp Sender is ready!');
    state.botStatus = 'ready';
    state.botClient = client;
    state.qrCode = null;
    io.emit('status', 'ready');

    if (!state.autoReply) {
        console.log('⏸️ Auto Reply is OFF — skipping unread messages. Enable from dashboard.');
        return;
    }
    await processUnreadMessages('ready');
});

clientVerifier.on('ready', async () => {
    console.log('✅ WhatsApp Verifier is ready!');
    state.botVerifierStatus = 'ready';
    state.botVerifierClient = clientVerifier;
    state.verifierQrCode = null;
    io.emit('status_verifier', 'ready');
});`;

code = code.replace(target3, repl3);
fs.writeFileSync('index.js', code);
console.log('chunks done');
