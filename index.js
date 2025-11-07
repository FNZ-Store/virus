import { Router } from 'itty-router';

const router = Router();

// ======================= UTILS & STATE =======================
const userSessions = new Map();

// Session helpers (in-memory; KV is authoritative for persistence)
function clearUserSession(userId) {
  userSessions.delete(userId.toString());
  console.log(`Session cleared for user ${userId}`);
}
function setUserSession(userId, sessionData) {
  userSessions.set(userId.toString(), { ...sessionData, timestamp: Date.now() });
  console.log(`Session set for user ${userId}:`, sessionData.action);
}
function getUserSession(userId) {
  const s = userSessions.get(userId.toString());
  if (!s) return null;
  if (Date.now() - s.timestamp > 30 * 60 * 1000) { // 30 minutes
    userSessions.delete(userId.toString());
    return null;
  }
  return s;
}

// ======================= KV HELPERS =======================
async function loadDB(binding, key) {
  try {
    const raw = await binding.get(key, 'json');
    return raw || {};
  } catch (err) {
    console.error('loadDB error', err);
    return {};
  }
}
async function saveDB(binding, data, key) {
  try {
    await binding.put(key, JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('saveDB error', err);
    return false;
  }
}

// Pending payment helpers (store map keyed by userId)
async function loadPendingPayments(binding) {
  try {
    const raw = await binding.get('pending_payments', 'json');
    return raw || {};
  } catch (err) {
    return {};
  }
}
async function savePendingPayment(binding, userId, paymentData) {
  try {
    const pend = await loadPendingPayments(binding);
    pend[userId.toString()] = {
      ...paymentData,
      // ensure timestamp string
      timestamp: (paymentData.timestamp instanceof Date) ? paymentData.timestamp.toISOString() : paymentData.timestamp
    };
    await binding.put('pending_payments', JSON.stringify(pend));
    return true;
  } catch (err) {
    console.error('savePendingPayment err', err);
    return false;
  }
}
async function removePendingPayment(binding, userId) {
  try {
    const pend = await loadPendingPayments(binding);
    if (pend[userId.toString()]) {
      delete pend[userId.toString()];
      await binding.put('pending_payments', JSON.stringify(pend));
    }
    return true;
  } catch (err) {
    console.error('removePendingPayment err', err);
    return false;
  }
}
async function getPendingPayment(binding, userId) {
  try {
    const pend = await loadPendingPayments(binding);
    const p = pend[userId.toString()];
    if (!p) return null;
    // convert timestamp back to Date
    return { ...p, timestamp: p.timestamp ? new Date(p.timestamp) : new Date() };
  } catch (err) {
    console.error('getPendingPayment err', err);
    return null;
  }
}

// ======================= STATISTICS & REWARDS =======================
async function loadStatistics(binding) {
  try {
    const raw = await binding.get('statistics', 'json');
    return raw || { totalTransactions: 0, totalRevenue: 0, totalUsers: 0, dailyStats: {}, popularProducts: {} };
  } catch (err) {
    return { totalTransactions: 0, totalRevenue: 0, totalUsers: 0, dailyStats: {}, popularProducts: {} };
  }
}
async function saveStatistics(binding, stats) {
  try {
    await binding.put('statistics', JSON.stringify(stats));
    return true;
  } catch (err) {
    console.error('saveStatistics err', err);
    return false;
  }
}
async function updateStatistics(binding, type, data = {}) {
  const stats = await loadStatistics(binding);
  const today = new Date().toISOString().slice(0, 10);
  if (!stats.dailyStats[today]) stats.dailyStats[today] = { transactions: 0, revenue: 0, users: 0 };

  switch (type) {
    case 'purchase':
      stats.totalTransactions++;
      stats.totalRevenue += (data.amount || 0);
      stats.dailyStats[today].transactions++;
      stats.dailyStats[today].revenue += (data.amount || 0);
      if (data.productName) {
        stats.popularProducts[data.productName] = (stats.popularProducts[data.productName] || 0) + 1;
      }
      break;
    case 'user_registered':
      stats.totalUsers++;
      stats.dailyStats[today].users++;
      break;
    case 'deposit':
      stats.totalRevenue += (data.amount || 0);
      stats.dailyStats[today].revenue += (data.amount || 0);
      break;
  }
  await saveStatistics(binding, stats);
}

// Reward settings stored in KV
async function loadRewardSettings(binding) {
  try {
    const raw = await binding.get('reward_settings', 'json');
    return raw || {
      enabled: true,
      depositBonus: { enabled: true, percentage: 5, minAmount: 10000, maxBonus: 50000 },
      purchaseBonus: { enabled: true, cashback: 2, minPurchase: 20000 },
      referralBonus: { enabled: true, bonus: 10000, bonusReferee: 5000 },
      achievementRewards: { enabled: true, rewards: { firstPurchase: 2000, fivePurchases: 5000, tenPurchases: 10000, bigSpender: 15000 } }
    };
  } catch (err) {
    return {
      enabled: true,
      depositBonus: { enabled: true, percentage: 5, minAmount: 10000, maxBonus: 50000 },
      purchaseBonus: { enabled: true, cashback: 2, minPurchase: 20000 },
      referralBonus: { enabled: true, bonus: 10000, bonusReferee: 5000 },
      achievementRewards: { enabled: true, rewards: { firstPurchase: 2000, fivePurchases: 5000, tenPurchases: 10000, bigSpender: 15000 } }
    };
  }
}
async function saveRewardSettings(binding, settings) {
  try {
    await binding.put('reward_settings', JSON.stringify(settings));
    return true;
  } catch (err) {
    console.error('saveRewardSettings err', err);
    return false;
  }
}

// ======================= TRANSACTIONS =======================
async function addTransaction(binding, userId, type, data) {
  const transactions = await loadDB(binding, 'transactions') || {};
  userId = userId.toString();
  if (!transactions[userId]) transactions[userId] = [];
  const tx = {
    id: generateTransactionId(),
    type,
    amount: data.amount || 0,
    productName: data.productName || '',
    timestamp: new Date().toISOString(),
    status: data.status || 'completed'
  };
  transactions[userId].push(tx);
  if (transactions[userId].length > 200) transactions[userId] = transactions[userId].slice(-200);
  await saveDB(binding, transactions, 'transactions');
  return tx.id;
}
function generateTransactionId() {
  return 'TX' + Date.now() + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ======================= UTILITIES =======================
function formatNumber(num) {
  if (typeof num !== 'number') num = parseInt(num) || 0;
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function getRandomAmount(env) {
  const min = parseInt(env.RANDOM_AMOUNT_MIN || 1);
  const max = parseInt(env.RANDOM_AMOUNT_MAX || 50);
  if (isNaN(min) || isNaN(max) || min > max) return 0;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ======================= TELEGRAM HELPERS =======================
async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (err) {
    console.error('sendTelegramMessage err', err);
    return null;
  }
}
async function sendTelegramPhoto(botToken, chatId, photoUrl, caption = '', replyMarkup = null, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (err) {
    console.error('sendTelegramPhoto err', err);
    return null;
  }
}
async function editMessageText(botToken, chatId, messageId, text, replyMarkup = null, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (err) { console.error('editMessageText err', err); return null; }
}
async function editMessageCaption(botToken, chatId, messageId, caption, replyMarkup = null, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${botToken}/editMessageCaption`;
  const payload = { chat_id: chatId, message_id: messageId, caption, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (err) { console.error('editMessageCaption err', err); return null; }
}
async function answerCallbackQuery(botToken, callbackQueryId, text = null, showAlert = false) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const payload = { callback_query_id: callbackQueryId };
  if (text) { payload.text = text; payload.show_alert = showAlert; }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await res.json();
  } catch (err) { console.error('answerCallbackQuery err', err); return null; }
}

// ======================= REWARD LOGIC =======================
async function calculateDepositBonus(env, nominal) {
  const settings = await loadRewardSettings(env.BOT_DB);
  if (!settings.enabled || !settings.depositBonus.enabled) return 0;
  if (nominal < settings.depositBonus.minAmount) return 0;
  let bonus = Math.floor(nominal * settings.depositBonus.percentage / 100);
  if (bonus > settings.depositBonus.maxBonus) bonus = settings.depositBonus.maxBonus;
  return bonus;
}
async function calculatePurchaseCashback(env, amount) {
  const settings = await loadRewardSettings(env.BOT_DB);
  if (!settings.enabled || !settings.purchaseBonus.enabled) return 0;
  if (amount < settings.purchaseBonus.minPurchase) return 0;
  return Math.floor(amount * settings.purchaseBonus.cashback / 100);
}
async function getAchievementReward(env, achievementId) {
  const settings = await loadRewardSettings(env.BOT_DB);
  if (!settings.enabled || !settings.achievementRewards.enabled) return 0;
  return settings.achievementRewards.rewards[achievementId] || 0;
}

// ======================= PROCESS DEPOSIT (CREDIT USER) =======================
async function processDepositWithBonus(env, userId, nominal, transactionId) {
  const users = await loadDB(env.BOT_DB, 'users');
  const uid = userId.toString();
  if (!users[uid]) users[uid] = { saldo: 0 };
  const bonus = await calculateDepositBonus(env, nominal);
  const total = nominal + bonus;
  users[uid].saldo = (users[uid].saldo || 0) + total;
  await saveDB(env.BOT_DB, users, 'users');

  await updateStatistics(env.BOT_DB, 'deposit', { amount: nominal });
  await addTransaction(env.BOT_DB, uid, 'deposit', { amount: nominal, productName: 'Deposit' });
  if (bonus > 0) {
    await addTransaction(env.BOT_DB, uid, 'bonus', { amount: bonus, productName: 'Bonus Deposit' });
  }
  return { nominal, bonus, totalCredit: total, newBalance: users[uid].saldo };
}

// ======================= CREATE QRIS (NEW API) =======================
// This function uses env.API_CREATE_URL and env.PAYMENT_API_KEY
async function createQrisAndConfirm(env, user, nominal) {
  const userId = user.id;
  const randomAddition = getRandomAmount(env);
  const finalAmount = nominal + randomAddition;

  try {
    // Build request: API expects amount & apikey as query params per your example
    const apiKey = env.PAYMENT_API_KEY || env.API_KEY || '';
    const url = `${env.API_CREATE_URL}?amount=${finalAmount}&apikey=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      throw new Error(`Gagal membuat QRIS (HTTP ${resp.status})`);
    }
    const json = await resp.json();
    if (!json || json.status !== 'success' || !json.data) {
      throw new Error('Response API tidak valid ketika membuat QRIS');
    }

    // The API returns qris_url, transaction_id, total_amount, fee, expired_minutes in data
    const qrisUrl = json.data.qris_url;
    const transactionId = json.data.transaction_id;
    const totalAmount = json.data.total_amount || finalAmount;
    const fee = json.data.fee || 0;
    const expiredMinutes = json.data.expired_minutes || 10;

    if (!qrisUrl || !transactionId) {
      throw new Error('QRIS atau transaction_id tidak ditemukan pada response API');
    }

    const paymentData = {
      nominal,
      finalNominal: totalAmount,
      transactionId,
      timestamp: new Date(),
      status: 'pending',
      messageId: null,
      expired_minutes: expiredMinutes,
      fee
    };

    // Save pending payment to KV
    await savePendingPayment(env.BOT_DB, userId.toString(), paymentData);

    // Keyboard for confirmation
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Konfirmasi Pembayaran', callback_data: `confirm_payment_${transactionId}` }],
        [{ text: '❌ Batalkan', callback_data: 'cancel_payment' }]
      ]
    };

    const caption = `💳 <b>Silakan Scan QRIS untuk Deposit</b>\n\n` +
      `💰 Nominal: Rp ${formatNumber(nominal)}\n` +
      `➕ Fee Random: Rp ${formatNumber(randomAddition)}\n` +
      `🔢 Total Bayar: <b>Rp ${formatNumber(totalAmount)}</b>\n\n` +
      `⌛ Berlaku ±${expiredMinutes} Menit\n\n` +
      `<i>ID Transaksi: ${transactionId}</i>`;

    // Send photo
    const sent = await sendTelegramPhoto(env.BOT_TOKEN, userId, qrisUrl, caption, keyboard);
    if (sent && sent.ok && sent.result && sent.result.message_id) {
      paymentData.messageId = sent.result.message_id;
      await savePendingPayment(env.BOT_DB, userId.toString(), paymentData);
    }

    // Add pending transaction record (optional for admin view)
    await addTransaction(env.BOT_DB, userId.toString(), 'deposit_pending', { amount: nominal, productName: 'Deposit' });

    // Notify admin
    const adminMsg = `⏳ Pembayaran pending dari user <code>${userId}</code>\nNominal: Rp ${formatNumber(nominal)}\nTotal bayar: Rp ${formatNumber(totalAmount)}\nID Transaksi: <code>${transactionId}</code>`;
    if (env.ADMIN_ID) {
      await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, adminMsg);
    }
  } catch (err) {
    console.error('createQrisAndConfirm error', err);
    await sendTelegramMessage(env.BOT_TOKEN, userId, `❌ Error membuat QRIS: ${err.message}`);
  }
}

