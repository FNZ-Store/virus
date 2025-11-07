 // index.js
import { Router } from 'itty-router';
const router = Router();

// -------------------- In-memory session (temporary) --------------------
const userSessions = new Map();
function clearUserSession(userId) { userSessions.delete(userId); }
function setUserSession(userId, sessionData) {
    userSessions.set(userId, { ...sessionData, timestamp: Date.now() });
}
function getUserSession(userId) {
    const s = userSessions.get(userId);
    if (!s) return null;
    if (Date.now() - s.timestamp > 30*60*1000) { userSessions.delete(userId); return null; }
    return s;
}

// -------------------- KV Helpers --------------------
async function loadDB(binding, dbType) {
    try {
        const data = await binding.get(dbType, 'json');
        return data || {};
    } catch (e) {
        console.error('loadDB', e);
        return {};
    }
}
async function saveDB(binding, data, dbType) {
    try {
        await binding.put(dbType, JSON.stringify(data));
        return true;
    } catch (e) {
        console.error('saveDB', e);
        return false;
    }
}

// pending payments helpers in BOT_DB
async function loadPendingPayments(binding) {
    try {
        const data = await binding.get('pending_payments', 'json');
        return data || {};
    } catch (e) {
        return {};
    }
}
async function savePendingPayments(binding, pendingObj) {
    try {
        await binding.put('pending_payments', JSON.stringify(pendingObj));
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}
async function addPendingPayment(binding, userId, payment) {
    const pending = await loadPendingPayments(binding);
    pending[payment.paymentId] = { userId: userId.toString(), ...payment };
    await savePendingPayments(binding, pending);
}
async function removePendingPayment(binding, paymentId) {
    const pending = await loadPendingPayments(binding);
    if (pending[paymentId]) delete pending[paymentId];
    await savePendingPayments(binding, pending);
}
async function getPendingById(binding, paymentId) {
    const pending = await loadPendingPayments(binding);
    return pending[paymentId] || null;
}

// -------------------- Statistics & Reward Settings --------------------
async function loadStatistics(binding) {
    try {
        const data = await binding.get('statistics', 'json');
        return data || { totalTransactions: 0, totalRevenue: 0, totalUsers: 0, dailyStats: {}, popularProducts: {} };
    } catch (e) {
        return { totalTransactions: 0, totalRevenue: 0, totalUsers: 0, dailyStats: {}, popularProducts: {} };
    }
}
async function saveStatistics(binding, stats) {
    try { await binding.put('statistics', JSON.stringify(stats)); return true; } catch (e) { console.error(e); return false; }
}
async function updateStatistics(binding, type, data) {
    const stats = await loadStatistics(binding);
    const today = new Date().toISOString().split('T')[0];
    if (!stats.dailyStats[today]) stats.dailyStats[today] = { transactions:0, revenue:0, users:0 };
    switch (type) {
        case 'purchase':
            stats.totalTransactions++;
            stats.totalRevenue += data.amount;
            stats.dailyStats[today].transactions++;
            stats.dailyStats[today].revenue += data.amount;
            if (!stats.popularProducts[data.productName]) stats.popularProducts[data.productName] = 0;
            stats.popularProducts[data.productName]++;
            break;
        case 'user_registered':
            stats.totalUsers++;
            stats.dailyStats[today].users++;
            break;
        case 'deposit':
            stats.dailyStats[today].revenue += data.amount;
            break;
    }
    await saveStatistics(binding, stats);
}

// reward settings (kept but no balance-based deposit)
async function loadRewardSettings(binding) {
    try {
        const data = await binding.get('reward_settings', 'json');
        return data || defaultRewardSettings();
    } catch (e) {
        return defaultRewardSettings();
    }
}
function defaultRewardSettings() {
    return {
        enabled: true,
        purchaseBonus: { enabled: true, cashback: 2, minPurchase: 20000 },
        referralBonus: { enabled: true, bonus: 10000, bonusReferee: 5000 },
        achievementRewards: { enabled: true, rewards: { firstPurchase:2000, fivePurchases:5000, tenPurchases:10000, bigSpender:15000 } }
    };
}
async function saveRewardSettings(binding, s) { try { await binding.put('reward_settings', JSON.stringify(s)); return true; } catch(e){console.error(e);return false;} }

// -------------------- Transaction history --------------------
async function addTransaction(binding, userId, type, data) {
    const txs = await loadDB(binding, 'transactions') || {};
    if (!txs[userId]) txs[userId] = [];
    const tx = { id: genTxId(), type, amount: data.amount||0, productName: data.productName||'', timestamp: new Date().toISOString(), status: data.status||'completed' };
    txs[userId].push(tx);
    if (txs[userId].length > 100) txs[userId] = txs[userId].slice(-100);
    await saveDB(binding, txs, 'transactions');
    return tx.id;
}
function genTxId() { return 'TX' + Date.now() + Math.random().toString(36).slice(2,8).toUpperCase(); }

// -------------------- Utilities --------------------
function formatNumber(n) { if (n===undefined||n===null) return '0'; return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
function escapeHtml(t) { if (t===undefined||t===null) return ''; return String(t).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

// -------------------- Telegram API helpers --------------------
async function sendTelegramMessage(botToken, chatId, text, replyMarkup=null, parseMode='HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try {
        const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        return await res.json();
    } catch (e) { console.error('sendTelegramMessage', e); return null; }
}
async function editMessageText(botToken, chatId, messageId, text, replyMarkup=null, parseMode='HTML') {
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try { const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); return await res.json(); } catch(e){console.error(e);return null;}
}
async function answerCallbackQuery(botToken, callbackQueryId, text=null, showAlert=false) {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    const payload = { callback_query_id: callbackQueryId };
    if (text) { payload.text = text; payload.show_alert = showAlert; }
    try { const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); return await res.json(); } catch(e){console.error(e);return null;}
}
async function sendTelegramPhoto(botToken, chatId, photoUrl, caption='', replyMarkup=null, parseMode='HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
    const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try { const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); return await res.json(); } catch(e){console.error(e);return null;}
}

