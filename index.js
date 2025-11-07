// index.js
// Telegram bot for Cloudflare Workers
// - Catalog / product purchase via invoice QRIS
// - Webhook to receive payment success and deliver account
// - Admin product add/delete via HTTP & basic admin menu preserved
// - Auto-broadcast up to 2x/hour via /cron (called by external scheduler)
// - Keep legacy features available where reasonable

import { Router } from 'itty-router';
const router = Router();

// -------------------- In-memory session (temporary) --------------------
const userSessions = new Map();
function setUserSession(userId, data) {
  userSessions.set(String(userId), { ...data, timestamp: Date.now() });
}
function getUserSession(userId) {
  const s = userSessions.get(String(userId));
  if (!s) return null;
  if (Date.now() - s.timestamp > 30 * 60 * 1000) { userSessions.delete(String(userId)); return null; }
  return s;
}
function clearUserSession(userId) { userSessions.delete(String(userId)); }

// -------------------- Helpers --------------------
function formatNumber(num) {
  if (num === undefined || num === null) return "0";
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function nowISO() { return new Date().toISOString(); }
function boxText(lines) {
  // lines: array of strings. returns string of box with Unicode corners and padded lines
  const width = Math.max(...lines.map(l => l.length), 36);
  const top = '┏' + '━'.repeat(width + 2) + '┓';
  const bottom = '┗' + '━'.repeat(width + 2) + '┛';
  const middle = lines.map(l => '┃ ' + l.padEnd(width, ' ') + ' ┃').join('\n');
  return `${top}\n${middle}\n${bottom}`;
}
function pickRandom(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

// -------------------- KV wrappers (uses env.BOT_DB) --------------------
let KV = null; // will set in fetch entry
async function kvGet(key) {
  try {
    const raw = await KV.get(key, 'json');
    return raw || {};
  } catch (e) {
    console.error('kvGet error', e);
    return {};
  }
}
async function kvPut(key, value) {
  try {
    await KV.put(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('kvPut error', e);
    return false;
  }
}

// -------------------- Telegram API helpers --------------------
async function tgSendMessage(botToken, chatId, text, replyMarkup = null, parseMode = 'HTML', disablePreview = true) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: !!disablePreview };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (e) { console.error('tgSendMessage error', e); return null; }
}
async function tgSendPhoto(botToken, chatId, photoUrl, caption = '', replyMarkup = null, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (e) { console.error('tgSendPhoto error', e); return null; }
}
async function tgEditMessage(botToken, chatId, messageId, text, replyMarkup = null, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (e) { console.error('tgEditMessage error', e); return null; }
}
async function tgAnswerCallback(botToken, callbackId, text=null, showAlert=false) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const payload = { callback_query_id: callbackId };
  if (text) { payload.text = text; payload.show_alert = showAlert; }
  try { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return await res.json(); }
  catch (e) { console.error('tgAnswerCallback error', e); return null; }
}

// -------------------- Data structures in KV --------------------
/*
KV keys:
- users              : { userId: { joinDate, chatId } }
- accounts           : { sku: { title, description, price, list: [ "login|pass", ... ], stock } }
- transactions       : { userId: [ ... ] }
- pending_payments   : { trxid: { userId, productSku, qty, amount, createdAt, expiresAt, status, provider_response } }
- broadcast          : { enabled, message, lastSentAt, sentHour, sentThisHour }
- reward_settings    : existing if any
- statistics         : existing if any
*/