// ======================= CHECK PAYMENT (NEW API) =======================
// Called when user taps Confirm. Uses env.API_CHECK_PAYMENT & env.PAYMENT_API_KEY
async function handleConfirmPayment(update, env) {
  const callbackQuery = update.callback_query;
  const user = callbackQuery.from;
  const userId = user.id.toString();
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id); // immediate ack

  const pending = await getPendingPayment(env.BOT_DB, userId);
  if (!pending) {
    return await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, '❌ Tidak ada pembayaran pending', true);
  }

  try {
    const apiKey = env.PAYMENT_API_KEY || env.API_KEY || '';
    const url = `${env.API_CHECK_PAYMENT}?transaction_id=${encodeURIComponent(pending.transactionId)}&apikey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const json = await resp.json();

    // API returns { paid: true, status: "success" } when paid
    if (json && json.paid === true) {
      // process deposit
      const result = await processDepositWithBonus(env, userId, pending.nominal, pending.transactionId);
      // remove pending
      await removePendingPayment(env.BOT_DB, userId);
      // update user: notify
      await sendTelegramMessage(env.BOT_TOKEN, userId, `✅ Pembayaran terkonfirmasi!\n\n💰 Nominal: Rp ${formatNumber(pending.nominal)}\n🎁 Bonus: Rp ${formatNumber(result.bonus)}\n💳 Total masuk: Rp ${formatNumber(result.totalCredit)}\n\nSaldo baru: Rp ${formatNumber(result.newBalance)}`);
      // notify admin
      if (env.ADMIN_ID) {
        await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, `✅ Deposit sukses\nUser: <code>${userId}</code>\nNominal: Rp ${formatNumber(pending.nominal)}\nTransaction ID: <code>${pending.transactionId}</code>`);
      }
      return;
    } else {
      return await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, '⏳ Pembayaran belum terdeteksi. Pastikan anda sudah membayar.', true);
    }
  } catch (err) {
    console.error('handleConfirmPayment err', err);
    return await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, `❌ Terjadi kesalahan: ${err.message}`, true);
  }
}

// ======================= CANCEL PAYMENT =======================
async function handleCancelPayment(update, env) {
  const callbackQuery = update.callback_query;
  const user = callbackQuery.from;
  const userId = user.id.toString();
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
  const pending = await getPendingPayment(env.BOT_DB, userId);
  if (!pending) {
    return await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, '❌ Tidak ada pembayaran pending', true);
  }
  await removePendingPayment(env.BOT_DB, userId);
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, '✅ Pembayaran dibatalkan', true);
  await sendTelegramMessage(env.BOT_TOKEN, userId, '❗ Pembayaran anda berhasil dibatalkan.');
}

// ======================= TELEGRAM COMMAND HANDLERS (UI) =======================
async function handleStart(update, env) {
  const user = update.message.from;
  const userId = user.id.toString();
  clearUserSession(userId);

  const users = await loadDB(env.BOT_DB, 'users');
  const accounts = await loadDB(env.BOT_DB, 'accounts');
  if (!users[userId]) {
    users[userId] = { saldo: 0, joinDate: new Date().toISOString(), purchaseCount: 0, totalSpent: 0 };
    await saveDB(env.BOT_DB, users, 'users');
    await updateStatistics(env.BOT_DB, 'user_registered', {});
  }
  const saldo = users[userId].saldo || 0;
  const formattedSaldo = formatNumber(saldo);
  const stok = Object.keys(accounts).length;
  const adminUsername = env.ADMIN_USERNAME || '@admin';

  const message = `🎊 <b>Selamat Datang di Bot Premium Store!</b>\n\n` +
    `👤 <b>User ID:</b> <code>${userId}</code>\n` +
    `💰 <b>Saldo:</b> Rp ${formattedSaldo}\n` +
    `📦 <b>Stok:</b> ${stok} produk\n\n` +
    `Pilih menu di bawah:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Beli Akun', callback_data: 'beli_akun' }, { text: '💳 Deposit', callback_data: 'deposit' }],
      [{ text: '📊 Riwayat', callback_data: 'riwayat' }, { text: '🏆 Pencapaian', callback_data: 'achievements' }],
      [{ text: 'ℹ️ Bantuan', callback_data: 'help' }, { text: '👤 Profile', callback_data: 'profile' }]
    ]
  };

  return await sendTelegramMessage(env.BOT_TOKEN, user.id, message, keyboard);
}