// -------------------- Product delivery helper --------------------
// Deliver 'qty' items from product entry. Supports two types of product storage:
// 1) product.entries = array of credential strings/objects -> we pop from array and return list
// 2) product.template -> bot will generate a placeholder message to admin to fulfill
async function deliverProduct(binding, productKey, qty) {
    const accounts = await loadDB(binding, 'accounts');
    const product = accounts[productKey];
    if (!product) return { delivered: [], note: 'Produk tidak ditemukan' };

    const delivered = [];
    // If product has entries array (pre-made accounts)
    if (Array.isArray(product.entries) && product.entries.length > 0) {
        for (let i=0;i<qty;i++) {
            if (product.entries.length === 0) break;
            const item = product.entries.shift(); // remove first
            delivered.push(item);
        }
        // Update stock and save
        product.stock = product.entries.length;
        accounts[productKey] = product;
        await saveDB(binding, accounts, 'accounts');
        return { delivered, remainingStock: product.stock };
    }

    // If no entries, but product has stock numeric: reduce stock and return placeholder
    if (product.stock !== undefined && !isNaN(product.stock)) {
        const reduce = Math.min(qty, product.stock);
        product.stock = Math.max(0, product.stock - reduce);
        accounts[productKey] = product;
        await saveDB(binding, accounts, 'accounts');
        // No pre-made entries: return instruction to admin or generic delivery message
        for (let i=0;i<reduce;i++) {
            delivered.push(`Akun akan dibuat otomatis / diambil dari provider (manual) — mohon cek panel admin untuk pengambilan.`);
        }
        return { delivered, remainingStock: product.stock };
    }

    // fallback
    return { delivered: [], note: 'Produk tidak memiliki entries atau stock' };
}

// -------------------- QRIS Integration --------------------
// create QRIS: POST to API_CREATE_URL with payload: { amount, merchant_id, api_key, merchant_name, external_id }
// expected response: { success: true, paymentId, qrisImageUrl, qrisRaw, ... }
// (we adapt to API you provided; if different, adjust payload accordingly)
async function createQris(env, amount, metadata={}) {
    const url = env.API_CREATE_URL;
    const payload = {
        amount: amount,
        merchant_id: env.MERCHANT_ID,
        api_key: env.API_KEY,
        external_id: 'ORD' + Date.now() + Math.random().toString(36).slice(2,6).toUpperCase(),
        note: metadata.note || '',
        // include QRIS_CODE if API needs it
        qris_code: env.QRIS_CODE || undefined
    };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        return data;
    } catch (e) {
        console.error('createQris error', e);
        return null;
    }
}

