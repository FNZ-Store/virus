// index.js
import { Router } from 'itty-router';

const router = Router();

// -------------------- In-memory session (temporary) --------------------
const userSessions = new Map();

function clearUserSession(userId) {
    userSessions.delete(userId);
    console.log(`Session cleared for user ${userId}`);
}

function setUserSession(userId, sessionData) {
    userSessions.set(userId, {
        ...sessionData,
        timestamp: Date.now()
    });
    console.log(`Session set for user ${userId}:`, sessionData.action || 'session');
}

function getUserSession(userId) {
    const session = userSessions.get(userId);
    if (session) {
        const sessionAge = Date.now() - session.timestamp;
        if (sessionAge > 30 * 60 * 1000) {
            clearUserSession(userId);
            return null;
        }
    }
    return session;
}

// -------------------- KV Helpers (uses binding BOT_DB) --------------------
async function loadKV(key) {
    try {
        const raw = await BOT_DB.get(key, 'json');
        return raw || {};
    } catch (err) {
        console.error('KV load error', err);
        return {};
    }
}
async function saveKV(key, value) {
    try {
        await BOT_DB.put(key, JSON.stringify(value));
        return true;
    } catch (err) {
        console.error('KV save error', err);
        return false;
    }
}

// shortcuts that use env binding in handler (we will set BOT_DB from env below at runtime)
let BOT_DB = null; // will be set inside router handler from env.BOT_DB

// -------------------- Util functions --------------------
function formatNumber(num) {
    if (num === undefined || num === null) return "0";
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function escapeHtml(text) {
    if (text === undefined || text === null) return '';
    return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function boxText(lines) {
    // returns caption text with a box-like separators using unicode and code blocks
    // lines: array of strings
    const top = '┏' + '━'.repeat(36) + '┓';
    const bottom = '┗' + '━'.repeat(36) + '┛';
    const middle = lines.map(l => '┃ ' + l.padEnd(36) + ' ┃').join('\n');
    return `${top}\n${middle}\n${bottom}`;
}
function nowISO() { return new Date().toISOString(); }

// -------------------- Telegram helpers --------------------
async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error('sendTelegramMessage error', e);
        return null;
    }
}

async function sendTelegramPhoto(botToken, chatId, photoUrl, caption = '', replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
    const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: parseMode, disable_notification: false };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error('sendTelegramPhoto error', e);
        return null;
    }
}

async function editMessageText(botToken, chatId, messageId, text, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error('editMessageText error', e);
        return null;
    }
}

async function answerCallbackQuery(botToken, callbackQueryId, text = null, showAlert = false) {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    const payload = { callback_query_id: callbackQueryId };
    if (text) { payload.text = text; payload.show_alert = showAlert; }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error('answerCallbackQuery error', e);
        return null;
    }
}

// -------------------- DB structures --------------------
// BOT_DB keys used:
// - users: { [userId]: { joinDate: ISO, chatId } }
// - accounts/products: { [sku]: { title, description, price, stock, list: [ "email|pass", ... ] } }
// - transactions: { [userId]: [ ... ] }
// - pending_payments: { [trxid]: { userId, productSku, qty, amount, createdAt, expiresAt, status } }
// - broadcast: { enabled: bool, message: string, lastSentAt: ISO, sentThisHour: int }

// -------------------- UI builders --------------------
function buildCatalogMessage(accountsObj) {
    const keys = Object.keys(accountsObj || {});
    if (keys.length === 0) {
        return `📦 <b>KATALOG PRODUK</b>\n\nBelum ada produk tersedia saat ini.`;
    }
    const lines = [];
    lines.push(`📦 <b>KATALOG PRODUK</b>\n`);
    keys.forEach((k, idx) => {
        const p = accountsObj[k];
        const stokText = (!Array.isArray(p.list) || p.list.length === 0) ? '❌ Habis' : `✅ Stok Tersedia: ${p.list.length}`;
        lines.push(`<b>[ ${idx + 1} ] ${escapeHtml(p.title || p.name || `Produk ${idx+1}`)}</b>\n┄┄┄┄┄┄┄┄\n${p.price ? '💰 Harga: Rp ' + formatNumber(p.price) + '\n' : ''}${stokText}\n`);
    });
    lines.push(`\n<code>pilih produk yang anda inginkan:</code>`);
    return lines.join('\n');
}