async function handleProfile(update, env) {
  const callbackQuery = update.callback_query;
  const user = callbackQuery.from;
  const uid = user.id.toString();
  const users = await loadDB(env.BOT_DB, 'users');
  const accounts = await loadDB(env.BOT_DB, 'accounts');
  const userData = users[uid] || { saldo: 0, joinDate: new Date().toISOString(), purchaseCount: 0, totalSpent: 0 };
  const formattedSaldo = formatNumber(userData.saldo || 0);
  const joinDate = new Date(userData.joinDate).toLocaleDateString('id-ID');

  const message = `👤 <b>Profile</b>\n\n` +
    `🆔 <code>${uid}</code>\n` +
    `📅 Bergabung: ${joinDate}\n` +
    `💰 Saldo: Rp ${formattedSaldo}\n` +
    `🛒 Pembelian: ${userData.purchaseCount || 0}\n` +
    `💸 Total Pengeluaran: Rp ${formatNumber(userData.totalSpent || 0)}\n`;

  const keyboard = { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] };
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
  return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// Riwayat (last 10)
async function handleRiwayat(update, env) {
  const callbackQuery = update.callback_query;
  const uid = callbackQuery.from.id.toString();
  const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
  const userTx = transactions[uid] || [];
  if (userTx.length === 0) {
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, uid, callbackQuery.message.message_id, `📊 <b>Riwayat Transaksi</b>\n\nBelum ada transaksi.`, { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] });
  }
  const recent = userTx.slice(-10).reverse();
  const list = recent.map((t, i) => {
    const date = new Date(t.timestamp).toLocaleDateString('id-ID');
    const time = new Date(t.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const type = t.type === 'purchase' ? '🛒' : t.type === 'deposit' ? '💳' : t.type === 'bonus' ? '🎁' : '📊';
    return `${i + 1}. ${type} ${t.productName ? '- ' + t.productName : ''}\n   💰 Rp ${formatNumber(t.amount)} | ${date} ${time}`;
  }).join('\n\n');

  const message = `📊 <b>Riwayat Terakhir</b>\n\n${list}`;
  const keyboard = { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'riwayat' }, { text: '📋 Semua Riwayat', callback_data: 'full_riwayat' }], [{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] };
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
  return await editMessageText(env.BOT_TOKEN, uid, callbackQuery.message.message_id, message, keyboard);
}