// check payment status: POST to API_CHECK_PAYMENT with { paymentId or external_id or invoice }
// expected response: { success: true, status: 'PAID'|'PENDING'|'EXPIRED', ... }
async function checkPaymentStatus(env, paymentId) {
    const url = env.API_CHECK_PAYMENT;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ paymentId })
        });
        const data = await res.json();
        return data;
    } catch (e) {
        console.error('checkPaymentStatus error', e);
        return null;
    }
}

// -------------------- UI templates --------------------
function buildCatalogMessage(accounts) {
    const keys = Object.keys(accounts || {});
    if (keys.length === 0) return `📦 <b>KATALOG PRODUK</b>\n\nBelum ada produk tersedia.`;
    const lines = [];
    lines.push(`📦 <b>KATALOG PRODUK</b>\n`);
    keys.forEach((k, idx) => {
        const p = accounts[k];
        const stok = (p.stock === 0 || p.stock === '0') ? '❌ Habis' : `✅ Stok Tersedia: ${p.stock || 0}`;
        lines.push(`<b>[ ${idx+1} ] ${escapeHtml(p.title || p.name || 'Produk')}</b>\n┄┄┄┄┄┄\n${p.price ? '💰 Harga: Rp ' + formatNumber(p.price) + '\n' : ''}${stok}\n`);
    });
    lines.push(`\n<code>pilih produk yang anda inginkan:</code>`);
    return lines.join('\n');
}
function buildProductDetailMessage(product, qty=1) {
    const price = product.price || 0;
    const total = price * qty;
    const stockText = (product.stock === 0 || product.stock === '0') ? '❌ Habis' : `✅ Stok Tersisa: ${product.stock || 0}`;
    const desc = product.description || 'Tidak ada deskripsi.';
    return `📦 <b>${escapeHtml(product.title || product.name || 'Produk')}</b>\n\n💰 <b>Harga Satuan:</b> Rp ${formatNumber(price)}\n${stockText}\n\n<b>📝 Deskripsi:</b>\n${escapeHtml(desc)}\n\n<code>================================</code>\n<b>Total Harga:</b> Rp ${formatNumber(total)}\n\nSilakan tentukan jumlah yang ingin dibeli:`;
}

// -------------------- Core Handlers --------------------
async function handleStart(update, env) {
    const msg = update.message;
    const user = msg.from;
    const userId = user.id.toString();

    // register user if new
    const users = await loadDB(env.BOT_DB, 'users');
    if (!users[userId]) {
        users[userId] = { joined: new Date().toISOString(), purchases: 0, totalSpent:0 };
        await saveDB(env.BOT_DB, users, 'users');
        await updateStatistics(env.BOT_DB, 'user_registered', {});
    }

    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const adminUsername = env.ADMIN_USERNAME || "@admin";

    const message = `
🎊 <b>Selamat Datang di Bot Premium Store!</b>

┌─── 📊 <b>INFO AKUN</b> ───┐
│ 👤 <b>User ID:</b> <code>${userId}</code>
│ 📝 <b>Username:</b> <code>@${user.username || 'TidakAda'}</code>
│ 📦 <b>Produk:</b> <code>${Object.keys(accounts).length} item</code>
└─────────────────────

👨‍💼 <b>Admin:</b> ${adminUsername}

<code>================================</code>

✨ <b>Fitur Unggulan:</b>
• 🛒 Beli Akun Otomatis (via QRIS)
• 🏆 Achievement
• 📊 Riwayat Transaksi

Pilih menu di bawah untuk memulai:
    `;

    const keyboard = { inline_keyboard: [
        [{ text: "🛒 Katalog Produk", callback_data: "catalog" }],
        [{ text: "📊 Riwayat", callback_data: "riwayat" }, { text: "👤 Profile", callback_data: "profile" }],
        [{ text: "ℹ️ Bantuan", callback_data: "help" }]
    ]};
    return await sendTelegramMessage(env.BOT_TOKEN, user.id, message, keyboard);
}