// -------------------- UI builder functions --------------------
function buildCatalogMessage(accounts) {
  const keys = Object.keys(accounts || {});
  if (keys.length === 0) return `📦 <b>KATALOG PRODUK</b>\n\nBelum ada produk tersedia saat ini.`;
  const lines = [`📦 <b>KATALOG PRODUK</b>\n`];
  keys.forEach((k, idx) => {
    const p = accounts[k];
    const stokText = (!p.list || p.list.length === 0) ? '❌ Habis' : `✅ Stok Tersedia: ${p.list.length}`;
    lines.push(`<b>[ ${idx + 1} ] ${escapeHtml(p.title || `Produk ${idx+1}`)}</b>\n┄┄┄┄┄┄┄\n${p.price ? '💰 Harga: Rp ' + formatNumber(p.price) + '\n' : ''}${stokText}\n`);
  });
  lines.push(`\n<code>pilih produk yang anda inginkan:</code>`);
  return lines.join('\n');
}
function buildProductDetailMessage(product, qty = 1) {
  const price = product.price || 0;
  const total = price * qty;
  const stockText = (!product.list || product.list.length === 0) ? '❌ Habis' : `✅ Stok Tersisa: ${product.list.length}`;
  return `📦 <b>${escapeHtml(product.title || 'Produk')}</b>\n\n💰 <b>Harga Satuan:</b> Rp ${formatNumber(price)}\n${stockText}\n\n<b>📝 Deskripsi:</b>\n${escapeHtml(product.description || 'Tidak ada deskripsi.')}\n\n<code>================================</code>\n<b>Total Harga:</b> Rp ${formatNumber(total)}\n\nSilakan tentukan jumlah yang ingin dibeli:`;
}

// -------------------- Payment helpers --------------------
async function createInvoice(env, meta) {
  // meta: { amount, productSku, qty, userId, description }
  const apiUrl = env.PAYMENT_API_URL;
  if (!apiUrl) throw new Error('PAYMENT_API_URL not configured');
  const apiKey = env.PAYMENT_API_KEY || null;
  // construct payload according to provider expectations; generic structure:
  const payload = {
    amount: meta.amount,
    description: meta.description || `Pembelian ${meta.productSku}`,
    metadata: { userId: meta.userId, productSku: meta.productSku, qty: meta.qty },
    callback_url: meta.callback_url || (env.WEBHOOK_BASE_URL ? `${env.WEBHOOK_BASE_URL}/webhook` : undefined)
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
    const json = await res.json();
    // We assume provider returns JSON with fields like: status, trxid/trx_id, qris_url/qr, amount, fee, expired_at, payment_url
    return json;
  } catch (e) {
    console.error('createInvoice error', e);
    return null;
  }
}
async function verifyInvoiceStatus(env, trxid) {
  try {
    const statusUrl = env.PAYMENT_API_STATUS_URL || (env.PAYMENT_API_URL + '/status');
    const apiKey = env.PAYMENT_API_KEY || null;
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

// -------------------- Process payment success --------------------
async function processSuccessfulPayment(env, trxid, providerPayload) {
  const pending = await kvGet('pending_payments');
  if (!pending[trxid]) {
    console.warn('pending not found for trx', trxid);
    return false;
  }
  const p = pending[trxid];
  if (p.status === 'paid') return true;

  // load accounts
  const accounts = await kvGet('accounts');
  const prod = accounts[p.productSku];
  if (!prod) {
    await tgSendMessage(env.BOT_TOKEN, p.userId, `❌ Produk untuk Trx ${trxid} tidak ditemukan. Hubungi admin.`);
    p.status = 'failed';
    pending[trxid] = p; await kvPut('pending_payments', pending);
    return false;
  }
  if (!prod.list || prod.list.length < p.qty) {
    await tgSendMessage(env.BOT_TOKEN, p.userId, `❌ Stok tidak mencukupi untuk produk ${prod.title}. Hubungi admin.`);
    p.status = 'failed';
    pending[trxid] = p; await kvPut('pending_payments', pending);
    return false;
  }

  // pop items
  const items = prod.list.splice(0, p.qty);
  prod.stock = prod.list.length;
  accounts[p.productSku] = prod;
  await kvPut('accounts', accounts);

  // mark paid
  p.status = 'paid';
  p.paidAt = nowISO();
  p.provider_payload = providerPayload;
  pending[trxid] = p;
  await kvPut('pending_payments', pending);

  // save transaction
  const transactions = await kvGet('transactions');
  if (!transactions[p.userId]) transactions[p.userId] = [];
  transactions[p.userId].push({
    id: 'TXN' + Date.now().toString(36),
    type: 'purchase',
    amount: p.amount,
    productSku: p.productSku,
    qty: p.qty,
    items,
    timestamp: nowISO(),
    provider: providerPayload || {}
  });
  await kvPut('transactions', transactions);

  // send items to user
  let detail = `✅ <b>Pembayaran Berhasil!</b>\n\nBerikut detail akun Anda:\n\n`;
  items.forEach((it, idx) => {
    detail += `<b>● Akun ${idx+1}:</b>\n<code>${escapeHtml(it)}</code>\n\n`;
  });
  detail += `<code>Trx ID:</code> ${trxid}\n<code>Produk:</code> ${escapeHtml(prod.title)}\n<code>Jumlah:</code> ${p.qty}\nTerima kasih!`;

  await tgSendMessage(env.BOT_TOKEN, p.userId, detail, null, 'HTML');

  // notify admin
  if (env.ADMIN_ID) {
    await tgSendMessage(env.BOT_TOKEN, env.ADMIN_ID, `🧾 Pembayaran diterima: Trx ${trxid}\nUser: ${p.userId}\nProduk: ${prod.title}\nJumlah: ${p.qty}`);
  }
  return true;
}

// -------------------- Handlers (start, catalog, product, purchase) --------------------
async function handleStart(update, env) {
  const msg = update.message;
  const from = msg.from;
  const userId = String(from.id);
  // register user
  const users = await kvGet('users');
  if (!users[userId]) { users[userId] = { joinDate: nowISO(), chatId: from.id }; await kvPut('users', users); }

  // random emoji + banner Nexus
  const emojis = ['🎉','🚀','💎','✨','🔥','🌐','⚙️','📦'];
  const emoji = pickRandom(emojis);
  const bannerUrl = env.NEXUS_BANNER_URL || null; // set in env if want image displayed

  // first send emoji then banner then menu
  await tgSendMessage(env.BOT_TOKEN, from.id, `${emoji}`);
  if (bannerUrl) {
    // caption afterwards: welcome and menu
    await tgSendPhoto(env.BOT_TOKEN, from.id, bannerUrl, `<b>Selamat Datang di Nexus Store</b>\n\nPilih menu di bawah untuk mulai.`, { inline_keyboard: [[{ text: "🛒 Katalog Produk", callback_data: "catalog" }],[{ text: "ℹ️ Bantuan", callback_data: "help" }]] }, 'HTML');
    return;
  }

  // fallback message if no banner
  const accounts = await kvGet('accounts');
  const stok = Object.keys(accounts).length;
  const message = `
🎊 <b>Selamat Datang di Nexus Store!</b>

┌─── 📦 <b>INFO SINGKAT</b> ───┐
│ 👤 <b>User ID:</b> <code>${userId}</code>
│ 📦 <b>Produk:</b> <code>${stok} item</code>
└─────────────────────
  `;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🛒 Katalog Produk", callback_data: "catalog" }],
      [{ text: "👤 Profile", callback_data: "profile" }, { text: "ℹ️ Bantuan", callback_data: "help" }]
    ]
  };
  await tgSendMessage(env.BOT_TOKEN, from.id, message, keyboard, 'HTML');
}