async function handleFullRiwayat(update, env) {
  const callbackQuery = update.callback_query;
  const uid = callbackQuery.from.id.toString();
  const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
  const userTx = transactions[uid] || [];
  if (userTx.length === 0) {
    return await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, '❌ Tidak ada riwayat transaksi', true);
  }
  const all = userTx.slice().reverse();
  const list = all.map((t, i) => {
    const date = new Date(t.timestamp).toLocaleDateString('id-ID');
    return `${i + 1}. ${t.type} ${t.productName ? '- ' + t.productName : ''}\n   💰 Rp ${formatNumber(t.amount)} | ${date}`;
  }).join('\n\n');

  const message = `📋 <b>Semua Riwayat</b>\n\nTotal: ${userTx.length} transaksi\n\n${list}`;
  const keyboard = { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'riwayat' }]] };
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
  return await editMessageText(env.BOT_TOKEN, uid, callbackQuery.message.message_id, message, keyboard);
}

// Achievements
async function handleAchievements(update, env) {
  const callbackQuery = update.callback_query;
  const uid = callbackQuery.from.id.toString();
  const users = await loadDB(env.BOT_DB, 'users');
  const user = users[uid] || { achievements: {}, purchaseCount: 0, totalSpent: 0 };
  const rewardSettings = await loadRewardSettings(env.BOT_DB);

  const achievements = [
    { id: 'firstPurchase', title: 'Pembeli Pertama', unlocked: user.achievements?.firstPurchase || false, reward: rewardSettings.achievementRewards.rewards.firstPurchase || 0 },
    { id: 'fivePurchases', title: '5 Pembelian', unlocked: user.achievements?.fivePurchases || false, progress: user.purchaseCount || 0, target: 5, reward: rewardSettings.achievementRewards.rewards.fivePurchases || 0 },
    { id: 'tenPurchases', title: '10 Pembelian', unlocked: user.achievements?.tenPurchases || false, progress: user.purchaseCount || 0, target: 10, reward: rewardSettings.achievementRewards.rewards.tenPurchases || 0 },
    { id: 'bigSpender', title: 'Big Spender', unlocked: user.achievements?.bigSpender || false, progress: user.totalSpent || 0, target: 100000, reward: rewardSettings.achievementRewards.rewards.bigSpender || 0 }
  ];

  const list = achievements.map(a => {
    const status = a.unlocked ? '✅' : '❌';
    const progress = a.progress !== undefined ? ` (${a.progress}/${a.target || '-'})` : '';
    return `${status} <b>${a.title}</b>\n   🎁 Rp ${formatNumber(a.reward)}${progress}`;
  }).join('\n\n');

  const message = `🏆 <b>Pencapaian</b>\n\n${list}`;
  const keyboard = { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] };
  await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
  return await editMessageText(env.BOT_TOKEN, uid, callbackQuery.message.message_id, message, keyboard);
}