async function handleCatalog(update, env) {
    const cb = update.callback_query;
    const from = cb ? cb.from : update.message.from;
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const message = buildCatalogMessage(accounts);
    const keys = Object.keys(accounts || {});
    const buttonsRow = keys.slice(0,5).map((k,idx) => ({ text: `${idx+1}`, callback_data: `catalog_select_${idx}` }));
    const reply = { inline_keyboard: [
        buttonsRow,
        [{ text: "➡️ Selanjutnya", callback_data: "catalog_next" }],
        [{ text: "🔙 Kembali ke Menu", callback_data: "back_to_main" }]
    ]};
    if (cb) { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, reply); }
    return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, reply);
}

async function handleCatalogSelect(update, env, index=0) {
    const cb = update.callback_query;
    const from = cb.from;
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const keys = Object.keys(accounts || {});
    if (!keys[index]) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan", true); return; }
    const key = keys[index];
    const product = accounts[key];

    setUserSession(from.id.toString(), { action: 'browsing_product', productKey: key, qty: 1 });

    const message = buildProductDetailMessage(product, 1);
    const keyboard = { inline_keyboard: [
        [{ text: "➖", callback_data: "qty_decrease" }, { text: "1", callback_data: "qty_show" }, { text: "➕", callback_data: "qty_increase" }],
        [{ text: `🛒 Beli Semua Stok (${product.stock||0})`, callback_data: "buy_all" }],
        [{ text: "✅ Lanjutkan Pembelian", callback_data: "purchase_start" }],
        [{ text: "🔙 Kembali ke Daftar", callback_data: "catalog" }]
    ]};
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard);
}

async function handleQtyChange(update, env, delta=0) {
    const cb = update.callback_query;
    const uid = cb.from.id.toString();
    const session = getUserSession(uid);
    if (!session || session.action !== 'browsing_product') { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi produk tidak valid. Buka katalog lagi.", true); return; }
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const product = accounts[session.productKey];
    if (!product) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true); return; }

    let qty = session.qty || 1;
    qty = qty + delta;
    if (qty < 1) qty = 1;
    if (product.stock !== undefined && !isNaN(product.stock)) qty = Math.min(qty, product.stock);

    setUserSession(uid, { ...session, qty });

    const message = buildProductDetailMessage(product, qty);
    const keyboard = { inline_keyboard: [
        [{ text: "➖", callback_data: "qty_decrease" }, { text: `${qty}`, callback_data: "qty_show" }, { text: "➕", callback_data: "qty_increase" }],
        [{ text: `🛒 Beli Semua Stok (${product.stock||0})`, callback_data: "buy_all" }],
        [{ text: "✅ Lanjutkan Pembelian", callback_data: "purchase_start" }],
        [{ text: "🔙 Kembali ke Daftar", callback_data: "catalog" }]
    ]};
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard);
}

async function handleBuyAll(update, env) {
    const cb = update.callback_query;
    const uid = cb.from.id.toString();
    const session = getUserSession(uid);
    if (!session) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi tidak ditemukan.", true); return; }
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const product = accounts[session.productKey];
    if (!product) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true); return; }
    const qty = product.stock || 1;
    setUserSession(uid, { ...session, qty });
    const message = buildProductDetailMessage(product, qty);
    const keyboard = { inline_keyboard: [
        [{ text: "➖", callback_data: "qty_decrease" }, { text: `${qty}`, callback_data: "qty_show" }, { text: "➕", callback_data: "qty_increase" }],
        [{ text: `🛒 Beli Semua Stok (${product.stock||0})`, callback_data: "buy_all" }],
        [{ text: "✅ Lanjutkan Pembelian", callback_data: "purchase_start" }],
        [{ text: "🔙 Kembali ke Daftar", callback_data: "catalog" }]
    ]};
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard);
}