function buildProductDetailMessage(product, qty = 1) {
    const price = product.price || 0;
    const total = price * qty;
    const stockText = (!Array.isArray(product.list) || product.list.length === 0) ? '❌ Habis' : `✅ Stok Tersisa: ${product.list.length}`;
    const desc = product.description || 'Tidak ada deskripsi.';
    const boxLines = [
        `_PRODUK_: ${product.title || product.name || 'Produk'}`,
        `Harga Satuan: Rp ${formatNumber(price)}`,
        `${stockText}`,
        ``,
        `📝 Deskripsi:`,
        `${desc}`,
        ``,
        `Total Harga: Rp ${formatNumber(total)}`,
        `Jumlah: ${qty}`
    ];
    // Use HTML formatting; we will supply as normal message
    return `📦 <b>${escapeHtml(product.title || product.name || 'Produk')}</b>\n\n💰 <b>Harga Satuan:</b> Rp ${formatNumber(price)}\n${stockText}\n\n<b>📝 Deskripsi:</b>\n${escapeHtml(desc)}\n\n<code>================================</code>\n<b>Total Harga:</b> Rp ${formatNumber(total)}\n\nSilakan tentukan jumlah yang ingin dibeli:`;
}

// -------------------- Payment (Invoice) helpers --------------------
async function createInvoice(env, metadata) {
    // metadata: { amount, productSku, qty, userId, description, callback_url(optional) }
    // Uses PAYMENT_API_URL & PAYMENT_API_KEY from env. This function attempts to post to provider and return parsed json.
    const apiUrl = env.PAYMENT_API_URL;
    const apiKey = env.PAYMENT_API_KEY;
    if (!apiUrl) throw new Error('PAYMENT_API_URL not configured');

    const payload = {
        amount: metadata.amount,
        trx_id: 'TRX' + Date.now().toString(36),
        description: metadata.description || `Pembelian ${metadata.productSku}`,
        callback_url: metadata.callback_url || (env.WEBHOOK_BASE_URL ? `${env.WEBHOOK_BASE_URL}/webhook` : undefined),
        // include custom metadata so callback can map to user
        metadata: {
            userId: metadata.userId,
            productSku: metadata.productSku,
            qty: metadata.qty
        }
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        // expected result: { status: true, trxid, qris_url, amount, fee, expired_at }
        return json;
    } catch (e) {
        console.error('createInvoice error', e);
        return null;
    }
}

async function verifyInvoiceStatus(env, trxid) {
    // optional: provider might have status endpoint; we attempt to call PAYMENT_API_URL + '/status'
    try {
        const apiKey = env.PAYMENT_API_KEY;
        const statusUrl = (env.PAYMENT_API_STATUS_URL) ? env.PAYMENT_API_STATUS_URL : (env.PAYMENT_API_URL + '/status');
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const res = await fetch(`${statusUrl}?trxid=${encodeURIComponent(trxid)}`, { headers });
        const j = await res.json();
        return j;
    } catch (e) {
        console.error('verifyInvoiceStatus error', e);
        return null;
    }
}

// -------------------- Core Handlers --------------------
async function handleStart(update, env) {
    const msg = update.message;
    const user = msg.from;
    const userId = user.id.toString();

    // register user in users DB
    const users = await loadKV('users') || {};
    if (!users[userId]) {
        users[userId] = { joinDate: nowISO(), chatId: user.id };
        await saveKV('users', users);
    }

    const accounts = await loadKV('accounts') || {};
    const stok = Object.keys(accounts).length;
    const adminUsername = env.ADMIN_USERNAME || "@admin";

    const message = `
🎊 <b>Selamat Datang di Bot Premium Store!</b>

┌─── 📦 <b>INFO SINGKAT</b> ───┐
│ 👤 <b>User ID:</b> <code>${userId}</code>
│ 📦 <b>Produk:</b> <code>${stok} item</code>
└─────────────────────

👨‍💼 <b>Admin:</b> ${adminUsername}

<code>================================</code>

✨ <b>Fitur:</b>
• 🛒 Beli Akun Otomatis (via QRIS)
• 📦 Pengiriman akun otomatis setelah pembayaran

Pilih menu di bawah untuk memulai:
    `;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🛒 Katalog Produk", callback_data: "catalog" }],
            [{ text: "👤 Profile", callback_data: "profile" }, { text: "ℹ️ Bantuan", callback_data: "help" }]
        ]
    };

    return await sendTelegramMessage(env.BOT_TOKEN, user.id, message, keyboard);
}