// ======================= DEPOSIT FLOW (USER INPUT) =======================
async function handleDepositInput(update, env) {
  // Called when user sends a text after choosing deposit menu
  // In your original system there was session for deposit flow; we emulate here.
  try {
    const user = update.message.from;
    const text = update.message.text.trim().replace(/\./g, '');
    const nominal = parseInt(text);
    if (isNaN(nominal) || nominal < parseInt(env.MIN_AMOUNT || '1000')) {
      return await sendTelegramMessage(env.BOT_TOKEN, user.id, `⚠️ Nominal tidak valid. Minimal Rp ${formatNumber(env.MIN_AMOUNT || 1000)}`);
    }
    // create qris and send
    await createQrisAndConfirm(env, user, nominal);
  } catch (err) {
    console.error('handleDepositInput err', err);
    if (update.message && update.message.from) {
      await sendTelegramMessage(env.BOT_TOKEN, update.message.from.id, `❌ Terjadi error: ${err.message}`);
    }
  }
}

// ======================= CALLBACKS ROUTING =======================
async function handleCallbackQuery(update, env) {
  const cq = update.callback_query;
  const data = cq.data || '';
  // Examples: confirm_payment_{txid}, cancel_payment, deposit, beli_akun, riwayat, profile, achievements, help, back_to_main, admin_*
  if (data.startsWith('confirm_payment_')) {
    return await handleConfirmPayment(update, env);
  }
  if (data === 'cancel_payment') {
    return await handleCancelPayment(update, env);
  }
  // simple UI callbacks
  if (data === 'deposit') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
    // Ask user for nominal
    setUserSession(cq.from.id, { action: 'await_deposit_nominal' });
    const message = `💳 <b>Deposit</b>\n\nSilakan kirim nominal yang ingin Anda deposit (angka saja).\nContoh: <code>10000</code>\nMinimal: Rp ${formatNumber(env.MIN_AMOUNT || 1000)}`;
    return await editMessageText(env.BOT_TOKEN, cq.from.id, cq.message.message_id, message, { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] });
  }
  if (data === 'beli_akun') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
    // Show product list (simplified)
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const keys = Object.keys(accounts);
    if (keys.length === 0) {
      return await editMessageText(env.BOT_TOKEN, cq.from.id, cq.message.message_id, '🛒 Tidak ada produk tersedia saat ini.', { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] });
    }
    // Build short list
    const list = keys.slice(0, 10).map((k, i) => `${i + 1}. ${accounts[k].name} - Rp ${formatNumber(accounts[k].price)}`).join('\n');
    const message = `🛒 <b>Produk Tersedia</b>\n\n${list}\n\nKetik nomor produk untuk membeli.`;
    setUserSession(cq.from.id, { action: 'beli_akun', step: 'choose' });
    return await editMessageText(env.BOT_TOKEN, cq.from.id, cq.message.message_id, message, { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_main' }]] });
  }
  if (data === 'riwayat') return await handleRiwayat(update, env);
  if (data === 'full_riwayat') return await handleFullRiwayat(update, env);
  if (data === 'profile') return await handleProfile(update, env);
  if (data === 'achievements') return await handleAchievements(update, env);
  if (data === 'help') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
    const message = `ℹ️ <b>Pusat Bantuan</b>\n\n• Untuk deposit: pilih Deposit → masukkan nominal → scan QRIS → konfirmasi.\n• Hubungi admin: ${env.ADMIN_USERNAME || '@admin'}`;
    return await editMessageText(env.BOT_TOKEN, cq.from.id, cq.message.message_id, message, { inline_keyboard: [[{ text: '💳 Deposit', callback_data: 'deposit' }, { text: '🔙 Kembali', callback_data: 'back_to_main' }]] });
  }
  if (data === 'back_to_main' || data === 'back_to_admin') {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
    // Simulate /start main menu
    return await handleStart({ message: { from: cq.from } }, env);
  }

  // Admin actions (some examples)
  if (data === 'admin_stats') return await handleAdminStats(update, env);
  if (data === 'admin_users') return await handleAdminUsers(update, env);
  if (data === 'admin_produk') return await handleAdminProduk(update, env);
  if (data === 'admin_saldo') return await handleAdminSaldo(update, env);
  if (data === 'admin_reward_settings') return await handleAdminRewardSettings(update, env);
  if (data === 'reward_toggle_system') return await handleRewardToggleSystem(update, env);
  if (data === 'reward_setting_deposit') return await handleRewardSettingDeposit(update, env);
  if (data === 'reward_toggle_deposit') return await handleRewardToggleDeposit(update, env);
  // ... more admin callbacks implemented below (or can be expanded)

  // default
  await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❗ Fitur belum tersedia.', true);
}