async function handleCatalog(update, env) {
  const callback = update.callback_query;
  const from = callback ? callback.from : update.message.from;
  const accounts = await kvGet('accounts');
  const message = buildCatalogMessage(accounts);

  const keys = Object.keys(accounts || {});
  const row = [];
  for (let i=0;i<Math.min(6, keys.length);i++) row.push({ text: `${i+1}`, callback_data: `catalog_select_${i}` });
  const reply = { inline_keyboard: [ row, [{ text: "➡️ Selanjutnya", callback_data: "catalog_next" }], [{ text: "🔙 Kembali ke Menu", callback_data: "back_to_main" }] ] };

  if (callback) { await tgAnswerCallback(env.BOT_TOKEN, callback.id); await tgEditMessage(env.BOT_TOKEN, from.id, callback.message.message_id, message, reply, 'HTML'); }
  else { await tgSendMessage(env.BOT_TOKEN, from.id, message, reply, 'HTML'); }
}

async function handleCatalogSelect(update, env, index=0) {
  const cb = update.callback_query;
  const from = cb.from;
  const accounts = await kvGet('accounts');
  const keys = Object.keys(accounts);
  if (!keys[index]) { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "❌ Produk tidak ditemukan!", true); return; }
  const product = accounts[keys[index]];
  setUserSession(from.id, { action: 'browsing_product', productKey: keys[index], qty: 1 });

  const message = buildProductDetailMessage(product, 1);
  const keyboard = {
    inline_keyboard: [
      [{ text: "➖", callback_data: "qty_decrease" }, { text: "1", callback_data: "qty_show" }, { text: "➕", callback_data: "qty_increase" }],
      [{ text: `🛒 Beli Semua Stok (${(product.list && product.list.length) || 0})`, callback_data: `buy_all` }],
      [{ text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }],
      [{ text: "🔙 Kembali ke Daftar", callback_data: "catalog" }]
    ]
  };
  await tgAnswerCallback(env.BOT_TOKEN, cb.id);
  await tgEditMessage(env.BOT_TOKEN, from.id, cb.message.message_id, message, keyboard, 'HTML');
}