async function handleCatalog(update, env) {
    // supports callback_query or message
    const callbackQuery = update.callback_query;
    const from = callbackQuery ? callbackQuery.from : update.message.from;
    const userId = from.id.toString();

    const accounts = await loadKV('accounts') || {};
    const message = buildCatalogMessage(accounts);

    const keys = Object.keys(accounts);
    const buttons = [];
    // show up to first 6 as buttons in a row
    const row = [];
    for (let i = 0; i < Math.min(6, keys.length); i++) {
        row.push({ text: `${i+1}`, callback_data: `catalog_select_${i}` });
    }
    const reply = {
        inline_keyboard: [
            row,
            [{ text: "➡️ Selanjutnya", callback_data: "catalog_next" }],
            [{ text: "🔙 Kembali ke Menu", callback_data: "back_to_main" }]
        ]
    };

    if (callbackQuery) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, from.id, callbackQuery.message.message_id, message, reply);
    } else {
        return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, reply);
    }
}

async function handleCatalogSelect(update, env, index = 0) {
    const cb = update.callback_query;
    const from = cb.from;
    const userId = from.id.toString();

    const accounts = await loadKV('accounts') || {};
    const keys = Object.keys(accounts);
    if (!keys[index]) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Produk tidak ditemukan!", true);
        return;
    }
    const product = accounts[keys[index]];

    // default quantity stored in session
    setUserSession(userId, { action: 'browsing_product', productKey: keys[index], qty: 1 });

    const message = buildProductDetailMessage(product, 1);
    const keyboard = {
        inline_keyboard: [
            [
                { text: "➖", callback_data: "qty_decrease" },
                { text: "1", callback_data: "qty_show" },
                { text: "➕", callback_data: "qty_increase" }
            ],
            [
                { text: `🛒 Beli Semua Stok (${(product.list && product.list.length) || 0})`, callback_data: `buy_all` }
            ],
            [
                { text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }
            ],
            [
                { text: "🔙 Kembali ke Daftar", callback_data: "catalog" }
            ]
        ]
    };

    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard);
}

async function handleQtyChange(update, env, delta = 0) {
    const cb = update.callback_query;
    const userId = cb.from.id.toString();
    const session = getUserSession(userId);
    if (!session || session.action !== 'browsing_product') {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi produk tidak ditemukan. Silakan buka katalog lagi.", true);
        return;
    }
    const accounts = await loadKV('accounts') || {};
    const product = accounts[session.productKey];
    if (!product) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true);
        return;
    }

    let qty = session.qty || 1;
    qty = qty + delta;
    if (qty < 1) qty = 1;
    if (product.list && qty > product.list.length) qty = product.list.length;

    setUserSession(userId, { ...session, qty });

    const message = buildProductDetailMessage(product, qty);
    const keyboard = {
        inline_keyboard: [
            [
                { text: "➖", callback_data: "qty_decrease" },
                { text: `${qty}`, callback_data: "qty_show" },
                { text: "➕", callback_data: "qty_increase" }
            ],
            [
                { text: `🛒 Beli Semua Stok (${(product.list && product.list.length) || 0})`, callback_data: `buy_all` }
            ],
            [
                { text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }
            ],
            [
                { text: "🔙 Kembali ke Daftar", callback_data: "catalog" }
            ]
        ]
    };

    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard);
}

async function handleBuyAll(update, env) {
    const cb = update.callback_query;
    const userId = cb.from.id.toString();
    const session = getUserSession(userId);
    if (!session || session.action !== 'browsing_product') {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi produk tidak ditemukan. Silakan buka katalog lagi.", true);
        return;
    }
    const accounts = await loadKV('accounts') || {};
    const product = accounts[session.productKey];
    if (!product) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true);
        return;
    }
    const qty = (product.list && product.list.length) ? product.list.length : 1;
    setUserSession(userId, { ...session, qty });
    const message = buildProductDetailMessage(product, qty);
    const keyboard = {
        inline_keyboard: [
            [
                { text: "➖", callback_data: "qty_decrease" },
                { text: `${qty}`, callback_data: "qty_show" },
                { text: "➕", callback_data: "qty_increase" }
            ],
            [
                { text: `🛒 Beli Semua Stok (${(product.list && product.list.length) || 0})`, callback_data: "buy_all" }
            ],
            [
                { text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }
            ],
            [
                { text: "🔙 Kembali ke Daftar", callback_data: "catalog" }
            ]
        ]
    };

    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard);
}