// ======================= ADMIN HANDLERS (SAMPLE / essential) =======================
async function handleAdmin(update, env) {
  const msg = update.message;
  const user = msg.from;
  if (user.id.toString() !== env.ADMIN_ID) return await sendTelegramMessage(env.BOT_TOKEN, user.id, '❌ Akses ditolak!');

  const users = await loadDB(env.BOT_DB, 'users');
  const accounts = await loadDB(env.BOT_DB, 'accounts');
  const stats = await loadStatistics(env.BOT_DB);
  const message = `👮 <b>Admin Dashboard</b>\n\nTotal Users: ${Object.keys(users).length}\nTotal Produk: ${Object.keys(accounts).length}\nTotal Transactions: ${stats.totalTransactions}\nTotal Revenue: Rp ${formatNumber(stats.totalRevenue)}`;
  const keyboard = { inline_keyboard: [[{ text: '📊 Statistik', callback_data: 'admin_stats' }, { text: '🛒 Produk', callback_data: 'admin_produk' }], [{ text: '🔔 Broadcast', callback_data: 'admin_broadcast' }]] };
  return await sendTelegramMessage(env.BOT_TOKEN, user.id, message, keyboard);
}

async function handleAdminStats(update, env) {
  const cq = update.callback_query;
  const user = cq ? cq.from : update.message.from;
  if (user.id.toString() !== env.ADMIN_ID) return await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❌ Akses ditolak', true);
  const stats = await loadStatistics(env.BOT_DB);
  const message = `📊 Statistik\n\nTotal Transaksi: ${stats.totalTransactions}\nTotal Revenue: Rp ${formatNumber(stats.totalRevenue)}`;
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  return await editMessageText(env.BOT_TOKEN, user.id, cq.message.message_id, message, { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'admin_stats' }, { text: '🔙 Kembali', callback_data: 'back_to_admin' }]] });
}