async function handleQtyChange(update, env, delta=0) {
  const cb = update.callback_query;
  const userId = cb.from.id;
  const session = getUserSession(userId);
  if (!session || session.action !== 'browsing_product') { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "Sesi produk tidak ditemukan.", true); return; }
  const accounts = await kvGet('accounts');
  const product = accounts[session.productKey];
  if (!product) { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true); return; }
  let qty = session.qty || 1;
  qty += delta;
  if (qty < 1) qty = 1;
  if (product.list && qty > product.list.length) qty = product.list.length;
  setUserSession(userId, { ...session, qty });
  const message = buildProductDetailMessage(product, qty);
  const keyboard = {
    inline_keyboard: [
      [{ text: "➖", callback_data: "qty_decrease" }, { text: `${qty}`, callback_data: "qty_show" }, { text: "➕", callback_data: "qty_increase" }],
      [{ text: `🛒 Beli Semua Stok (${(product.list && product.list.length) || 0})`, callback_data: `buy_all` }],
      [{ text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }],
      [{ text: "🔙 Kembali ke Daftar", callback_data: "catalog" }]
    ]
  };
  await tgAnswerCallback(env.BOT_TOKEN, cb.id);
  await tgEditMessage(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard, 'HTML');
}

async function handleBuyAll(update, env) {
  const cb = update.callback_query;
  const session = getUserSession(cb.from.id);
  if (!session || session.action !== 'browsing_product') { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "Sesi produk tidak ditemukan.", true); return; }
  const accounts = await kvGet('accounts'), product = accounts[session.productKey];
  const qty = (product.list && product.list.length) ? product.list.length : 1;
  setUserSession(cb.from.id, { ...session, qty });
  const message = buildProductDetailMessage(product, qty);
  const keyboard = {
    inline_keyboard: [
      [{ text: "➖", callback_data: "qty_decrease" }, { text: `${qty}`, callback_data: "qty_show" }, { text: "➕", callback_data: "qty_increase" }],
      [{ text: `🛒 Beli Semua Stok (${(product.list && product.list.length) || 0})`, callback_data: `buy_all` }],
      [{ text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }],
      [{ text: "🔙 Kembali ke Daftar", callback_data: "catalog" }]
    ]
  };
  await tgAnswerCallback(env.BOT_TOKEN, cb.id);
  await tgEditMessage(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard, 'HTML');
}