async function handlePurchaseConfirm(update, env) {
    const cb = update.callback_query;
    const userId = cb.from.id.toString();
    const session = getUserSession(userId);
    if (!session || session.action !== 'browsing_product') {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi pembelian tidak ditemukan.", true);
        return;
    }

    const accounts = await loadKV('accounts') || {};
    const product = accounts[session.productKey];
    if (!product) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true);
        return;
    }

    const qty = session.qty || 1;
    if (!product.list || product.list.length < qty) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Stok tidak mencukupi.", true);
        return;
    }

    const total = (product.price || 0) * qty;

    // create invoice via provider
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    const invoiceMeta = {
        amount: total,
        productSku: session.productKey,
        qty,
        userId,
        description: `${product.title} x${qty}`,
        callback_url: env.WEBHOOK_BASE_URL ? `${env.WEBHOOK_BASE_URL}/webhook` : undefined
    };
    let invoiceResp;
    try {
        invoiceResp = await createInvoice(env, invoiceMeta);
    } catch (e) {
        console.error('invoice create failed', e);
        await sendTelegramMessage(env.BOT_TOKEN, cb.from.id, `❌ Gagal membuat invoice. Silakan coba lagi nanti.`);
        return;
    }
    if (!invoiceResp || !invoiceResp.status) {
        await sendTelegramMessage(env.BOT_TOKEN, cb.from.id, `❌ Gagal membuat invoice: ${invoiceResp ? JSON.stringify(invoiceResp) : 'no response'}`);
        return;
    }

    // store pending payment
    const pending = await loadKV('pending_payments') || {};
    const trxid = invoiceResp.trxid || invoiceResp.trx_id || invoiceResp.trxId || invoiceResp.trx || invoiceResp.id || invoiceResp.reference || invoiceResp.reference_id || invoiceResp.invoice_id || invoiceResp.ref || invoiceResp.ref_id || invoiceResp.order_id || invoiceResp.order || invoiceResp.id_trx || ('TRX' + Date.now());
    pending[trxid] = {
        userId,
        productSku: session.productKey,
        qty,
        amount: total,
        createdAt: nowISO(),
        expiresAt: invoiceResp.expired_at || invoiceResp.expired || null,
        status: 'pending',
        provider_response: invoiceResp
    };
    await saveKV('pending_payments', pending);

    // build invoice caption — make it visually boxed
    const fee = invoiceResp.fee || 0;
    const totalBayar = invoiceResp.amount || total;
    const captionLines = [
        `_INVOICE PEMBAYARAN_`,
        ``,
        `Trx ID: ${trxid}`,
        ``,
        `Produk: ${product.title}`,
        `Jumlah: ${qty} item`,
        `Harga Produk: Rp ${formatNumber(product.price)}`,
        `Fee Transaksi: Rp ${formatNumber(fee)}`,
        `Total Bayar: Rp ${formatNumber(totalBayar)}`,
        ``,
        `Silakan pindai (scan) QR Code di atas menggunakan aplikasi e-wallet atau m-banking Anda untuk menyelesaikan pembayaran.`,
        ``,
        `Pesanan akan otomatis dikirim setelah pembayaran berhasil.`
    ];
    // Send QR image with caption
    const qrUrl = invoiceResp.qris_url || invoiceResp.qr || invoiceResp.image || invoiceResp.qr_image;
    const caption = boxText(captionLines).replaceAll('&', '&amp;');

    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ Saya Sudah Bayar (Cek Otomatis)", callback_data: `check_payment_${trxid}` }],
            [{ text: "❌ Batalkan Pesanan", callback_data: `cancel_payment_${trxid}` }]
        ]
    };

    if (qrUrl) {
        await sendTelegramPhoto(env.BOT_TOKEN, cb.from.id, qrUrl, caption, keyboard, 'HTML');
    } else {
        // if no QR image, send link + caption
        const msg = `${caption}\n\n${escapeHtml(invoiceResp.payment_url || invoiceResp.url || '')}`;
        await sendTelegramMessage(env.BOT_TOKEN, cb.from.id, msg, keyboard, 'HTML');
    }

    // clear session
    clearUserSession(userId);
    return;
}

// Manual check payment pressed by user (attempt verify via provider)
async function handleCheckPayment(update, env, trxid) {
    const cb = update.callback_query;
    const userId = cb.from.id.toString();

    const pending = await loadKV('pending_payments') || {};
    const p = pending[trxid];
    if (!p) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Invoice tidak ditemukan atau sudah kadaluwarsa.", true);
        return;
    }
    // attempt verify
    const verify = await verifyInvoiceStatus(env, trxid);
    if (verify && (verify.status === 'success' || verify.paid === true || verify.status === true)) {
        // mark paid & process
        await processSuccessfulPayment(env, trxid, verify);
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Pembayaran terkonfirmasi. Pesanan sedang diproses.", true);
    } else {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Pembayaran belum terkonfirmasi. Silakan coba lagi nanti.", true);
    }
}

