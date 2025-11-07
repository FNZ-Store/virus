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
    console.log(`Session set for user ${userId}:`, sessionData.action);
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

// -------------------- KV Helpers --------------------
async function loadDB(binding, dbType) {
    try {
        const raw = await binding.get(dbType, 'json');
        return raw || {};
    } catch (err) {
        console.error('loadDB error', err);
        return {};
    }
}

async function saveDB(binding, data, dbType) {
    try {
        await binding.put(dbType, JSON.stringify(data));
        return true;
    } catch (err) {
        console.error('saveDB error', err);
        return false;
    }
}

// pending payments helpers
async function loadPendingPayments(binding) {
    try {
        const data = await binding.get('pending_payments', 'json');
        return data || {};
    } catch (error) {
        return {};
    }
}
async function savePendingPayment(binding, userId, paymentData) {
    try {
        const pending = await loadPendingPayments(binding);
        pending[userId] = {
            ...paymentData,
            timestamp: (paymentData.timestamp && paymentData.timestamp.toISOString) ? paymentData.timestamp.toISOString() : new Date().toISOString()
        };
        await binding.put('pending_payments', JSON.stringify(pending));
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}
async function removePendingPayment(binding, userId) {
    try {
        const pending = await loadPendingPayments(binding);
        if (pending[userId]) delete pending[userId];
        await binding.put('pending_payments', JSON.stringify(pending));
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}
async function getPendingPayment(binding, userId) {
    try {
        const pending = await loadPendingPayments(binding);
        const p = pending[userId];
        if (!p) return null;
        return { ...p, timestamp: new Date(p.timestamp) };
    } catch (e) {
        console.error(e);
        return null;
    }
}

// -------------------- Statistics & Reward Settings --------------------
async function loadStatistics(binding) {
    try {
        const data = await binding.get('statistics', 'json');
        return data || {
            totalTransactions: 0,
            totalRevenue: 0,
            totalUsers: 0,
            dailyStats: {},
            popularProducts: {}
        };
    } catch (error) {
        return {
            totalTransactions: 0,
            totalRevenue: 0,
            totalUsers: 0,
            dailyStats: {},
            popularProducts: {}
        };
    }
}

async function saveStatistics(binding, stats) {
    try {
        await binding.put('statistics', JSON.stringify(stats));
        return true;
    } catch (error) {
        console.error('Error saving statistics:', error);
        return false;
    }
}

async function updateStatistics(binding, type, data) {
    const stats = await loadStatistics(binding);
    const today = new Date().toISOString().split('T')[0];
    if (!stats.dailyStats[today]) stats.dailyStats[today] = { transactions: 0, revenue: 0, users: 0 };

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

// Reward settings
async function loadRewardSettings(binding) {
    try {
        const data = await binding.get('reward_settings', 'json');
        return data || defaultRewardSettings();
    } catch (error) {
        return defaultRewardSettings();
    }
}
function defaultRewardSettings() {
    return {
        enabled: true,
        depositBonus: { enabled: true, percentage: 5, minAmount: 10000, maxBonus: 50000 },
        purchaseBonus: { enabled: true, cashback: 2, minPurchase: 20000 },
        referralBonus: { enabled: true, bonus: 10000, bonusReferee: 5000 },
        achievementRewards: {
            enabled: true,
            rewards: {
                firstPurchase: 2000,
                fivePurchases: 5000,
                tenPurchases: 10000,
                bigSpender: 15000
            }
        }
    };
}
async function saveRewardSettings(binding, settings) {
    try {
        await binding.put('reward_settings', JSON.stringify(settings));
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

// -------------------- Reward calculation helpers --------------------
async function calculateDepositBonus(binding, nominal) {
    const settings = await loadRewardSettings(binding);
    if (!settings.enabled || !settings.depositBonus.enabled) return 0;
    if (nominal < settings.depositBonus.minAmount) return 0;
    let bonus = Math.floor(nominal * settings.depositBonus.percentage / 100);
    if (bonus > settings.depositBonus.maxBonus) bonus = settings.depositBonus.maxBonus;
    return bonus;
}

async function calculatePurchaseCashback(binding, amount) {
    const settings = await loadRewardSettings(binding);
    if (!settings.enabled || !settings.purchaseBonus.enabled) return 0;
    if (amount < settings.purchaseBonus.minPurchase) return 0;
    return Math.floor(amount * settings.purchaseBonus.cashback / 100);
}

// -------------------- Transactions & Achievements --------------------
async function addTransaction(binding, userId, type, data) {
    const transactions = await loadDB(binding, 'transactions') || {};
    if (!transactions[userId]) transactions[userId] = [];
    const transaction = {
        id: generateTransactionId(),
        type,
        amount: data.amount || 0,
        productName: data.productName || '',
        timestamp: new Date().toISOString(),
        status: data.status || 'completed'
    };
    transactions[userId].push(transaction);
    if (transactions[userId].length > 50) transactions[userId] = transactions[userId].slice(-50);
    await saveDB(binding, transactions, 'transactions');
    return transaction.id;
}

function generateTransactionId() {
    return 'TXN' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
}

async function checkAchievements(envBinding, userId, action, data = {}) {
    const users = await loadDB(envBinding, 'users');
    const user = users[userId];
    if (!user) return;

    if (!user.achievements) {
        user.achievements = { firstPurchase: false, fivePurchases: false, tenPurchases: false, bigSpender: false };
        user.purchaseCount = 0;
        user.totalSpent = 0;
    }

    let achievementUnlocked = null;

    switch (action) {
        case 'purchase':
            user.purchaseCount = (user.purchaseCount || 0) + 1;
            user.totalSpent = (user.totalSpent || 0) + (data.amount || 0);
            const rewardSettings = await loadRewardSettings(envBinding);
            const achievementRewards = rewardSettings.achievementRewards.rewards;

            if (!user.achievements.firstPurchase) {
                user.achievements.firstPurchase = true;
                achievementUnlocked = { title: "Pembeli Pertama 🎯", description: "Selamat! Anda telah melakukan pembelian pertama", reward: achievementRewards.firstPurchase };
            } else if (user.purchaseCount >= 5 && !user.achievements.fivePurchases) {
                user.achievements.fivePurchases = true;
                achievementUnlocked = { title: "Pelanggan Setia ⭐", description: "Anda telah melakukan 5 pembelian!", reward: achievementRewards.fivePurchases };
            } else if (user.purchaseCount >= 10 && !user.achievements.tenPurchases) {
                user.achievements.tenPurchases = true;
                achievementUnlocked = { title: "Pelanggan Premium 👑", description: "Anda telah melakukan 10 pembelian!", reward: achievementRewards.tenPurchases };
            }

            if (achievementUnlocked && rewardSettings.enabled && rewardSettings.achievementRewards.enabled) {
                user.saldo = (user.saldo || 0) + achievementUnlocked.reward;
                await saveDB(envBinding, users, 'users');

                await sendTelegramMessage(envBinding.BOT_TOKEN, parseInt(userId),
                    `🏆 <b>Pencapaian Terbuka!</b>\n\n` +
                    `<b>${achievementUnlocked.title}</b>\n` +
                    `${achievementUnlocked.description}\n` +
                    `🎁 <b>Hadiah:</b> Rp ${formatNumber(achievementUnlocked.reward)}\n\n` +
                    `💰 <b>Saldo bertambah menjadi:</b> Rp ${formatNumber(user.saldo)}`
                );
            }
            break;
    }

    await saveDB(envBinding, users, 'users');
}

// -------------------- Utilities --------------------
function formatNumber(num) {
    if (num === undefined || num === null) return "0";
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function getRandomAmount(env) {
    const min = parseInt(env.RANDOM_AMOUNT_MIN) || 1;
    const max = parseInt(env.RANDOM_AMOUNT_MAX) || 50;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// -------------------- Telegram API Helpers --------------------
async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = { chat_id: chatId, text: text, parse_mode: parseMode };
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
    const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: parseMode };
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

async function editMessageCaption(botToken, chatId, messageId, caption, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/editMessageCaption`;
    const payload = { chat_id: chatId, message_id: messageId, caption, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (e) {
        console.error('editMessageCaption error', e);
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

// -------------------- UI: templates similar to screenshot --------------------
// Catalog listing UI (compact, numbered)
function buildCatalogMessage(accounts) {
    // accounts: object where keys = sku/id
    const lines = [];
    const keys = Object.keys(accounts);
    if (keys.length === 0) {
        return `📦 <b>KATALOG PRODUK</b>\n\nBelum ada produk tersedia saat ini.`;
    }

    lines.push(`📦 <b>KATALOG PRODUK</b>\n`);
    keys.forEach((k, idx) => {
        const p = accounts[k];
        const stokText = (p.stock === 0 || p.stock === '0') ? '❌ Habis' : `✅ Stok Tersedia: ${p.stock}`;
        lines.push(
            `<b>[ ${idx + 1} ] ${escapeHtml(p.title || p.name || `Produk ${idx+1}`)}</b>\n` +
            `┄┄┄┄┄┄┄┄┄┄\n` +
            `${p.price ? '💰 Harga: Rp ' + formatNumber(p.price) + '\n' : ''}` +
            `${stokText}\n`
        );
    });

    lines.push(`\n<code>pilih produk yang anda inginkan:</code>`);
    return lines.join('\n');
}

// Product detail card UI (detailed)
function buildProductDetailMessage(product, qty = 1) {
    const price = product.price || 0;
    const total = price * qty;
    const stockText = (product.stock === 0 || product.stock === '0') ? '❌ Habis' : `✅ Stok Tersisa: ${product.stock}`;
    const desc = product.description || 'Tidak ada deskripsi.';
    return (
        `📦 <b>${escapeHtml(product.title || product.name || 'Produk')}</b>\n\n` +
        `💰 <b>Harga Satuan:</b> Rp ${formatNumber(price)}\n` +
        `${stockText}\n\n` +
        `<b>📝 Deskripsi:</b>\n${escapeHtml(desc)}\n\n` +
        `<code>================================</code>\n` +
        `<b>Total Harga:</b> Rp ${formatNumber(total)}\n\n` +
        `Silakan tentukan jumlah yang ingin dibeli:`
    );
}

function escapeHtml(text) {
    if (!text && text !== 0) return '';
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

// -------------------- Core Handlers (start, catalog, product, purchase flow) --------------------
async function handleStart(update, env) {
    const msg = update.message;
    const user = msg.from;
    const userId = user.id.toString();
    clearUserSession(userId);

    const username = user.username || "Tidak Ada";
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');

    if (!users[userId]) {
        users[userId] = { saldo: 0, joinDate: new Date().toISOString(), firstLogin: new Date().toISOString() };
        await saveDB(env.BOT_DB, users, 'users');
        await updateStatistics(env.BOT_DB, 'user_registered', {});
    }

    const saldo = users[userId].saldo || 0;
    const stok = Object.keys(accounts).length;
    const adminUsername = env.ADMIN_USERNAME || "@admin";

    const message = `
🎊 <b>Selamat Datang di Bot Premium Store!</b>

┌─── 📊 <b>INFO AKUN</b> ───┐
│ 👤 <b>User ID:</b> <code>${userId}</code>
│ 📝 <b>Username:</b> <code>@${username}</code>
│ 💰 <b>Saldo:</b> <code>Rp ${formatNumber(saldo)}</code>
│ 📦 <b>Produk:</b> <code>${stok} item</code>
└─────────────────────

👨‍💼 <b>Admin:</b> ${adminUsername}

<code>================================</code>

✨ <b>Fitur Unggulan:</b>
• 🛒 Beli Akun Premium Otomatis
• 💳 Deposit Instant
• 🏆 Sistem Achievement
• 📊 Riwayat Transaksi

Pilih menu di bawah untuk memulai:
    `;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🛒 Katalog Produk", callback_data: "catalog" }],
            [{ text: "💳 Deposit", callback_data: "deposit" }, { text: "📊 Riwayat", callback_data: "riwayat" }],
            [{ text: "👤 Profile", callback_data: "profile" }, { text: "ℹ️ Bantuan", callback_data: "help" }]
        ]
    };

    return await sendTelegramMessage(env.BOT_TOKEN, user.id, message, keyboard);
}

// Catalog handler (shows compact numbered list + pagination)
async function handleCatalog(update, env) {
    // supports callback_query or message
    const callbackQuery = update.callback_query;
    const from = callbackQuery ? callbackQuery.from : update.message.from;
    const userId = from.id.toString();

    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const message = buildCatalogMessage(accounts);

    // Build keyboard: show first 5 items as quick buttons (or page)
    const keys = Object.keys(accounts);
    const buttons = [];
    for (let i = 0; i < Math.min(5, keys.length); i++) {
        buttons.push([{ text: `${i+1}`, callback_data: `catalog_select_${i}` }]);
    }
    // Add action row
    const reply = {
        inline_keyboard: [
            // numbers row
            keys.slice(0, 5).map((k, idx) => ({ text: `${idx+1}`, callback_data: `catalog_select_${idx}` })),
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

// Catalog selection -> show product detail card
async function handleCatalogSelect(update, env, index = 0) {
    const callbackQuery = update.callback_query;
    const from = callbackQuery.from;
    const userId = from.id.toString();

    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const keys = Object.keys(accounts);
    if (!keys[index]) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Produk tidak ditemukan!", true);
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
                { text: `🛒 Beli Semua Stok (${product.stock})`, callback_data: `buy_all` }
            ],
            [
                { text: "✅ Lanjutkan Pembelian", callback_data: "purchase_confirm" }
            ],
            [
                { text: "🔙 Kembali ke Daftar", callback_data: "catalog" }
            ]
        ]
    };

    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, from.id, callbackQuery.message.message_id, message, keyboard);
}

// Quantity change handlers + purchase confirm flow
async function handleQtyChange(update, env, delta = 0) {
    const cb = update.callback_query;
    const userId = cb.from.id.toString();
    const session = getUserSession(userId);
    if (!session || session.action !== 'browsing_product') {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Sesi produk tidak ditemukan. Silakan buka katalog lagi.", true);
        return;
    }
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const product = accounts[session.productKey];
    if (!product) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true);
        return;
    }

    let qty = session.qty || 1;
    qty = qty + delta;
    if (qty < 1) qty = 1;
    if (product.stock && qty > product.stock) qty = product.stock;

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
                { text: `🛒 Beli Semua Stok (${product.stock})`, callback_data: `buy_all` }
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
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const product = accounts[session.productKey];
    if (!product) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true);
        return;
    }
    const qty = product.stock || 1;
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
                { text: `🛒 Beli Semua Stok (${product.stock})`, callback_data: `buy_all` }
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

    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const product = accounts[session.productKey];
    if (!product) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Produk tidak ditemukan.", true);
        return;
    }

    const qty = session.qty || 1;
    const total = (product.price || 0) * qty;

    // Check user balance
    const users = await loadDB(env.BOT_DB, 'users');
    const userData = users[userId] || { saldo: 0 };
    if (userData.saldo < total) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "Saldo tidak mencukupi. Silakan deposit terlebih dahulu.", true);
        return;
    }

    // Deduct, create transaction, update stock, statistics, achievements
    userData.saldo -= total;
    users[userId] = userData;
    await saveDB(env.BOT_DB, users, 'users');

    // update stock
    if (product.stock !== undefined && !isNaN(product.stock)) {
        product.stock = Math.max(0, (product.stock || 0) - qty);
        accounts[session.productKey] = product;
        await saveDB(env.BOT_DB, accounts, 'accounts');
    }

    // Add transaction
    await addTransaction(env.BOT_DB, userId, 'purchase', { amount: total, productName: product.title || product.name });
    await updateStatistics(env.BOT_DB, 'purchase', { amount: total, productName: product.title || product.name });
    await checkAchievements(env, userId, 'purchase', { amount: total });

    // Clear session
    clearUserSession(userId);

    const message = `✅ Pembelian berhasil!\n\nProduk: <b>${escapeHtml(product.title || product.name)}</b>\nJumlah: <b>${qty}</b>\nTotal: <b>Rp ${formatNumber(total)}</b>\n\nSaldo Anda sekarang: <b>Rp ${formatNumber(userData.saldo)}</b>`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "🛒 Kembali ke Katalog", callback_data: "catalog" }],
            [{ text: "🏠 Menu Utama", callback_data: "back_to_main" }]
        ]
    };

    await answerCallbackQuery(env.BOT_TOKEN, cb.id, "✅ Transaksi berhasil", true);
    return await editMessageText(env.BOT_TOKEN, cb.from.id, cb.message.message_id, message, keyboard);
}

// -------------------- Profile, Riwayat, Achievements, Help (kept format) --------------------
async function handleProfile(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;
    const userId = from.id.toString();
    const users = await loadDB(env.BOT_DB, 'users');
    const userData = users[userId] || { saldo: 0, purchaseCount: 0, totalSpent: 0, joinDate: new Date().toISOString() };
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTransactions = transactions[userId] || [];

    const message = `
👤 <b>Profile Pengguna</b>

┌─── 📊 <b>STATISTIK</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📅 <b>Bergabung:</b> <code>${new Date(userData.joinDate).toLocaleDateString('id-ID')}</code>
│ 🛒 <b>Total Pembelian:</b> <code>${userData.purchaseCount || 0}x</code>
│ 💰 <b>Total Pengeluaran:</b> <code>Rp ${formatNumber(userData.totalSpent || 0)}</code>
│ 💳 <b>Saldo Saat Ini:</b> <code>Rp ${formatNumber(userData.saldo || 0)}</code>
│ 📋 <b>Total Transaksi:</b> <code>${userTransactions.length}</code>
└─────────────────────
    `;
    const keyboard = {
        inline_keyboard: [
            [{ text: "🏆 Pencapaian", callback_data: "achievements" }, { text: "📊 Riwayat", callback_data: "riwayat" }],
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
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
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
        const time = new Date(t.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        return `${idx+1}. ${t.type === 'purchase' ? '🛒' : t.type === 'deposit' ? '💳' : '🎁'} ${t.productName || ''}\n   💰 Rp ${formatNumber(t.amount)} | 📅 ${date} ${time}`;
    }).join('\n\n');

    const totalTransactions = userTransactions.length;
    const totalSpent = userTransactions.reduce((s, t) => s + (t.amount || 0), 0);

    const message = `
📊 <b>Riwayat Transaksi Terakhir</b>

${list}

<code>================================</code>
📈 <b>Statistik:</b>
├ Total Transaksi: <b>${totalTransactions}</b>
└ Total Pengeluaran: <b>Rp ${formatNumber(totalSpent)}</b>

<code>================================</code>
💡 <i>Menampilkan 10 transaksi terakhir</i>
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

async function handleFullRiwayat(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;
    const userId = from.id.toString();
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTransactions = transactions[userId] || [];

    if (userTransactions.length === 0) {
        if (cv) await answerCallbackQuery(env.BOT_TOKEN, cv.id, "❌ Tidak ada riwayat transaksi!", true);
        return;
    }

    const all = userTransactions.slice().reverse();
    const summary = all.map((t, idx) => {
        const date = new Date(t.timestamp).toLocaleDateString('id-ID');
        const amount = formatNumber(t.amount || 0);
        const type = t.type === 'purchase' ? '🛒 Beli' : t.type === 'deposit' ? '💳 Deposit' : t.type === 'bonus' ? '🎁 Bonus' : '💰 Cashback';
        const product = t.productName ? `- ${t.productName}` : '';
        return `${idx+1}. ${type} ${product}\n   💰 Rp ${amount} | 📅 ${date}`;
    }).join('\n\n');

    const totalSpent = userTransactions.reduce((s, t) => s + (t.amount || 0), 0);
    const message = `
📋 <b>Semua Riwayat Transaksi</b>

Total: <b>${userTransactions.length} transaksi</b>

${summary}

<code>================================</code>
💰 <b>Total Pengeluaran:</b> Rp ${formatNumber(totalSpent)}
    `;

    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali ke Riwayat", callback_data: "riwayat" }]] };

    await answerCallbackQuery(env.BOT_TOKEN, cv.id);
    return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
}

async function handleAchievements(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;
    const userId = from.id.toString();
    const users = await loadDB(env.BOT_DB, 'users');
    const userData = users[userId] || { achievements: {}, purchaseCount: 0, totalSpent: 0 };
    const rewardSettings = await loadRewardSettings(env.BOT_DB);

    if (!userData.achievements) {
        userData.achievements = { firstPurchase: false, fivePurchases: false, tenPurchases: false, bigSpender: false };
        userData.purchaseCount = 0;
        userData.totalSpent = 0;
    }

    const achievements = [
        { id: 'firstPurchase', title: 'Pembeli Pertama 🎯', description: 'Lakukan pembelian pertama', unlocked: userData.achievements.firstPurchase, reward: rewardSettings.achievementRewards.rewards.firstPurchase },
        { id: 'fivePurchases', title: 'Pelanggan Setia ⭐', description: 'Lakukan 5 pembelian', unlocked: userData.achievements.fivePurchases, progress: userData.purchaseCount || 0, target: 5, reward: rewardSettings.achievementRewards.rewards.fivePurchases },
        { id: 'tenPurchases', title: 'Pelanggan Premium 👑', description: 'Lakukan 10 pembelian', unlocked: userData.achievements.tenPurchases, progress: userData.purchaseCount || 0, target: 10, reward: rewardSettings.achievementRewards.rewards.tenPurchases },
        { id: 'bigSpender', title: 'Big Spender 💎', description: 'Habiskan total Rp 100.000', unlocked: userData.achievements.bigSpender, progress: userData.totalSpent || 0, target: 100000, reward: rewardSettings.achievementRewards.rewards.bigSpender }
    ];

    const unlockedCount = achievements.filter(a => a.unlocked).length;
    const totalRewards = achievements.filter(a => a.unlocked).reduce((s,a)=>s+(a.reward||0),0);

    const list = achievements.map(ach => {
        const status = ach.unlocked ? '✅' : '❌';
        const progress = ach.progress !== undefined ? ` (${ach.progress}/${ach.target})` : '';
        const rewardText = ach.unlocked ? `🎁 Rp ${formatNumber(ach.reward)}` : `💡 Reward: Rp ${formatNumber(ach.reward)}`;
        return `${status} <b>${ach.title}</b>\n   📝 ${ach.description}${progress}\n   ${rewardText}`;
    }).join('\n\n');

    const message = `
🏆 <b>Pencapaian Anda</b>

${list}

<code>================================</code>
📊 <b>Statistik:</b>
├ 🎯 Terbuka: <b>${unlockedCount}/${achievements.length}</b>
├ 🎁 Total Reward: <b>Rp ${formatNumber(totalRewards)}</b>
├ 🛒 Total Pembelian: <b>${userData.purchaseCount || 0}</b>
└ 💰 Total Pengeluaran: <b>Rp ${formatNumber(userData.totalSpent || 0)}</b>

<code>================================</code>
💡 <i>Lanjutkan transaksi untuk membuka achievement lainnya!</i>
    `;

    const keyboard = { inline_keyboard: [[{ text: "🛒 Lanjut Belanja", callback_data: "catalog" }, { text: "📊 Riwayat", callback_data: "riwayat" }], [{ text: "🔙 Kembali", callback_data: "back_to_main" }]] };

    await answerCallbackQuery(env.BOT_TOKEN, cv.id);
    return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
}

async function handleHelp(update, env) {
    const cv = update.callback_query;
    const from = cv ? cv.from : update.message.from;

    const message = `
ℹ️ <b>Pusat Bantuan</b>

<u>📖 Cara Menggunakan Bot:</u>
1. <b>Deposit:</b> Klik menu deposit → masukkan nominal → scan QRIS → konfirmasi
2. <b>Beli Akun:</b> Pilih produk → konfirmasi pembelian → dapatkan akun
3. <b>Cek Saldo:</b> Lihat di menu utama atau profile

<u>⚡ Fitur Utama:</u>
• 🛒 Beli akun premium otomatis
• 💳 Deposit instant
• 🏆 Achievement dan reward
• 📊 Riwayat transaksi lengkap

👨‍💼 <b>Admin Support:</b> ${env.ADMIN_USERNAME || "@admin"}
    `;

    const keyboard = {
        inline_keyboard: [
            [{ text: "💬 Chat Admin", url: `https://t.me/${(env.ADMIN_USERNAME || 'admin').replace('@','')}` }, { text: "🛒 Beli Akun", callback_data: "catalog" }],
            [{ text: "💳 Deposit", callback_data: "deposit" }, { text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };

    if (cv) {
        await answerCallbackQuery(env.BOT_TOKEN, cv.id);
        return await editMessageText(env.BOT_TOKEN, from.id, cv.message.message_id, message, keyboard);
    } else {
        return await sendTelegramMessage(env.BOT_TOKEN, from.id, message, keyboard);
    }
}

// -------------------- Admin/Management handlers (kept as earlier) --------------------
async function handleAdmin(update, env) {
    const msg = update.message;
    const user = msg.from;
    if (user.id.toString() !== env.ADMIN_ID) {
        return await sendTelegramMessage(env.BOT_TOKEN, user.id, `❌ <b>Akses Ditolak!</b>\n\nHanya admin yang dapat menggunakan perintah ini.`);
    }

    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const stats = await loadStatistics(env.BOT_DB);
    const totalMembers = Object.keys(users).length;
    const totalProducts = Object.keys(accounts).length;
    const totalRevenue = formatNumber(stats.totalRevenue || 0);
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyStats[today] || { transactions: 0, revenue: 0, users: 0 };

    const keyboard = {
        inline_keyboard: [
            [{ text: "💰 Kelola Saldo", callback_data: "admin_saldo" }, { text: "🛒 Kelola Produk", callback_data: "admin_produk" }],
            [{ text: "📊 Statistik", callback_data: "admin_stats" }, { text: "👥 Management User", callback_data: "admin_users" }],
            [{ text: "🎁 Reward Settings", callback_data: "admin_reward_settings" }, { text: "⚙️ Settings", callback_data: "admin_settings" }],
            [{ text: "🔔 Broadcast", callback_data: "admin_broadcast" }]
        ]
    };

    const adminMessage = `
👮 <b>Admin Dashboard</b>

┌─── 📈 <b>OVERVIEW</b> ───┐
│ 👥 Total Member: <code>${totalMembers}</code>
│ 🛒 Total Produk: <code>${totalProducts}</code>
│ 💰 Total Revenue: <code>Rp ${totalRevenue}</code>
│ 📊 Total Transaksi: <code>${stats.totalTransactions}</code>
└─────────────────────

┌─── 📅 <b>HARI INI</b> ───┐
│ 📊 Transaksi: <code>${todayStats.transactions}</code>
│ 💰 Revenue: <code>Rp ${formatNumber(todayStats.revenue)}</code>
│ 👥 User Baru: <code>${todayStats.users}</code>
└─────────────────────

🛠️ <b>Management Tools:</b>
Silakan pilih menu yang diinginkan:
    `;

    return await sendTelegramMessage(env.BOT_TOKEN, user.id, adminMessage, keyboard);
}

// Admin stats, users, produk, reward settings etc. are intentionally preserved from previous implementation.
// For brevity, here I'll route callbacks to functions named similarly to earlier code above.
// (You may reuse the earlier implementations for admin_stats, admin_users, admin_produk, admin_reward_settings, etc.)
// If you need modifications to admin screens, I can expand them further.


// -------------------- Router: receive incoming update --------------------
router.post('/', async (request, env) => {
    try {
        const update = await request.json();

        // determine update type
        if (update.message) {
            const message = update.message;
            // text commands
            const text = message.text || '';
            // /start
            if (text.startsWith('/start')) {
                return new Response(JSON.stringify(await handleStart({ message }, env)), { status: 200 });
            }
            // /admin command
            if (text.startsWith('/admin')) {
                return new Response(JSON.stringify(await handleAdmin({ message }, env)), { status: 200 });
            }
            // fallback: if user is in a session expecting numeric input for admin reward setting
            const userId = message.from.id.toString();
            const session = getUserSession(userId);
            if (session && session.action && session.action.startsWith('set_')) {
                // handle admin numeric inputs for reward settings
                // --- simplified handling: parse number and update setting accordingly ---
                const value = parseInt(text.replace(/\D/g,'')) || 0;
                if (value <= 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, message.from.id, '❌ Nominal tidak valid. Silakan kirim angka valid.');
                    return new Response('ok', { status: 200 });
                }
                const settings = await loadRewardSettings(env.BOT_DB);
                switch (session.action) {
                    case 'set_deposit_percentage':
                        settings.depositBonus.percentage = Math.min(100, Math.max(0, value));
                        break;
                    case 'set_deposit_min_amount':
                        settings.depositBonus.minAmount = value;
                        break;
                    case 'set_deposit_max_bonus':
                        settings.depositBonus.maxBonus = value;
                        break;
                    case 'set_purchase_cashback':
                        settings.purchaseBonus.cashback = Math.min(100, Math.max(0, value));
                        break;
                    case 'set_purchase_min_amount':
                        settings.purchaseBonus.minPurchase = value;
                        break;
                    case 'set_referrer_bonus':
                        settings.referralBonus.bonus = value;
                        break;
                    case 'set_referee_bonus':
                        settings.referralBonus.bonusReferee = value;
                        break;
                    case 'set_achievement_first':
                        settings.achievementRewards.rewards.firstPurchase = value;
                        break;
                    case 'set_achievement_five':
                        settings.achievementRewards.rewards.fivePurchases = value;
                        break;
                    case 'set_achievement_ten':
                        settings.achievementRewards.rewards.tenPurchases = value;
                        break;
                    case 'set_achievement_big':
                        settings.achievementRewards.rewards.bigSpender = value;
                        break;
                    default:
                        break;
                }
                await saveRewardSettings(env.BOT_DB, settings);
                clearUserSession(userId);
                await sendTelegramMessage(env.BOT_TOKEN, message.from.id, `✅ Pengaturan berhasil disimpan.`);
                return new Response('ok', { status: 200 });
            }

            // other text-based flows can be extended here...
            return new Response('ok', { status: 200 });
        }

        if (update.callback_query) {
            const cb = update.callback_query;
            const data = cb.data || '';

            // MAIN MENU
            if (data === 'catalog') return new Response(JSON.stringify(await handleCatalog({ callback_query: cb }, env)), { status: 200 });
            if (data.startsWith('catalog_select_')) {
                const idx = parseInt(data.split('_').pop());
                return new Response(JSON.stringify(await handleCatalogSelect({ callback_query: cb }, env, idx)), { status: 200 });
            }
            if (data === 'catalog_next') {
                // for simplicity, reuse catalog (pagination can be implemented)
                return new Response(JSON.stringify(await handleCatalog({ callback_query: cb }, env)), { status: 200 });
            }

            // qty controls
            if (data === 'qty_increase') return new Response(JSON.stringify(await handleQtyChange({ callback_query: cb }, env, +1)), { status: 200 });
            if (data === 'qty_decrease') return new Response(JSON.stringify(await handleQtyChange({ callback_query: cb }, env, -1)), { status: 200 });
            if (data === 'buy_all') return new Response(JSON.stringify(await handleBuyAll({ callback_query: cb }, env)), { status: 200 });
            if (data === 'purchase_confirm') return new Response(JSON.stringify(await handlePurchaseConfirm({ callback_query: cb }, env)), { status: 200 });

            // profile/riwayat/help/achievements
            if (data === 'profile') return new Response(JSON.stringify(await handleProfile({ callback_query: cb }, env)), { status: 200 });
            if (data === 'riwayat') return new Response(JSON.stringify(await handleRiwayat({ callback_query: cb }, env)), { status: 200 });
            if (data === 'full_riwayat') return new Response(JSON.stringify(await handleFullRiwayat({ callback_query: cb }, env)), { status: 200 });
            if (data === 'achievements') return new Response(JSON.stringify(await handleAchievements({ callback_query: cb }, env)), { status: 200 });
            if (data === 'help') return new Response(JSON.stringify(await handleHelp({ callback_query: cb }, env)), { status: 200 });

            // back navigation
            if (data === 'back_to_main') {
                // emulate start menu by editing text
                await answerCallbackQuery(env.BOT_TOKEN, cb.id);
                return new Response(JSON.stringify(await handleStart({ message: { from: cb.from } }, env)), { status: 200 });
            }

            // ADMIN CALLBACKS (prefix 'admin_'): keep routing to admin handlers; ensure admin checks inside each handler
            if (data.startsWith('admin_')) {
                // For conciseness, route to handleAdminStats / handleAdminUsers / handleAdminProduk / handleAdminSettings / handleAdminRewardSettings
                // Implementation of these handlers is included earlier or can be expanded similarly
                if (data === 'admin_stats') { return new Response(JSON.stringify(await handleAdminStats({ callback_query: cb }, env)), { status: 200 }); }
                if (data === 'admin_users') { return new Response(JSON.stringify(await handleAdminUsers({ callback_query: cb }, env)), { status: 200 }); }
                if (data === 'admin_produk') { return new Response(JSON.stringify(await handleAdminProduk({ callback_query: cb }, env)), { status: 200 }); }
                if (data === 'admin_settings') { return new Response(JSON.stringify(await handleAdminSettings({ callback_query: cb }, env)), { status: 200 }); }
                if (data === 'admin_reward_settings') { return new Response(JSON.stringify(await handleAdminRewardSettings({ callback_query: cb }, env)), { status: 200 }); }
                if (data === 'back_to_admin') { return new Response(JSON.stringify(await handleAdmin({ message: { from: cb.from } }, env)), { status: 200 }); }
            }

            // Reward toggles & setting flows
            if (data === 'reward_toggle_system') return new Response(JSON.stringify(await handleRewardToggleSystem({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_setting_deposit') return new Response(JSON.stringify(await handleRewardSettingDeposit({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_toggle_deposit') return new Response(JSON.stringify(await handleRewardToggleDeposit({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_deposit_percentage') return new Response(JSON.stringify(await handleRewardSetDepositPercentage({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_deposit_min') return new Response(JSON.stringify(await handleRewardSetDepositMin({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_deposit_max') return new Response(JSON.stringify(await handleRewardSetDepositMax({ callback_query: cb }, env)), { status: 200 });

            if (data === 'reward_setting_purchase') return new Response(JSON.stringify(await handleRewardSettingPurchase({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_toggle_purchase') return new Response(JSON.stringify(await handleRewardTogglePurchase({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_purchase_cashback') return new Response(JSON.stringify(await handleRewardSetPurchaseCashback({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_purchase_min') return new Response(JSON.stringify(await handleRewardSetPurchaseMin({ callback_query: cb }, env)), { status: 200 });

            if (data === 'reward_setting_referral') return new Response(JSON.stringify(await handleRewardSettingReferral({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_toggle_referral') return new Response(JSON.stringify(await handleRewardToggleReferral({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_referrer_bonus') return new Response(JSON.stringify(await handleRewardSetReferrerBonus({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_referee_bonus') return new Response(JSON.stringify(await handleRewardSetRefereeBonus({ callback_query: cb }, env)), { status: 200 });

            if (data === 'reward_setting_achievement') return new Response(JSON.stringify(await handleRewardSettingAchievement({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_toggle_achievement') return new Response(JSON.stringify(await handleRewardToggleAchievement({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_achievement_first') return new Response(JSON.stringify(await handleRewardSetAchievementFirst({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_achievement_five') return new Response(JSON.stringify(await handleRewardSetAchievementFive({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_achievement_ten') return new Response(JSON.stringify(await handleRewardSetAchievementTen({ callback_query: cb }, env)), { status: 200 });
            if (data === 'reward_set_achievement_big') return new Response(JSON.stringify(await handleRewardSetAchievementBig({ callback_query: cb }, env)), { status: 200 });

            // default fallback
            await answerCallbackQuery(env.BOT_TOKEN, cb.id, 'Perintah tidak dikenali.', true);
            return new Response('ok', { status: 200 });
        }

        return new Response('ok', { status: 200 });
    } catch (err) {
        console.error('error processing update', err);
        return new Response('error', { status: 500 });
    }
});

// -------------------- Admin sub-handlers referenced in router --------------------
// These functions mirror earlier content in your original code; included here so router calls succeed.
// If you want to refine admin UI too, tell me which screens to change.
async function handleAdminStats(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true);
        return;
    }
    const stats = await loadStatistics(env.BOT_DB);
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const pendingPayments = await loadPendingPayments(env.BOT_DB);
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyStats[today] || { transactions: 0, revenue: 0, users: 0 };

    const popularProducts = Object.entries(stats.popularProducts || {})
        .sort(([,a],[,b])=>b-a).slice(0,5)
        .map(([product,count], index) => {
            const medal = index === 0 ? '🥇' : index ===1 ? '🥈' : index ===2 ? '🥉' : '▫️';
            return `${medal} ${product}: ${count}x`;
        }).join('\n') || '▫️ Tidak ada data';

    const message = `
📊 <b>Statistik Lengkap</b>

┌─── 📈 <b>OVERVIEW</b> ───┐
│ 👥 Total Users: <code>${Object.keys(users).length}</code>
│ 🛒 Total Products: <code>${Object.keys(accounts).length}</code>
│ 📊 Total Transactions: <code>${stats.totalTransactions}</code>
│ 💰 Total Revenue: <code>Rp ${formatNumber(stats.totalRevenue)}</code>
│ ⏳ Pending Payments: <code>${Object.keys(pendingPayments).length}</code>
└─────────────────────

┌─── 📅 <b>HARI INI</b> ───┐
│ 📊 Transaksi: <code>${todayStats.transactions}</code>
│ 💰 Revenue: <code>Rp ${formatNumber(todayStats.revenue)}</code>
│ 👥 User Baru: <code>${todayStats.users}</code>
└─────────────────────

┌─── 🏆 <b>PRODUK POPULER</b> ───┐
${popularProducts}
└─────────────────────
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "admin_stats" }],[{ text: "🔙 Kembali", callback_data: "back_to_admin" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

async function handleAdminUsers(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true);
        return;
    }
    const users = await loadDB(env.BOT_DB, 'users');
    const totalUsers = Object.keys(users).length;
    const topUsers = Object.entries(users).sort(([,a],[,b])=>b.saldo - a.saldo).slice(0,5).map(([,u],idx)=>`${idx+1}. Rp ${formatNumber(u.saldo || 0)}`).join('\n') || '▫️ Tidak ada data';
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const activeUsers = Object.keys(transactions).length;
    const message = `
👥 <b>User Management</b>

┌─── 📊 <b>STATISTIK USER</b> ───┐
│ 👥 Total Users: <code>${totalUsers}</code>
│ 🔥 Active Users: <code>${activeUsers}</code>
│ 💤 Inactive Users: <code>${totalUsers - activeUsers}</code>
└─────────────────────

┌─── 💰 <b>TOP SALDO</b> ───┐
${topUsers}
└─────────────────────
    `;
    const keyboard = { inline_keyboard: [[{ text: "📋 List Users", callback_data: "admin_list_users" }],[{ text: "💰 Top Up Manual", callback_data: "admin_manual_topup" }],[{ text: "🔙 Kembali", callback_data: "back_to_admin" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

async function handleAdminProduk(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true);
        return;
    }
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const total = Object.keys(accounts).length;
    const message = `🛒 <b>Kelola Produk</b>\n\nTotal produk: <code>${total}</code>\n\nPilih aksi yang ingin dilakukan:`;
    const keyboard = { inline_keyboard: [[{ text: "➕ Tambah Produk", callback_data: "admin_tambah_akun" }, { text: "🗑️ Hapus Produk", callback_data: "admin_hapus_akun" }], [{ text: "📋 List Produk", callback_data: "admin_list_akun" }], [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

async function handleAdminSettings(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true);
        return;
    }
    const message = `⚙️ <b>Admin Settings</b>\n\nPengaturan sistem bot:`;
    const keyboard = { inline_keyboard: [[{ text: "🎁 Reward Settings", callback_data: "admin_reward_settings" }, { text: "🔄 Cleanup Data", callback_data: "admin_cleanup" }], [{ text: "📋 Pending Payments", callback_data: "admin_pending" }], [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

async function handleAdminRewardSettings(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true);
        return;
    }
    const settings = await loadRewardSettings(env.BOT_DB);
    const statusIcon = settings.enabled ? "✅" : "❌";
    const depositStatus = settings.depositBonus.enabled ? "✅" : "❌";
    const purchaseStatus = settings.purchaseBonus.enabled ? "✅" : "❌";
    const referralStatus = settings.referralBonus.enabled ? "✅" : "❌";
    const achievementStatus = settings.achievementRewards.enabled ? "✅" : "❌";

    const message = `
🎁 <b>Pengaturan Sistem Reward</b>

${statusIcon} <b>Status Sistem:</b> <code>${settings.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

┌─── 💰 <b>BONUS DEPOSIT</b> ───┐
│ ${depositStatus} <b>Status:</b> ${settings.depositBonus.enabled ? 'AKTIF' : 'NON-AKTIF'}
│ 📊 <b>Persentase:</b> <code>${settings.depositBonus.percentage}%</code>
│ 💵 <b>Minimal:</b> <code>Rp ${formatNumber(settings.depositBonus.minAmount)}</code>
│ 🎯 <b>Maksimal Bonus:</b> <code>Rp ${formatNumber(settings.depositBonus.maxBonus)}</code>
└─────────────────────

┌─── 🛒 <b>CASHBACK PEMBELIAN</b> ───┐
│ ${purchaseStatus} <b>Status:</b> ${settings.purchaseBonus.enabled ? 'AKTIF' : 'NON-AKTIF'}
│ 📊 <b>Cashback:</b> <code>${settings.purchaseBonus.cashback}%</code>
│ 💵 <b>Minimal Belanja:</b> <code>Rp ${formatNumber(settings.purchaseBonus.minPurchase)}</code>
└─────────────────────

┌─── 👥 <b>BONUS REFERRAL</b> ───┐
│ ${referralStatus} <b>Status:</b> ${settings.referralBonus.enabled ? 'AKTIF' : 'NON-AKTIF'}
│ 🤵 <b>Bonus Referrer:</b> <code>Rp ${formatNumber(settings.referralBonus.bonus)}</code>
│ 👤 <b>Bonus Referee:</b> <code>Rp ${formatNumber(settings.referralBonus.bonusReferee)}</code>
└─────────────────────

┌─── 🏆 <b>REWARD ACHIEVEMENT</b> ───┐
│ ${achievementStatus} <b>Status:</b> ${settings.achievementRewards.enabled ? 'AKTIF' : 'NON-AKTIF'}
│ 🎯 <b>First Purchase:</b> <code>Rp ${formatNumber(settings.achievementRewards.rewards.firstPurchase)}</code>
│ ⭐ <b>5 Purchases:</b> <code>Rp ${formatNumber(settings.achievementRewards.rewards.fivePurchases)}</code>
│ 👑 <b>10 Purchases:</b> <code>Rp ${formatNumber(settings.achievementRewards.rewards.tenPurchases)}</code>
│ 💎 <b>Big Spender:</b> <code>Rp ${formatNumber(settings.achievementRewards.rewards.bigSpender)}</code>
└─────────────────────
    `;

    const keyboard = {
        inline_keyboard: [
            [{ text: settings.enabled ? "❌ Nonaktifkan Sistem" : "✅ Aktifkan Sistem", callback_data: `reward_toggle_system` }],
            [{ text: "💰 Atur Bonus Deposit", callback_data: "reward_setting_deposit" }, { text: "🛒 Atur Cashback", callback_data: "reward_setting_purchase" }],
            [{ text: "👥 Atur Referral", callback_data: "reward_setting_referral" }, { text: "🏆 Atur Achievement", callback_data: "reward_setting_achievement" }],
            [{ text: "🔙 Kembali", callback_data: "admin_settings" }]
        ]
    };

    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

// Reward toggles and setter functions are already used in router earlier (handleRewardToggleSystem, handleRewardSettingDeposit, etc.)
// For completeness, ensure the following functions exist (they mirror earlier ones):
async function handleRewardToggleSystem(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.enabled = !settings.enabled;
    await saveRewardSettings(env.BOT_DB, settings);
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, `✅ Sistem reward ${settings.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    return await handleAdminRewardSettings(update, env);
}
async function handleRewardSettingDeposit(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    const deposit = settings.depositBonus;
    const message = `
💰 <b>Pengaturan Bonus Deposit</b>

Status: <code>${deposit.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih yang ingin diubah:
    `;
    const keyboard = { inline_keyboard: [[{ text: deposit.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", callback_data: "reward_toggle_deposit" }],[{ text: `📊 Persentase (${deposit.percentage}%)`, callback_data: "reward_set_deposit_percentage" },{ text: `💵 Minimal (Rp ${formatNumber(deposit.minAmount)})`, callback_data: "reward_set_deposit_min" }],[{ text: `🎯 Maksimal (Rp ${formatNumber(deposit.maxBonus)})`, callback_data: "reward_set_deposit_max" }],[{ text: "🔙 Kembali", callback_data: "admin_reward_settings" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardToggleDeposit(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.depositBonus.enabled = !settings.depositBonus.enabled;
    await saveRewardSettings(env.BOT_DB, settings);
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, `✅ Bonus deposit ${settings.depositBonus.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    return await handleRewardSettingDeposit(update, env);
}
async function handleRewardSetDepositPercentage(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_deposit_percentage', setting: 'deposit_percentage' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentPercentage = settings.depositBonus.percentage;
    const message = `
📊 <b>Atur Persentase Bonus Deposit</b>

Persentase saat ini: <code>${currentPercentage}%</code>

Silakan kirim persentase baru (1-100):
Contoh: <code>10</code> untuk 10%
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_deposit" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetDepositMin(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_deposit_min_amount', setting: 'deposit_min_amount' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentMin = settings.depositBonus.minAmount;
    const message = `
💵 <b>Atur Minimal Deposit untuk Bonus</b>

Minimal saat ini: <code>Rp ${formatNumber(currentMin)}</code>

Silakan kirim nominal minimal baru:
Contoh: <code>50000</code> untuk Rp 50.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_deposit" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetDepositMax(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_deposit_max_bonus', setting: 'deposit_max_bonus' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentMax = settings.depositBonus.maxBonus;
    const message = `
🎯 <b>Atur Maksimal Bonus Deposit</b>

Maksimal saat ini: <code>Rp ${formatNumber(currentMax)}</code>

Silakan kirim nominal maksimal bonus baru:
Contoh: <code>100000</code> untuk Rp 100.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_deposit" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

// Purchase cashback settings handlers
async function handleRewardSettingPurchase(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    const purchase = settings.purchaseBonus;
    const message = `
🛒 <b>Pengaturan Cashback Pembelian</b>

Status: <code>${purchase.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih yang ingin diubah:
    `;
    const keyboard = { inline_keyboard: [[{ text: purchase.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", callback_data: "reward_toggle_purchase" }],[{ text: `📊 Cashback (${purchase.cashback}%)`, callback_data: "reward_set_purchase_cashback" },{ text: `💵 Minimal (Rp ${formatNumber(purchase.minPurchase)})`, callback_data: "reward_set_purchase_min" }],[{ text: "🔙 Kembali", callback_data: "admin_reward_settings" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardTogglePurchase(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.purchaseBonus.enabled = !settings.purchaseBonus.enabled;
    await saveRewardSettings(env.BOT_DB, settings);
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, `✅ Cashback pembelian ${settings.purchaseBonus.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    return await handleRewardSettingPurchase(update, env);
}
async function handleRewardSetPurchaseCashback(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_purchase_cashback', setting: 'purchase_cashback' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentCashback = settings.purchaseBonus.cashback;
    const message = `
📊 <b>Atur Persentase Cashback Pembelian</b>

Cashback saat ini: <code>${currentCashback}%</code>

Silakan kirim persentase cashback baru (0-100):
Contoh: <code>5</code> untuk 5%
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_purchase" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetPurchaseMin(update, env) {
    const cb = update.callback_query;
    const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_purchase_min_amount', setting: 'purchase_min_amount' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentMin = settings.purchaseBonus.minPurchase;
    const message = `
💵 <b>Atur Minimal Pembelian untuk Cashback</b>

Minimal saat ini: <code>Rp ${formatNumber(currentMin)}</code>

Silakan kirim nominal minimal baru:
Contoh: <code>50000</code> untuk Rp 50.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_purchase" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

// Referral and achievement setters
async function handleRewardSettingReferral(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    const referral = settings.referralBonus;
    const message = `
👥 <b>Pengaturan Bonus Referral</b>

Status: <code>${referral.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih yang ingin diubah:
    `;
    const keyboard = { inline_keyboard: [[{ text: referral.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", callback_data: "reward_toggle_referral" }],[{ text: `🤵 Bonus Referrer (Rp ${formatNumber(referral.bonus)})`, callback_data: "reward_set_referrer_bonus" },{ text: `👤 Bonus Referee (Rp ${formatNumber(referral.bonusReferee)})`, callback_data: "reward_set_referee_bonus" }],[{ text: "🔙 Kembali", callback_data: "admin_reward_settings" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardToggleReferral(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.referralBonus.enabled = !settings.referralBonus.enabled;
    await saveRewardSettings(env.BOT_DB, settings);
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, `✅ Bonus referral ${settings.referralBonus.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    return await handleRewardSettingReferral(update, env);
}
async function handleRewardSetReferrerBonus(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_referrer_bonus', setting: 'referrer_bonus' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentBonus = settings.referralBonus.bonus;
    const message = `
🤵 <b>Atur Bonus untuk Referrer</b>

Bonus saat ini: <code>Rp ${formatNumber(currentBonus)}</code>

Silakan kirim nominal bonus baru untuk referrer:
Contoh: <code>15000</code> untuk Rp 15.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_referral" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetRefereeBonus(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_referee_bonus', setting: 'referee_bonus' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentBonus = settings.referralBonus.bonusReferee;
    const message = `
👤 <b>Atur Bonus untuk Referee</b>

Bonus saat ini: <code>Rp ${formatNumber(currentBonus)}</code>

Silakan kirim nominal bonus baru untuk referee:
Contoh: <code>10000</code> untuk Rp 10.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_referral" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

async function handleRewardSettingAchievement(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    const achievement = settings.achievementRewards;
    const message = `
🏆 <b>Pengaturan Reward Achievement</b>

Status: <code>${achievement.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih achievement yang ingin diubah reward-nya:
    `;
    const keyboard = {
        inline_keyboard: [
            [{ text: achievement.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", callback_data: "reward_toggle_achievement" }],
            [{ text: `🎯 First Purchase (Rp ${formatNumber(achievement.rewards.firstPurchase)})`, callback_data: "reward_set_achievement_first" }],
            [{ text: `⭐ 5 Purchases (Rp ${formatNumber(achievement.rewards.fivePurchases)})`, callback_data: "reward_set_achievement_five" }],
            [{ text: `👑 10 Purchases (Rp ${formatNumber(achievement.rewards.tenPurchases)})`, callback_data: "reward_set_achievement_ten" }],
            [{ text: `💎 Big Spender (Rp ${formatNumber(achievement.rewards.bigSpender)})`, callback_data: "reward_set_achievement_big" }],
            [{ text: "🔙 Kembali", callback_data: "admin_reward_settings" }]
        ]
    };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardToggleAchievement(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.achievementRewards.enabled = !settings.achievementRewards.enabled;
    await saveRewardSettings(env.BOT_DB, settings);
    await answerCallbackQuery(env.BOT_TOKEN, cb.id, `✅ Reward achievement ${settings.achievementRewards.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    return await handleRewardSettingAchievement(update, env);
}
async function handleRewardSetAchievementFirst(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_achievement_first', setting: 'achievement_first' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.firstPurchase;
    const message = `
🎯 <b>Atur Reward First Purchase</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:
Contoh: <code>5000</code> untuk Rp 5.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetAchievementFive(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_achievement_five', setting: 'achievement_five' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.fivePurchases;
    const message = `
⭐ <b>Atur Reward 5 Purchases</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:
Contoh: <code>10000</code> untuk Rp 10.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetAchievementTen(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_achievement_ten', setting: 'achievement_ten' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.tenPurchases;
    const message = `
👑 <b>Atur Reward 10 Purchases</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:
Contoh: <code>20000</code> untuk Rp 20.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}
async function handleRewardSetAchievementBig(update, env) {
    const cb = update.callback_query; const user = cb.from;
    if (user.id.toString() !== env.ADMIN_ID) { await answerCallbackQuery(env.BOT_TOKEN, cb.id, "❌ Akses ditolak!", true); return; }
    setUserSession(user.id, { action: 'set_achievement_big', setting: 'achievement_big' });
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.bigSpender;
    const message = `
💎 <b>Atur Reward Big Spender</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:
Contoh: <code>15000</code> untuk Rp 15.000
    `;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]] };
    await answerCallbackQuery(env.BOT_TOKEN, cb.id);
    return await editMessageText(env.BOT_TOKEN, user.id, cb.message.message_id, message, keyboard);
}

// -------------------- Entrypoint: GET for health check --------------------
router.get('/', () => new Response('OK - bot is running'));

// export default for Cloudflare Worker
export default {
    fetch: router.handle
};