async function handlePurchaseConfirm(update, env) {
  const cb = update.callback_query;
  const userId = String(cb.from.id);
  const session = getUserSession(cb.from.id);
  if (!session || session.action !== 'browsing_product') { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "Sesi pembelian tidak ditemukan.", true); return; }
  const accounts = await kvGet('accounts');
  const product = accounts[session.productKey];
  if (!product) { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true); return; }
  const qty = session.qty || 1;
  if (!product.list || product.list.length < qty) { await tgAnswerCallback(env.BOT_TOKEN, cb.id, "Stok tidak mencukupi.", true); return; }
  const total = (product.price || 0) * qty;
  await tgAnswerCallback(env.BOT_TOKEN, cb.id);

  // create invoice
  const invoiceMeta = { amount: total, productSku: session.productKey, qty, userId, description: `${product.title} x${qty}`, callback_url: env.WEBHOOK_BASE_URL ? `${env.WEBHOOK_BASE_URL}/webhook` : undefined };
  const invoiceResp = await createInvoice(env, invoiceMeta);
  if (!invoiceResp || !(invoiceResp.status || invoiceResp.success)) {
    await tgSendMessage(env.BOT_TOKEN, cb.from.id, `❌ Gagal membuat invoice. Silakan coba lagi nanti.`);
    return;
  }

  // determine trx id & qr url
  const trxid = invoiceResp.trxid || invoiceResp.trx_id || invoiceResp.reference || invoiceResp.order_id || invoiceResp.id || ('TRX' + Date.now().toString(36));
  const qrUrl = invoiceResp.qris_url || invoiceResp.qr || invoiceResp.qr_image || invoiceResp.image || invoiceResp.payment_qr || invoiceResp.payment_image;
  const fee = invoiceResp.fee || 0;
  const totalBayar = invoiceResp.amount || total;
  // save pending
  const pending = await kvGet('pending_payments');
  pending[trxid] = { userId, productSku: session.productKey, qty, amount: total, createdAt: nowISO(), expiresAt: invoiceResp.expired_at || invoiceResp.expired || null, status: 'pending', provider_response: invoiceResp };
  await kvPut('pending_payments', pending);

  // build caption box lines
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
  const caption = boxText(captionLines);

  const keyboard = { inline_keyboard: [[{ text: "✅ Cek Otomatis", callback_data: `check_payment_${trxid}` }],[{ text: "❌ Batalkan Pesanan", callback_data: `cancel_payment_${trxid}` }]] };

  if (qrUrl) {
    await tgSendPhoto(env.BOT_TOKEN, cb.from.id, qrUrl, caption, keyboard, 'HTML');
  } else {
    const paymentLink = invoiceResp.payment_url || invoiceResp.url || invoiceResp.payment_link || invoiceResp.payment;
    const msg = caption + '\n\n' + (paymentLink ? `Pembayaran: ${paymentLink}` : '');
    await tgSendMessage(env.BOT_TOKEN, cb.from.id, msg, keyboard, 'HTML');
  }

  clearUserSession(cb.from.id);
}

// user-triggered check payment
async function handleCheckPayment(update, env, trxid) {
  const cb = update.callback_query;
  await tgAnswerCallback(env.BOT_TOKEN, cb.id);
  const pending = await kvGet('pending_payments');
  if (!pending[trxid]) { await tgSendMessage(env.BOT_TOKEN, cb.from.id, 'Invoice tidak ditemukan atau sudah kadaluwarsa.'); return; }
  const v = await verifyInvoiceStatus(env, trxid);
  if (v && (v.status === 'success' || v.paid === true || v.status === true)) {
    await processSuccessfulPayment(env, trxid, v);
    await tgSendMessage(env.BOT_TOKEN, cb.from.id, '✅ Pembayaran terkonfirmasi, pesanan diproses.');
  } else {
    await tgSendMessage(env.BOT_TOKEN, cb.from.id, '⏳ Pembayaran belum terkonfirmasi. Silakan coba lagi nanti.');
  }
}
async function handleCancelPayment(update, env, trxid) {
  const cb = update.callback_query;
  await tgAnswerCallback(env.BOT_TOKEN, cb.id);
  const pending = await kvGet('pending_payments');
  const p = pending[trxid];
  if (!p) { await tgSendMessage(env.BOT_TOKEN, cb.from.id, 'Invoice tidak ditemukan.'); return; }
  if (String(cb.from.id) !== String(p.userId) && String(cb.from.id) !== String(env.ADMIN_ID)) { await tgSendMessage(env.BOT_TOKEN, cb.from.id, 'Hanya pemesan atau admin yang dapat membatalkan.'); return; }
  delete pending[trxid];
  await kvPut('pending_payments', pending);
  await tgSendMessage(env.BOT_TOKEN, cb.from.id, `✅ Pesanan ${trxid} dibatalkan.`);
}