// Cancel payment
async function handleCancelPayment(update, env, trxid) {
    const cb = update.callback_query;
    const userId = cb.from.id.toString();
    const pending = await loadKV('pending_payments') || {};
    const p = pending[trxid];
    if (!p) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Invoice tidak ditemukan atau sudah kadaluwarsa.", true);
        return;
    }
    if (p.userId !== userId && cb.from.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Hanya pemesan atau admin yang dapat membatalkan.", true);
        return;
    }
    delete pending[trxid];
    await saveKV('pending_payments', pending);
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Pesanan dibatalkan.", true);
    await sendTelegramMessage(env.BOT_TOKEN, userId, `✅ Pesanan dengan Trx ID ${trxid} berhasil dibatalkan.`);
}

// Process successful payment (called by webhook or manual verification)
async function processSuccessfulPayment(env, trxid, providerPayload) {
    const pending = await loadKV('pending_payments') || {};
    const p = pending[trxid];
    if (!p) {
        console.warn('processSuccessfulPayment: pending not found', trxid);
        return false;
    }
    if (p.status === 'paid') {
        console.log('already processed', trxid);
        return true;
    }

    const accounts = await loadKV('accounts') || {};
    const prod = accounts[p.productSku];
    if (!prod) {
        // can't fulfill
        await sendTelegramMessage(env.BOT_TOKEN, p.userId, `❌ Produk tidak ditemukan untuk Trx ${trxid}. Silakan hubungi admin.`);
        p.status = 'failed';
        await saveKV('pending_payments', pending);
        return false;
    }
    if (!prod.list || prod.list.length < p.qty) {
        await sendTelegramMessage(env.BOT_TOKEN, p.userId, `❌ Stok tidak mencukupi untuk produk ${prod.title}. Silakan hubungi admin.`);
        p.status = 'failed';
        await saveKV('pending_payments', pending);
        return false;
    }

    // Pop qty items from prod.list and send to user
    const itemsToSend = prod.list.splice(0, p.qty);
    // update product stock
    prod.stock = prod.list.length;
    accounts[p.productSku] = prod;
    await saveKV('accounts', accounts);

    // mark pending as paid
    p.status = 'paid';
    p.paidAt = nowISO();
    p.provider_payload = providerPayload;
    await saveKV('pending_payments', pending);

    // save transaction to transactions
    const transactions = await loadKV('transactions') || {};
    if (!transactions[p.userId]) transactions[p.userId] = [];
    transactions[p.userId].push({
        id: 'TXN' + Date.now(),
        type: 'purchase',
        amount: p.amount,
        productSku: p.productSku,
        qty: p.qty,
        items: itemsToSend,
        timestamp: nowISO(),
        provider: providerPayload || {}
    });
    await saveKV('transactions', transactions);

    // send items to user (as one message)
    let detailMsg = `✅ <b>Pembayaran Berhasil!</b>\n\nBerikut detail akun yang Anda beli:\n\n`;
    itemsToSend.forEach((it, idx) => {
        detailMsg += `<b>● Akun ${idx+1}:</b>\n<code>${escapeHtml(it)}</code>\n\n`;
    });
    detailMsg += `\n<code>Trx ID:</code> ${trxid}\n<code>Produk:</code> ${escapeHtml(prod.title)}\n<code>Jumlah:</code> ${p.qty}\nTerima kasih!`;

    await sendTelegramMessage(env.BOT_TOKEN, p.userId, detailMsg, null, 'HTML');
    // notify admin
    if (env.ADMIN_ID) {
        await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, `🧾 Pembayaran diterima: Trx ${trxid}\nUser: ${p.userId}\nProduk: ${prod.title}\nJumlah: ${p.qty}`);
    }
    return true;
}