// PURCHASE FLOW: start -> create QRIS -> save pending -> send QRIS & "Cek Pembayaran"
async function handlePurchaseStart(update, env) {
    const cb = update.callback_query;
    const uid = cb.from.id.toString();
    const session = getUserSession(uid);
    if (!session || session.action !== 'browsing_product') { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi pembelian tidak valid.", true); return; }

    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const product = accounts[session.productKey];
    if (!product) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true); return; }
    const qty = session.qty || 1;
    const total = (product.price || 0) * qty;

    // create QRIS via API
    const qrisResp = await createQris(env, total, { note: `Pembelian ${product.title || product.name} x${qty}` });
    if (!qrisResp || !qrisResp.success) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Gagal membuat QRIS. Coba lagi nanti.", true);
        return;
    }

    // expected response keys: paymentId, qrisImageUrl, qrisRaw, expire_at
    const paymentId = qrisResp.paymentId || qrisResp.id || qrisResp.external_id || ('PM' + Date.now());
    const qrisImage = qrisResp.qrisImageUrl || qrisResp.qrUrl || qrisResp.image || null;
    const raw = qrisResp.qrisRaw || qrisResp.qrString || env.QRIS_CODE || null;
    const expire = qrisResp.expire_at || qrisResp.expires_at || null;

    // save pending payment
    const pending = {
        paymentId,
        userId: uid.toString(),
        productKey: session.productKey,
        qty,
        amount: total,
        createdAt: new Date().toISOString(),
        expireAt: expire,
        qrisImage,
        raw
    };
    await addPendingPayment(env.BOT_DB, uid, pending);

    // build message to user
    let caption = `🧾 <b>Pesanan:</b> ${escapeHtml(product.title || product.name)}\nJumlah: <b>${qty}</b>\nTotal: <b>Rp ${formatNumber(total)}</b>\n\n📌 Silakan bayar melalui QRIS berikut. Setelah bayar, tekan "Cek Pembayaran".`;
    const keyboard = { inline_keyboard: [
        [{ text: "✅ Cek Pembayaran", callback_data: `check_payment_${paymentId}` }],
        [{ text: "🔙 Batal & Kembali", callback_data: "catalog" }]
    ]};

    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    // send photo if available
    if (qrisImage) {
        await sendTelegramPhoto(env.BOT_TOKEN, cb.from.id, qrisImage, caption, keyboard);
    } else {
        // fallback: show raw QRIS code (string) and button
        const text = caption + (raw ? `\n\n<code>${escapeHtml(raw)}</code>` : '\n\nQRIS image not provided by API');
        await sendTelegramMessage(env.BOT_TOKEN, cb.from.id, text, keyboard);
    }

    // keep session (or clear browsing session if desired). We'll keep pending for check flow.
    clearUserSession(uid);
}

// Check payment (button)
async function handleCheckPayment(update, env, paymentId) {
    const cb = update.callback_query;
    const pending = await getPendingById(env.BOT_DB, paymentId);
    if (!pending) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Pembayaran tidak ditemukan atau sudah diproses.", true); return; }

    // call external API to check status
    const statusResp = await checkPaymentStatus(env, paymentId);
    if (!statusResp) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Gagal cek pembayaran. Coba lagi.", true); return; }

    // interpret response: try to find status field (PAID / SUCCESS / SETTLED)
    const status = (statusResp.status || statusResp.payment_status || statusResp.result || '').toString().toUpperCase();
    // Accept many variants
    const paid = status.includes('PAID') || status.includes('SUCCESS') || status.includes('SETTLED') || (statusResp.paid === true);

    if (!paid) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Pembayaran belum terdeteksi. Silakan tunggu beberapa saat lalu cek kembali.", true);
        return;
    }

    // mark as paid -> deliver product
    // deliverProduct will pop entries or reduce stock and return delivered items
    const delivery = await deliverProduct(env.BOT_DB, pending.productKey, pending.qty);
    // record transaction
    await addTransaction(env.BOT_DB, pending.userId, 'purchase', { amount: pending.amount, productName: (pending.productKey || 'Produk') });
    await updateStatistics(env.BOT_DB, 'purchase', { amount: pending.amount, productName: pending.productKey || 'Produk' });
    // remove pending
    await removePendingPayment(env.BOT_DB, paymentId);

    // send delivered items to user
    let deliverMsg = `✅ Pembayaran terkonfirmasi!\n\nProduk: <b>${escapeHtml((delivery.productTitle || pending.productKey))}</b>\nJumlah: <b>${pending.qty}</b>\nTotal: <b>Rp ${formatNumber(pending.amount)}</b>\n\n🧾 <b>Hasil Pengiriman:</b>\n`;
    if (delivery.delivered && delivery.delivered.length > 0) {
        deliverMsg += delivery.delivered.map((d, i) => `${i+1}. ${escapeHtml(typeof d === 'string' ? d : JSON.stringify(d))}`).join('\n\n');
    } else {
        deliverMsg += `• Produk akan diproses / dikirim manual. Mohon tunggu instruksi dari admin.`;
    }
    const keyboard = { inline_keyboard: [
        [{ text: "🛒 Katalog", callback_data: "catalog" }, { text: "🏠 Menu Utama", callback_data: "back_to_main" }]
    ]};
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Pembayaran terkonfirmasi. Mengirim produk...", true);
    await sendTelegramMessage(env.BOT_TOKEN, pending.userId, deliverMsg, keyboard);

    // notify admin about delivery (optional)
    try {
        const adminId = env.ADMIN_ID;
        if (adminId) {
            const adminMsg = `📣 Pembayaran diterima:\nUser: <code>${pending.userId}</code>\nProduk: ${escapeHtml(pending.productKey)}\nJumlah: ${pending.qty}\nTotal: Rp ${formatNumber(pending.amount)}\nPaymentId: ${paymentId}`;
            await sendTelegramMessage(env.BOT_TOKEN, adminId, adminMsg);
        }
    } catch (e) { /* ignore */ }

    return;
}