// -------------------- Profile / Riwayat / Help (kept) --------------------
async function handleProfile(update, env) {
  const cv = update.callback_query;
  const from = cv ? cv.from : update.message.from;
  const userId = String(from.id);
  const transactions = await kvGet('transactions');
  const userTransactions = transactions[userId] || [];
  const message = `
👤 <b>Profile Pengguna</b>

┌─── 📊 <b>STATISTIK</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📋 <b>Total Transaksi:</b> <code>${userTransactions.length}</code>
└─────────────────────
  `;
  const keyboard = { inline_keyboard: [[{ text: "📊 Riwayat", callback_data: "riwayat" }], [{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
  if (cv) { await tgAnswerCallback(env.BOT_TOKEN, cv.id); await tgEditMessage(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard, 'HTML'); }
  else await tgSendMessage(env.BOT_TOKEN, from.id, message, keyboard, 'HTML');
}
async function handleRiwayat(update, env) {
  const cv = update.callback_query;
  const from = cv ? cv.from : update.message.from;
  const userId = String(from.id);
  const transactions = await kvGet('transactions');
  const userTransactions = transactions[userId] || [];
  if (userTransactions.length === 0) {
    const message = `📊 <b>Riwayat Transaksi</b>\n\nBelum ada transaksi yang dilakukan. Mulai belanja sekarang! 🛒`;
    const keyboard = { inline_keyboard: [[{ text: "🛒 Belanja Sekarang", callback_data: "catalog" }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
    if (cv) { await tgAnswerCallback(env.BOT_TOKEN, cv.id); await tgEditMessage(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard, 'HTML'); }
    else await tgSendMessage(env.BOT_TOKEN, from.id, message, keyboard, 'HTML');
    return;
  }
  const recent = userTransactions.slice(-10).reverse();
  const list = recent.map((t, idx) => {
    const date = new Date(t.timestamp).toLocaleDateString('id-ID');
    return `${idx+1}. 🛒 ${t.productSku || ''}\n   💰 Rp ${formatNumber(t.amount)} | 📅 ${date}`;
  }).join('\n\n');
  const message = `📊 <b>Riwayat Transaksi Terakhir</b>\n\n${list}\n\n<code>================================</code>\n<i>Menampilkan 10 transaksi terakhir</i>`;
  const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "riwayat" }, { text: "📋 Semua Riwayat", callback_data: "full_riwayat" }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
  if (cv) { await tgAnswerCallback(env.BOT_TOKEN, cv.id); await tgEditMessage(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard, 'HTML'); }
  else await tgSendMessage(env.BOT_TOKEN, from.id, message, keyboard, 'HTML');
}
async function handleHelp(update, env) {
  const cv = update.callback_query;
  const from = cv ? cv.from : update.message.from;
  const message = `
ℹ️ <b>Pusat Bantuan</b>

📖 Cara Menggunakan Bot:
1. Pilih Katalog → pilih produk → atur jumlah → Lanjutkan Pembelian
2. Bot akan mengirim invoice QRIS. Scan untuk bayar.
3. Setelah pembayaran terkonfirmasi, akun dikirim otomatis.

👨‍💼 <b>Admin Support:</b> ${env.ADMIN_USERNAME || "@admin"}
  `;
  const keyboard = { inline_keyboard: [[{ text: "🛒 Beli Akun", callback_data: "catalog" }],[{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };
  if (cv) { await tgAnswerCallback(env.BOT_TOKEN, cv.id); await tgEditMessage(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard, 'HTML'); }
  else await tgSendMessage(env.BOT_TOKEN, from.id, message, keyboard, 'HTML');
}

// -------------------- Admin HTTP endpoints (add/delete product, set broadcast) --------------------
async function handleAdminAddProductHTTP(request, env) {
  try {
    const body = await request.json();
    const keyOk = (body.api_key && body.api_key === env.ADMIN_API_KEY) || (request.headers.get('x-admin-id') && String(request.headers.get('x-admin-id')) === String(env.ADMIN_ID));
    if (!keyOk) return new Response(JSON.stringify({ success: false, message: 'unauthorized' }), { status: 401 });
    const { productSku, title, description, price, list } = body;
    if (!productSku || !title) return new Response(JSON.stringify({ success: false, message: 'productSku/title required' }), { status: 400 });
    const accounts = await kvGet('accounts');
    accounts[productSku] = { title, description: description||'', price: parseInt(price)||0, list: Array.isArray(list)?list:(list? [list] : []), stock: Array.isArray(list)?list.length:(list?1:0) };
    await kvPut('accounts', accounts);
    return new Response(JSON.stringify({ success: true, product: accounts[productSku] }), { status: 200 });
  } catch (e) { console.error(e); return new Response(JSON.stringify({ success:false, message:'error' }), { status: 500 }); }
}
async function handleAdminDeleteProductHTTP(request, env) {
  try {
    const body = await request.json();
    const keyOk = (body.api_key && body.api_key === env.ADMIN_API_KEY) || (request.headers.get('x-admin-id') && String(request.headers.get('x-admin-id')) === String(env.ADMIN_ID));
    if (!keyOk) return new Response(JSON.stringify({ success: false, message: 'unauthorized' }), { status: 401 });
    const { productSku } = body;
    if (!productSku) return new Response(JSON.stringify({ success: false, message: 'productSku required' }), { status: 400 });
    const accounts = await kvGet('accounts');
    if (!accounts[productSku]) return new Response(JSON.stringify({ success:false, message:'not found' }), { status: 404 });
    delete accounts[productSku];
    await kvPut('accounts', accounts);
    return new Response(JSON.stringify({ success:true }), { status: 200 });
  } catch (e) { console.error(e); return new Response(JSON.stringify({ success:false, message:'error'}), { status: 500 }); }
}
async function handleAdminSetBroadcastHTTP(request, env) {
  try {
    const body = await request.json();
    const keyOk = (body.api_key && body.api_key === env.ADMIN_API_KEY) || (request.headers.get('x-admin-id') && String(request.headers.get('x-admin-id')) === String(env.ADMIN_ID));
    if (!keyOk) return new Response(JSON.stringify({ success: false, message: 'unauthorized' }), { status: 401 });
    const broadcast = await kvGet('broadcast');
    broadcast.enabled = body.enabled === undefined ? (broadcast.enabled || false) : Boolean(body.enabled);
    if (body.message) broadcast.message = body.message;
    if (!broadcast.lastSentAt) broadcast.lastSentAt = null;
    if (!broadcast.sentThisHour) broadcast.sentThisHour = 0;
    await kvPut('broadcast', broadcast);
    return new Response(JSON.stringify({ success:true, broadcast }), { status: 200 });
  } catch (e) { console.error(e); return new Response(JSON.stringify({ success:false }), { status: 500 }); }
}

// -------------------- Webhook (payment provider) --------------------
async function handleWebhook(request, env) {
  // validate secret header
  const secret = request.headers.get('x-callback-secret') || request.headers.get('x-secret') || request.headers.get('x-provider-secret');
  if (env.CALLBACK_SECRET && secret !== env.CALLBACK_SECRET) return new Response('unauthorized', { status: 401 });
  let payload;
  try { payload = await request.json(); } catch(e) { console.error('webhook parse', e); return new Response('bad request', { status: 400 }); }
  const status = payload.status || payload.payment_status || (payload.paid ? 'success' : 'pending');
  const trxid = payload.trxid || payload.trx_id || payload.reference || payload.order_id || payload.id;
  if (!trxid) { console.warn('webhook missing trxid', payload); return new Response('missing trxid', { status: 400 }); }
  if (status === 'success' || status === 'paid' || payload.paid === true || status === 'PAID') {
    try {
      await processSuccessfulPayment(env, trxid, payload);
    } catch (e) { console.error('processSuccessfulPayment webhook error', e); return new Response('error', { status: 500 }); }
  } else {
    // update pending status
    const pending = await kvGet('pending_payments');
    if (pending[trxid]) { pending[trxid].status = status; pending[trxid].provider_payload = payload; await kvPut('pending_payments', pending); }
  }
  return new Response('ok', { status: 200 });
}

// -------------------- Cron / Broadcast --------------------
async function handleCron(request, env) {
  const broadcast = await kvGet('broadcast');
  if (!broadcast.enabled || !broadcast.message) return new Response('broadcast disabled', { status: 200 });
  const lastSentAt = broadcast.lastSentAt ? new Date(broadcast.lastSentAt) : null;
  const now = new Date();
  const currentHour = now.getUTCHours();
  if (!broadcast.sentHour || broadcast.sentHour !== currentHour) {
    broadcast.sentHour = currentHour;
    broadcast.sentThisHour = 0;
  }
  const minGapMs = 30 * 60 * 1000;
  const canSend = (broadcast.sentThisHour < 2) && (!lastSentAt || (now - lastSentAt) >= minGapMs);
  if (!canSend) return new Response('no send', { status: 200 });
  const users = await kvGet('users');
  const uids = Object.keys(users || {});
  for (const uid of uids) {
    try { await tgSendMessage(env.BOT_TOKEN, users[uid].chatId, broadcast.message); } catch(e){ console.error('broadcast error', e); }
  }
  broadcast.lastSentAt = now.toISOString();
  broadcast.sentThisHour = (broadcast.sentThisHour || 0) + 1;
  await kvPut('broadcast', broadcast);
  return new Response('sent', { status: 200 });
}

// -------------------- Router entry (webhook, admin HTTP) & Telegram update receiver --------------------
router.post('/', async (request, env) => {
  // Telegram updates will arrive here
  KV = env.BOT_DB; // set KV binding
  try {
    const update = await request.json();
    // handle message
    if (update.message) {
      const msg = update.message;
      const text = msg.text || '';
      // /start
      if (text && text.startsWith('/start')) { await handleStart({ message: msg }, env); return new Response('ok', { status: 200 }); }
      if (text && text.startsWith('/admin')) {
        if (String(msg.from.id) !== String(env.ADMIN_ID)) { await tgSendMessage(env.BOT_TOKEN, msg.from.id, '❌ Akses Ditolak!'); return new Response('ok', { status: 200 }); }
        // provide admin quick help (preserve old admin menu)
        const adminHelp = `Admin Dashboard (HTTP endpoints available):
- POST /admin/add_product  (json body: api_key, productSku, title, price, list[])
- POST /admin/delete_product (json body: api_key, productSku)
- POST /admin/set_broadcast (json body: api_key, enabled, message)
Use external HTTP calls to manage products/broadcast.`;
        await tgSendMessage(env.BOT_TOKEN, msg.from.id, adminHelp);
        return new Response('ok', { status: 200 });
      }
      // other text—ignored for now or handled by legacy flows elsewhere
      return new Response('ok', { status: 200 });
    }
    // callback_query handling
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';
      // main flows
      if (data === 'catalog') { await handleCatalog({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
      if (data.startsWith('catalog_select_')) {
        const idx = parseInt(data.split('_').pop());
        await handleCatalogSelect({ callback_query: cb }, env, idx);
        return new Response('ok', { status: 200 });
      }
      if (data === 'catalog_next') { await handleCatalog({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
      if (data === 'qty_increase') { await handleQtyChange({ callback_query: cb }, env, +1); return new Response('ok', { status: 200 }); }
      if (data === 'qty_decrease') { await handleQtyChange({ callback_query: cb }, env, -1); return new Response('ok', { status: 200 }); }
      if (data === 'buy_all') { await handleBuyAll({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
      if (data === 'purchase_confirm') { await handlePurchaseConfirm({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
      if (data === 'profile') { await handleProfile({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
      if (data === 'riwayat') { await handleRiwayat({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
      if (data === 'help') { await handleHelp({ callback_query: cb }, env); return new Response('ok', { status: 200 }); }
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
      await tgAnswerCallback(env.BOT_TOKEN, cb.id, 'Perintah tidak dikenali.', true);
      return new Response('ok', { status: 200 });
    }
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('update handling error', err);
    return new Response('error', { status: 500 });
  }
});

// Admin HTTP endpoints (not Telegram commands) - use /admin/* paths
router.post('/admin/add_product', async (request, env) => {
  KV = env.BOT_DB;
  return await handleAdminAddProductHTTP(request, env);
});
router.post('/admin/delete_product', async (request, env) => {
  KV = env.BOT_DB;
  return await handleAdminDeleteProductHTTP(request, env);
});
router.post('/admin/set_broadcast', async (request, env) => {
  KV = env.BOT_DB;
  return await handleAdminSetBroadcastHTTP(request, env);
});

// webhook (payment provider)
router.post('/webhook', async (request, env) => {
  KV = env.BOT_DB;
  return await handleWebhook(request, env);
});

// cron endpoint for broadcast
router.post('/cron', async (request, env) => {
  KV = env.BOT_DB;
  return await handleCron(request, env);
});

// fallback
router.all('*', () => new Response('Not found', { status: 404 }));

// -------------------- Worker fetch export --------------------
export default {
  async fetch(request, env) {
    // set KV binding for helper functions
    KV = env.BOT_DB;
    // let router handle
    try {
      return await router.handle(request, env);
    } catch (e) {
      console.error('router error', e);
      return new Response('internal error', { status: 500 });
    }
  }
};