// -------------------- Profile, Help --------------------
async function handleProfile(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;
    const userId = from.id.toString();
    const transactions = await loadKV('transactions') || {};
    const userTransactions = transactions[userId] || [];

    const message = `
👤 <b>Profile Pengguna</b>

┌─── 📊 <b>STATISTIK</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📋 <b>Total Transaksi:</b> <code>${userTransactions.length}</code>
└─────────────────────
    `;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📊 Riwayat", callback_data: "riwayat" }],
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };
    if (cv) {
        await answerCallbackQuery(env.BOT_TOKEN, cv.id);
        return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
    } else {
        return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
    }
}
async function handleRiwayat(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;
    const userId = from.id.toString();
    const transactions = await loadKV('transactions') || {};
    const userTransactions = transactions[userId] || [];

    if (userTransactions.length === 0) {
        const message = `📊 <b>Riwayat Transaksi</b>\n\nBelum ada transaksi yang dilakukan. Mulai belanja sekarang! 🛒`;
        const keyboard = {
            inline_keyboard: [
                [{ text: "🛒 Belanja Sekarang", callback_data: "catalog" }],
                [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
            ]
        };
        if (cv) {
            await answerCallbackQuery(env.BOT_TOKEN, cv.id);
            return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
        } else {
            return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
        }
    }

    const recent = userTransactions.slice(-10).reverse();
    const list = recent.map((t, idx) => {
        const date = new Date(t.timestamp).toLocaleDateString('id-ID');
        return `${idx+1}. 🛒 ${t.productSku || ''}\n   💰 Rp ${formatNumber(t.amount)} | 📅 ${date}`;
    }).join('\n\n');

    const message = `
📊 <b>Riwayat Transaksi Terakhir</b>

${list}

<code>================================</code>
<i>Menampilkan 10 transaksi terakhir</i>
    `;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "riwayat" }, { text: "📋 Semua Riwayat", callback_data: "full_riwayat" }],
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };

    if (cv) {
        await answerCallbackQuery(env.BOT_TOKEN, cv.id);
        return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
    } else {
        return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
    }
}
async function handleHelp(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;

    const message = `
ℹ️ <b>Pusat Bantuan</b>

<u>📖 Cara Menggunakan Bot:</u>
1. Pilih menu Katalog → pilih produk → atur jumlah → Lanjutkan Pembelian
2. Bot akan mengirim invoice QRIS. Scan untuk bayar.
3. Setelah pembayaran terkonfirmasi, akun akan dikirim otomatis.

👨‍💼 <b>Admin Support:</b> ${env.ADMIN_USERNAME || "@admin"}
    `;
    const keyboard = {
        inline_keyboard: [
            [{ text: "🛒 Beli Akun", callback_data: "catalog" }],
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };

    if (cv) {
        await answerCallbackQuery(env.BOT_TOKEN, cv.id);
        return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
    } else {
        return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
    }
}

// -------------------- Admin: add product via HTTP (simple) --------------------
async function handleAdminAddProduct(request, env) {
    // expect JSON body with { api_key, productSku, title, description, price, list: [ "email|pass", ... ] }
    // api_key should match env.ADMIN_API_KEY or ADMIN_ID
    try {
        const body = await request.json();
        const apiKey = body.api_key || '';
        if (apiKey !== env.ADMIN_API_KEY && String(request.headers.get('x-admin-id') || '') !== String(env.ADMIN_ID)) {
            return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401 });
        }
        const { productSku, title, description, price, list } = body;
        if (!productSku || !title) return new Response(JSON.stringify({ success: false, message: 'productSku/title required' }), { status: 400 });

        const accounts = await loadKV('accounts') || {};
        accounts[productSku] = {
            title,
            description: description || '',
            price: parseInt(price) || 0,
            list: Array.isArray(list) ? list : (list ? [list] : []),
            stock: Array.isArray(list) ? list.length : (list ? 1 : 0)
        };
        await saveKV('accounts', accounts);
        return new Response(JSON.stringify({ success: true, product: accounts[productSku] }), { status: 200 });
    } catch (e) {
        console.error('admin add product error', e);
        return new Response(JSON.stringify({ success: false, message: 'error' }), { status: 500 });
    }
}

// -------------------- Webhook (payment provider -> this endpoint) --------------------
async function handleWebhook(request, env) {
    // Provider should POST JSON with at least { status: 'success', trxid: '...', metadata: { userId, productSku, qty }, amount }
    // Validate secret header
    const secret = request.headers.get('x-callback-secret') || request.headers.get('x-secret') || request.headers.get('x-provider-secret');
    if (env.CALLBACK_SECRET && secret !== env.CALLBACK_SECRET) {
        return new Response('unauthorized', { status: 401 });
    }
    let payload;
    try {
        payload = await request.json();
    } catch (e) {
        console.error('webhook parse error', e);
        return new Response('bad request', { status: 400 });
    }
    const status = payload.status || payload.payment_status || payload.state || (payload.paid ? 'success' : 'pending');
    const trxid = payload.trxid || payload.trx_id || payload.reference || payload.order_id;
    if (!trxid) {
        console.warn('webhook missing trxid', payload);
        return new Response('missing trxid', { status: 400 });
    }
    if (status === 'success' || status === 'PAID' || payload.paid === true) {
        // process
        try {
            await processSuccessfulPayment(env, trxid, payload);
        } catch (e) {
            console.error('processSuccessfulPayment webhook error', e);
            return new Response('error', { status: 500 });
        }
    } else {
        // update pending status
        const pending = await loadKV('pending_payments') || {};
        if (pending[trxid]) {
            pending[trxid].status = status;
            pending[trxid].provider_payload = payload;
            await saveKV('pending_payments', pending);
        }
    }
    return new Response('ok', { status: 200 });
}