async function handleAdminUsers(update, env) {
  const cq = update.callback_query;
  const user = cq ? cq.from : update.message.from;
  if (user.id.toString() !== env.ADMIN_ID) return await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❌ Akses ditolak', true);
  const users = await loadDB(env.BOT_DB, 'users');
  const total = Object.keys(users).length;
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  return await editMessageText(env.BOT_TOKEN, user.id, cq.message.message_id, `👥 Total Users: ${total}`, { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_admin' }]] });
}

async function handleAdminProduk(update, env) {
  const cq = update.callback_query;
  const user = cq ? cq.from : update.message.from;
  if (user.id.toString() !== env.ADMIN_ID) return await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❌ Akses ditolak', true);
  const accounts = await loadDB(env.BOT_DB, 'accounts');
  const list = Object.values(accounts).slice(0, 20).map(a => `${a.name} - Rp ${formatNumber(a.price)}`).join('\n') || 'Tidak ada produk';
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  return await editMessageText(env.BOT_TOKEN, user.id, cq.message.message_id, `🛒 Produk:\n\n${list}`, { inline_keyboard: [[{ text: '➕ Tambah Produk', callback_data: 'admin_tambah_akun' }, { text: '🗑 Hapus Produk', callback_data: 'admin_hapus_akun' }], [{ text: '🔙 Kembali', callback_data: 'back_to_admin' }]] });
}

async function handleAdminSaldo(update, env) {
  const cq = update.callback_query;
  const user = cq ? cq.from : update.message.from;
  if (user.id.toString() !== env.ADMIN_ID) return await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❌ Akses ditolak', true);
  const message = `💰 Kelola Saldo\n\nKetik: /topup <userId> <amount>`;
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  return await editMessageText(env.BOT_TOKEN, user.id, cq.message.message_id, message, { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_admin' }]] });
}

// Reward settings admin (some handlers)
async function handleAdminRewardSettings(update, env) {
  const cq = update.callback_query;
  const user = cq ? cq.from : update.message.from;
  if (user.id.toString() !== env.ADMIN_ID) return await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❌ Akses ditolak', true);
  const settings = await loadRewardSettings(env.BOT_DB);
  const message = `🎁 Reward Settings\n\nSystem: ${settings.enabled ? 'ON' : 'OFF'}\nDeposit Bonus: ${settings.depositBonus.enabled ? 'ON' : 'OFF'} (${settings.depositBonus.percentage}%)`;
  await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  return await editMessageText(env.BOT_TOKEN, user.id, cq.message.message_id, message, { inline_keyboard: [[{ text: settings.enabled ? '❌ Nonaktifkan' : '✅ Aktifkan', callback_data: 'reward_toggle_system' }, { text: '🔙 Kembali', callback_data: 'admin_settings' }]] });
}
async function handleRewardToggleSystem(update, env) {
  const cq = update.callback_query;
  const user = cq.from;
  if (user.id.toString() !== env.ADMIN_ID) return await answerCallbackQuery(env.BOT_TOKEN, cq.id, '❌ Akses ditolak', true);
  const settings = await loadRewardSettings(env.BOT_DB);
  settings.enabled = !settings.enabled;
  await saveRewardSettings(env.BOT_DB, settings);
  await answerCallbackQuery(env.BOT_TOKEN, cq.id, `✅ Sistem reward ${settings.enabled ? 'diaktifkan' : 'dinonaktifkan'}`, true);
  return await handleAdminRewardSettings(update, env);
}
// More admin reward handlers (toggle deposit, set percentage etc) can be added similarly.

// ======================= WEBHOOK / REQUEST HANDLER =======================
router.post('/webhook', async (request, env) => {
  try {
    const update = await request.json();

    // Determine type: message, callback_query, etc.
    if (update.message) {
      // Text message
      const text = update.message.text || '';
      const chatId = update.message.chat && update.message.chat.id;
      const from = update.message.from;
      // check commands
      if (text === '/start') {
        await handleStart(update, env);
        return new Response('ok', { status: 200 });
      }
      if (text && text.startsWith('/admin')) {
        await handleAdmin(update, env);
        return new Response('ok', { status: 200 });
      }
      // session-based flows (deposit nominal, buying steps, admin settings)
      const session = getUserSession(from.id);
      if (session && session.action === 'await_deposit_nominal') {
        // treat message as nominal
        await handleDepositInput(update, env);
        clearUserSession(from.id);
        return new Response('ok', { status: 200 });
      }
      if (session && session.action === 'beli_akun' && session.step === 'choose') {
        // handle buying input: user sends a number or product key
        const accounts = await loadDB(env.BOT_DB, 'accounts');
        const keys = Object.keys(accounts);
        const idx = parseInt(text);
        if (!isNaN(idx) && idx >= 1 && idx <= keys.length) {
          const key = keys[idx - 1];
          const product = accounts[key];
          // perform purchase flow (deduct saldo etc)
          const users = await loadDB(env.BOT_DB, 'users');
          const uid = from.id.toString();
          const price = parseInt(product.price || 0);
          if ((users[uid] && users[uid].saldo >= price) || from.id.toString() === env.ADMIN_ID) {
            // complete purchase
            const result = await processPurchaseWithCashback(env, uid, product.name, price);
            // remove product (one-time) or keep (depends on product)
            delete accounts[key];
            await saveDB(env.BOT_DB, accounts, 'accounts');
            await sendTelegramMessage(env.BOT_TOKEN, from.id, `✅ Pembelian sukses!\nProduk: ${product.name}\nHarga: Rp ${formatNumber(price)}\nSaldo baru: Rp ${formatNumber(result.newBalance)}`);
            clearUserSession(from.id);
          } else {
            await sendTelegramMessage(env.BOT_TOKEN, from.id, `❌ Saldo tidak mencukupi. Harga: Rp ${formatNumber(price)}`);
          }
        } else {
          await sendTelegramMessage(env.BOT_TOKEN, from.id, '❗ Pilihan tidak valid.');
        }
        clearUserSession(from.id);
        return new Response('ok', { status: 200 });
      }

      // fallback for plain messages: ignore or reply
      return new Response('ok', { status: 200 });
    }

    if (update.callback_query) {
      await handleCallbackQuery(update, env);
      return new Response('ok', { status: 200 });
    }

    // Other update types...
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('webhook handler err', err);
    return new Response('error', { status: 500 });
  }
});

// Optional: healthcheck
router.get('/', () => new Response('Telegram bot worker running', { status: 200 }));

// Export default for Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    // attach env to route handlers
    if (request.method === 'POST' && new URL(request.url).pathname === '/webhook') {
      return router.handle(request, env);
    }
    // allow GET /
    return router.handle(request, env);
  }
};

// ======================= ADDITIONAL: Purchase processing (cashback & achievements) =======================
async function processPurchaseWithCashback(env, userId, productName, amount) {
  const users = await loadDB(env.BOT_DB, 'users');
  const uid = userId.toString();
  if (!users[uid]) users[uid] = { saldo: 0, purchaseCount: 0, totalSpent: 0 };
  users[uid].saldo = (users[uid].saldo || 0) - amount;

  // cashback
  const cashback = await calculatePurchaseCashback(env, amount);
  if (cashback > 0) users[uid].saldo += cashback;

  // update stats and tx
  await saveDB(env.BOT_DB, users, 'users');
  await updateStatistics(env.BOT_DB, 'purchase', { amount, productName });
  await addTransaction(env.BOT_DB, uid, 'purchase', { amount, productName });
  if (cashback > 0) await addTransaction(env.BOT_DB, uid, 'cashback', { amount: cashback, productName: 'Cashback Pembelian' });

  // achievement tracking
  await checkAchievements(env, uid, 'purchase', { amount });

  return { amount, cashback, newBalance: users[uid].saldo };
}

async function checkAchievements(env, userId, action, data = {}) {
  const users = await loadDB(env.BOT_DB, 'users');
  const uid = userId.toString();
  if (!users[uid]) users[uid] = { saldo: 0, achievements: {}, purchaseCount: 0, totalSpent: 0 };
  const user = users[uid];
  if (!user.achievements) user.achievements = {};
  if (action === 'purchase') {
    user.purchaseCount = (user.purchaseCount || 0) + 1;
    user.totalSpent = (user.totalSpent || 0) + (data.amount || 0);

    const settings = await loadRewardSettings(env.BOT_DB);
    const rewards = settings.achievementRewards.rewards || {};

    let unlocked = null;
    if (!user.achievements.firstPurchase) {
      user.achievements.firstPurchase = true;
      unlocked = { title: 'Pembeli Pertama', reward: rewards.firstPurchase || 0 };
    } else if (user.purchaseCount >= 5 && !user.achievements.fivePurchases) {
      user.achievements.fivePurchases = true;
      unlocked = { title: 'Pelanggan Setia (5)', reward: rewards.fivePurchases || 0 };
    } else if (user.purchaseCount >= 10 && !user.achievements.tenPurchases) {
      user.achievements.tenPurchases = true;
      unlocked = { title: 'Pelanggan Premium (10)', reward: rewards.tenPurchases || 0 };
    }
    if (user.totalSpent >= 100000 && !user.achievements.bigSpender) {
      user.achievements.bigSpender = true;
      unlocked = { title: 'Big Spender', reward: rewards.bigSpender || 0 };
    }

    if (unlocked && settings.enabled && settings.achievementRewards.enabled) {
      user.saldo = (user.saldo || 0) + (unlocked.reward || 0);
      await saveDB(env.BOT_DB, users, 'users');
      await sendTelegramMessage(env.BOT_TOKEN, parseInt(uid), `🏆 <b>Pencapaian Terbuka!</b>\n\n<b>${unlocked.title}</b>\n🎁 Rp ${formatNumber(unlocked.reward)}\nSaldo baru: Rp ${formatNumber(user.saldo)}`);
      await addTransaction(env.BOT_DB, uid, 'bonus', { amount: unlocked.reward || 0, productName: `Achievement ${unlocked.title}` });
    }
  }
  await saveDB(env.BOT_DB, users, 'users');
}