// -------------------- Profile/Riwayat/Achievements/Help --------------------
async function handleProfile(update, env) {
    const cb = update.callback_query;
    const from = cb ? cb.from : update.message.from;
    const userId = from.id.toString();
    const users = await loadDB(env.BOT_DB, 'users');
    const user = users[userId] || { joined: new Date().toISOString(), purchases:0, totalSpent:0 };
    const txs = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTx = txs[userId] || [];

    const msg = `
👤 <b>Profile Pengguna</b>

┌─── 📊 <b>STATISTIK</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📅 <b>Bergabung:</b> <code>${new Date(user.joined).toLocaleDateString('id-ID')}</code>
│ 🛒 <b>Total Pembelian:</b> <code>${user.purchases||0}x</code>
│ 💰 <b>Total Pengeluaran:</b> <code>Rp ${formatNumber(user.totalSpent||0)}</code>
│ 📋 <b>Total Transaksi:</b> <code>${userTx.length}</code>
└─────────────────────
    `;
    const keyboard = { inline_keyboard: [
        [{ text: "🏆 Pencapaian", callback_data: "achievements" }, { text: "📊 Riwayat", callback_data: "riwayat" }],
        [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
    ]};
    if (cb) { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, msg, keyboard); }
    return await sendTelegramMessage(env.BOT_TOKEN, from.id, msg, keyboard);
}
async function handleRiwayat(update, env) {
    const cb = update.callback_query;
    const from = cb ? cb.from : update.message.from;
    const uid = from.id.toString();
    const txs = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTx = txs[uid] || [];
    if (userTx.length === 0) {
        const message = `📊 <b>Riwayat Transaksi</b>\n\nBelum ada transaksi yang dilakukan. Mulai belanja sekarang! 🛒`;
        const keyboard = { inline_keyboard: [[{ text: "🛒 Katalog", callback_data: "catalog" }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
        if (cb) { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard); }
        return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
    }
    const recent = userTx.slice(-10).reverse();
    const list = recent.map((t, i) => `${i+1}. ${t.type} ${t.productName ? '- ' + escapeHtml(t.productName) : ''}\n   💰 Rp ${formatNumber(t.amount)} | ${new Date(t.timestamp).toLocaleString('id-ID')}`).join('\n\n');
    const message = `📊 <b>Riwayat Transaksi Terakhir</b>\n\n${list}\n\n<code>================================</code>\n💡 Menampilkan 10 transaksi terakhir`;
    const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "riwayat" }, { text: "📋 Semua Riwayat", callback_data: "full_riwayat" }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
    if (cb) { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard); }
    return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
}
async function handleFullRiwayat(update, env) {
    const cb = update.callback_query;
    const from = cb ? cb.from : update.message.from;
    const uid = from.id.toString();
    const txs = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTx = txs[uid] || [];
    if (userTx.length === 0) { if (cb) await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Tidak ada riwayat!", true); return; }
    const all = userTx.slice().reverse();
    const summary = all.map((t, i) => `${i+1}. ${t.type} ${t.productName ? '- ' + escapeHtml(t.productName) : ''}\n   💰 Rp ${formatNumber(t.amount)} | ${new Date(t.timestamp).toLocaleDateString('id-ID')}`).join('\n\n');
    const message = `📋 <b>Semua Riwayat Transaksi</b>\n\nTotal: <b>${userTx.length} transaksi</b>\n\n${summary}`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali ke Riwayat", callback_data: "riwayat" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard);
}
async function handleAchievements(update, env) {
    const cb = update.callback_query;
    const from = cb ? cb.from : update.message.from;
    const users = await loadDB(env.BOT_DB, 'users');
    const user = users[from.id.toString()] || { purchases:0, totalSpent:0, achievements: {} };
    const settings = await loadRewardSettings(env.BOT_DB);
    const achList = [
        { id:'firstPurchase', title:'Pembeli Pertama 🎯', desc:'Lakukan pembelian pertama', unlocked: user.achievements?.firstPurchase||false, reward: settings.achievementRewards.rewards.firstPurchase },
        { id:'fivePurchases', title:'Pelanggan Setia ⭐', desc:'5 pembelian', unlocked: user.achievements?.fivePurchases||false, progress: user.purchases||0, target:5, reward: settings.achievementRewards.rewards.fivePurchases },
        { id:'tenPurchases', title:'Pelanggan Premium 👑', desc:'10 pembelian', unlocked: user.achievements?.tenPurchases||false, progress: user.purchases||0, target:10, reward: settings.achievementRewards.rewards.tenPurchases },
        { id:'bigSpender', title:'Big Spender 💎', desc:'Habiskan total Rp 100.000', unlocked: user.achievements?.bigSpender||false, progress: user.totalSpent||0, target:100000, reward: settings.achievementRewards.rewards.bigSpender }
    ];
    const list = achList.map(a => `${a.unlocked ? '✅' : '❌'} <b>${a.title}</b>\n   📝 ${a.desc}${a.progress!==undefined ? ` (${a.progress}/${a.target})` : ''}\n   💡 Reward: Rp ${formatNumber(a.reward)}`).join('\n\n');
    const message = `🏆 <b>Pencapaian Anda</b>\n\n${list}\n\n<code>================================</code>\n💡 Lanjutkan transaksi untuk membuka achievement lainnya!`;
    const keyboard = { inline_keyboard: [[{ text: "🛒 Lanjut Belanja", callback_data: "catalog" }, { text: "📊 Riwayat", callback_data: "riwayat" }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
    if (cb) { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard); }
    return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
}
async function handleHelp(update, env) {
    const cb = update.callback_query;
    const from = cb? cb.from : update.message.from;
    const message = `ℹ️ <b>Pusat Bantuan</b>\n\n1. Pilih produk di katalog\n2. Tentukan jumlah\n3. Bot akan buat QRIS otomatis\n4. Bayar dan tekan "Cek Pembayaran"\n\n👨‍💼 Admin: ${env.ADMIN_USERNAME || '@admin'}`;
    const keyboard = { inline_keyboard: [[{ text: "🛒 Katalog", callback_data: "catalog" }, { text: "💬 Chat Admin", url: `https://t.me/${(env.ADMIN_USERNAME||'admin').replace('@','')}` }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
    if (cb) { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return await editMessageText(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard); }
    return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
}

// -------------------- Admin handlers (kept) --------------------
async function handleAdminCommand(update, env) {
    const msg = update.message;
    const user = msg.from;
    if (user.id.toString() !== env.ADMIN_ID) { return await sendTelegramMessage(env.BOT_TOKEN, user.id, `❌ Akses Ditolak!`); }
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const stats = await loadStatistics(env.BOT_DB);
    const adminMsg = `👮 <b>Admin Dashboard</b>\n\nTotal Users: ${Object.keys(users).length}\nTotal Produk: ${Object.keys(accounts).length}\nTotal Transaksi: ${stats.totalTransactions}`;
    const keyboard = { inline_keyboard: [
        [{ text: "🛒 Kelola Produk", callback_data: "admin_produk" }, { text: "📊 Statistik", callback_data: "admin_stats" }],
        [{ text: "📂 Pending Payments", callback_data: "admin_pending" }, { text: "⚙️ Reward", callback_data: "admin_reward_settings" }]
    ]};
    return await sendTelegramMessage(env.BOT_TOKEN, user.id, adminMsg, keyboard);
}

async function handleAdminPending(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Akses ditolak", true); return; }
    const pending = await loadPendingPayments(env.BOT_DB);
    const list = Object.values(pending);
    if (list.length === 0) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Tidak ada pending payment", true);
        return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, "Tidak ada pending payment");
    }
    const summary = list.map(p => `ID: ${p.paymentId}\nUser: ${p.userId}\nProduk: ${p.productKey}\nJumlah: ${p.qty}\nTotal: Rp ${formatNumber(p.amount)}`).join('\n\n');
    const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "admin_pending" }],[{ text: "🔙 Kembali", callback_data: "back_to_admin" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, `<b>Pending Payments</b>\n\n${summary}`, keyboard);
}

// -------------------- Router: receive Telegram update --------------------
router.post('/', async (request, env) => {
    try {
        const update = await request.json();

        // MESSAGE handlers
        if (update.message) {
            const msg = update.message;
            const text = msg.text || '';
            if (text.startsWith('/start')) return new Response(JSON.stringify(await handleStart({ message: msg }, env)), { status:200 });
            if (text.startsWith('/admin')) return new Response(JSON.stringify(await handleAdminCommand({ message: msg }, env)), { status:200 });
            // other textual admin flows (reward settings etc.) can be handled similarly
            return new Response('ok', { status:200 });
        }

        // CALLBACKS
        if (update.callback_query) {
            const cb = update.callback_query;
            const data = cb.data || '';

            // main navigation
            if (data === 'catalog') return new Response(JSON.stringify(await handleCatalog({ callback_query: cb }, env)), { status:200 });
            if (data.startsWith('catalog_select_')) {
                const idx = parseInt(data.split('_').pop());
                return new Response(JSON.stringify(await handleCatalogSelect({ callback_query: cb }, env, idx)), { status:200 });
            }
            if (data === 'catalog_next') return new Response(JSON.stringify(await handleCatalog({ callback_query: cb }, env)), { status:200 });

            // qty
            if (data === 'qty_increase') return new Response(JSON.stringify(await handleQtyChange({ callback_query: cb }, env, +1)), { status:200 });
            if (data === 'qty_decrease') return new Response(JSON.stringify(await handleQtyChange({ callback_query: cb }, env, -1)), { status:200 });
            if (data === 'buy_all') return new Response(JSON.stringify(await handleBuyAll({ callback_query: cb }, env)), { status:200 });

            // purchase
            if (data === 'purchase_start') return new Response(JSON.stringify(await handlePurchaseStart({ callback_query: cb }, env)), { status:200 });

            // check payment
            if (data.startsWith('check_payment_')) {
                const paymentId = data.replace('check_payment_', '');
                await answerCallbackQuery(env.BOT_TOKEN, cb.id);
                await handleCheckPayment({ callback_query: cb }, env, paymentId);
                return new Response('ok', { status:200 });
            }

            // profile/riwayat/help/achievements
            if (data === 'profile') return new Response(JSON.stringify(await handleProfile({ callback_query: cb }, env)), { status:200 });
            if (data === 'riwayat') return new Response(JSON.stringify(await handleRiwayat({ callback_query: cb }, env)), { status:200 });
            if (data === 'full_riwayat') return new Response(JSON.stringify(await handleFullRiwayat({ callback_query: cb }, env)), { status:200 });
            if (data === 'achievements') return new Response(JSON.stringify(await handleAchievements({ callback_query: cb }, env)), { status:200 });
            if (data === 'help') return new Response(JSON.stringify(await handleHelp({ callback_query: cb }, env)), { status:200 });

            // back navigation
            if (data === 'back_to_main') { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return new Response(JSON.stringify(await handleStart({ message: { from: cb.from } }, env)), { status:200 }); }
            if (data === 'back_to_admin') { await answerCallbackQuery(env.BOT_TOKEN, cb.id); return new Response(JSON.stringify(await handleAdminCommand({ message: { from: cb.from } }, env)), { status:200 }); }

            // admin pages
            if (data === 'admin_pending') return new Response(JSON.stringify(await handleAdminPending({ callback_query: cb }, env)), { status:200 });

            await answerCallbackQuery(env.BOT_TOKEN, cb.id, 'Perintah tidak dikenali', true);
            return new Response('ok', { status:200 });
        }

        return new Response('ok', { status:200 });
    } catch (err) {
        console.error('router error', err);
        return new Response('error', { status:500 });
    }
});

// health
router.get('/', () => new Response('OK - bot worker running'));

// export
export default {
    fetch: router.handle
};