// -------------------- Cron / Broadcast --------------------
async function handleSetBroadcast(request, env) {
    // admin HTTP endpoint to set broadcast message and enable/disable
    try {
        const body = await request.json();
        const apiKey = body.api_key || '';
        if (apiKey !== env.ADMIN_API_KEY && String(request.headers.get('x-admin-id') || '') !== String(env.ADMIN_ID)) {
            return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401 });
        }
        const broadcast = await loadKV('broadcast') || {};
        broadcast.enabled = body.enabled === undefined ? (broadcast.enabled || false) : Boolean(body.enabled);
        if (body.message) broadcast.message = body.message;
        if (!broadcast.lastSentAt) broadcast.lastSentAt = null;
        if (!broadcast.sentThisHour) broadcast.sentThisHour = 0;
        await saveKV('broadcast', broadcast);
        return new Response(JSON.stringify({ success: true, broadcast }), { status: 200 });
    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ success: false, message: 'error' }), { status: 500 });
    }
}

async function handleCron(request, env) {
    // Should be called by external scheduler e.g. every 15 minutes.
    // We enforce only up to 2 broadcasts per hour by checking lastSentAt and sentThisHour counter.
    const broadcast = await loadKV('broadcast') || {};
    if (!broadcast.enabled || !broadcast.message) return new Response('broadcast disabled', { status: 200 });

    const lastSentAt = broadcast.lastSentAt ? new Date(broadcast.lastSentAt) : null;
    const now = new Date();
    const currentHour = now.getUTCHours();
    // reset count if hour changed
    if (!broadcast.sentHour || broadcast.sentHour !== currentHour) {
        broadcast.sentHour = currentHour;
        broadcast.sentThisHour = 0;
    }

    // allow up to 2 per hour, with minimum 30 minutes gap
    const minGapMs = 30 * 60 * 1000; // 30 minutes
    const canSend = (broadcast.sentThisHour < 2) && (!lastSentAt || (now - lastSentAt) >= minGapMs);
    if (!canSend) return new Response('no send', { status: 200 });

    // get all users
    const users = await loadKV('users') || {};
    const userIds = Object.keys(users || {});
    for (const uid of userIds) {
        try {
            await sendTelegramMessage(env.BOT_TOKEN, users[uid].chatId, broadcast.message);
        } catch (e) { console.error('broadcast send error to', uid, e); }
    }
    broadcast.lastSentAt = now.toISOString();
    broadcast.sentThisHour = (broadcast.sentThisHour || 0) + 1;
    await saveKV('broadcast', broadcast);
    return new Response('sent', { status: 200 });
}

// -------------------- Router --------------------
router.post('/', async (request, env) => {
    try {
        BOT_DB = env.BOT_DB; // set global for KV helpers
        const update = await request.json();
        // determine update type
        if (update.message) {
            const message = update.message;
            const text = message.text || '';
            if (text.startsWith('/start')) {
                await handleStart({ message }, env);
                return new Response('ok', { status: 200 });
            }
            if (text.startsWith('/admin')) {
                // quick admin info
                if (String(message.from.id) !== String(env.ADMIN_ID)) {
                    await sendTelegramMessage(env.BOT_TOKEN, message.from.id, '❌ Akses ditolak!');
                    return new Response('ok', { status: 200 });
                }
                const help = `Admin commands (HTTP endpoints):
- POST /admin/add_product (json api_key... )
- POST /admin/set_broadcast (json api_key...)
- Call /cron from external scheduler every 15 min to allow 2x/hour broadcast.
`;
                await sendTelegramMessage(env.BOT_TOKEN, message.from.id, help);
                return new Response('ok', { status: 200 });
            }
            // default: ignore
            return new Response('ok', { status: 200 });
        }

        if (update.callback_query) {
            const cb = update.callback_query;
            const data = cb.data || '';

            if (data === 'catalog') return new Response(JSON.stringify(await handleCatalog({ callback_query: cb }, env)), { status: 200 });
            if (data.startsWith('catalog_select_')) {
                const idx = parseInt(data.split('_').pop());
                return new Response(JSON.stringify(await handleCatalogSelect({ callback_query: cb }, env, idx)), { status: 200 });
            }
            if (data === 'catalog_next') return new Response(JSON.stringify(await handleCatalog({ callback_query: cb }, env)), { status: 200 });

            if (data === 'qty_increase') return new Response(JSON.stringify(await handleQtyChange({ callback_query: cb }, env, +1)), { status: 200 });
            if (data === 'qty_decrease') return new Response(JSON.stringify(await handleQtyChange({ callback_query: cb }, env, -1)), { status: 200 });
            if (data === 'buy_all') return new Response(JSON.stringify(await handleBuyAll({ callback_query: cb }, env)), { status: 200 });
            if (data === 'purchase_confirm') return new Response(JSON.stringify(await handlePurchaseConfirm({ callback_query: cb }, env)), { status: 200 });

            if (data === 'profile') return new Response(JSON.stringify(await handleProfile({ callback_query: cb }, env)), { status: 200 });
            if (data === 'riwayat') return new Response(JSON.stringify(await handleRiwayat({ callback_query: cb }, env)), { status: 200 });
            if (data === 'help') return new Response(JSON.stringify(await handleHelp({ callback_query: cb }, env)), { status: 200 });

            if (data.startsWith('check_payment_')) {
                const trxid = data.split('check_payment_')[1];
                await handleCheckPayment({ callback_query: cb }, env, trxid);
                return new Response('ok', { status: 200 });
            }
            if (data.startsWith('cancel_payment_')) {
                const trxid = data.split('cancel_payment_')[1];
                await handleCancelPayment({ callback_query: cb }, env, trxid);
                return new Response('ok', { status: 200 });
            }

            // fallback
            await answerCallbackQuery(env.BOT_TOKEN, cb.id, 'Perintah tidak dikenali.', true);
            return new Response('ok', { status: 200 });
        }

        return new Response('ok', { status: 200 });
    } catch (err) {
        console.error('error processing update', err);
        return new Response('error', { status: 500 });
    }
});

// Admin HTTP endpoints
router.post('/admin/add_product', async request => {
    // bind env inside handler
    const { BOT_DB: db } = request.cf ? request.cf : {}; // not used here (we'll use env var in module scope)
    return await handleAdminAddProduct(request, { BOT_DB });
});

router.post('/admin/set_broadcast', async request => {
    BOT_DB = request.cf && request.cf.BOT_DB ? request.cf.BOT_DB : BOT_DB; // no-op but ensure BOT_DB set
    return await handleSetBroadcast(request, { ADMIN_API_KEY: null, ADMIN_ID: null, BOT_DB });
});

// webhook
router.post('/webhook', async request => {
    BOT_DB = BOT_DB; // ensure set
    // use env from global closure when deployed; but router handler needs env — Cloudflare passes env, here we capture via 'bind' below in module wrapper.
    // This route will be replaced with proper closure binding in the actual worker entry.
    return new Response('ok', { status: 200 });
});

// cron endpoint (should be called by external scheduler every 15min)
router.post('/cron', async (request, env) => {
    BOT_DB = env.BOT_DB;
    return await handleCron(request, env);
});

// fallback
router.all('*', () => new Response('Not found', { status: 404 }));

// -------------------- Worker export (Cloudflare Workers style) --------------------
// We export default that wires environment properly so inner functions can access env.BOT_DB etc.
export default {
    async fetch(request, env) {
        // set global BOT_DB and env into closures
        BOT_DB = env.BOT_DB;
        // attach env to helpers used in module-scope functions
        // note: many functions receive env as parameter normally; ensure when calling createInvoice etc you pass env
        // For webhook path we must route with env
        const url = new URL(request.url);
        if (url.pathname === '/webhook' && request.method === 'POST') {
            return await handleWebhook(request, env);
        }
        if (url.pathname === '/admin/add_product' && request.method === 'POST') {
            return await handleAdminAddProduct(request, env);
        }
        if (url.pathname === '/admin/set_broadcast' && request.method === 'POST') {
            return await handleSetBroadcast(request, env);
        }
        if (url.pathname === '/cron' && request.method === 'POST') {
            return await handleCron(request, env);
        }

        // default: route to router with env bound
        return router.handle(request, env);
    }
};
