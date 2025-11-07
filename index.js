import { Router } from 'itty-router';

const router = Router();

// In-memory storage untuk sessions (sementara)
const userSessions = new Map();

// ==================== STATE MANAGEMENT FUNCTIONS ====================
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
        // Auto-cleanup session yang expired (30 menit)
        const sessionAge = Date.now() - session.timestamp;
        if (sessionAge > 30 * 60 * 1000) {
            clearUserSession(userId);
            return null;
        }
    }
    return session;
}

// Helper functions untuk KV storage
async function loadDB(binding, dbType) {
    try {
        const data = await binding.get(dbType, 'json');
        return data || {};
    } catch (error) {
        return {};
    }
}

async function saveDB(binding, data, dbType) {
    try {
        await binding.put(dbType, JSON.stringify(data));
        return true;
    } catch (error) {
        console.error('Error saving to KV:', error);
        return false;
    }
}

// Helper functions untuk pending payments
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
        const pendingPayments = await loadPendingPayments(binding);
        pendingPayments[userId] = {
            ...paymentData,
            timestamp: paymentData.timestamp.toISOString()
        };
        await binding.put('pending_payments', JSON.stringify(pendingPayments));
        return true;
    } catch (error) {
        console.error('Error saving pending payment:', error);
        return false;
    }
}

async function removePendingPayment(binding, userId) {
    try {
        const pendingPayments = await loadPendingPayments(binding);
        if (pendingPayments[userId]) {
            delete pendingPayments[userId];
            await binding.put('pending_payments', JSON.stringify(pendingPayments));
        }
        return true;
    } catch (error) {
        console.error('Error removing pending payment:', error);
        return false;
    }
}

async function getPendingPayment(binding, userId) {
    try {
        const pendingPayments = await loadPendingPayments(binding);
        const payment = pendingPayments[userId];
        if (payment) {
            return {
                ...payment,
                timestamp: new Date(payment.timestamp)
            };
        }
        return null;
    } catch (error) {
        console.error('Error getting pending payment:', error);
        return null;
    }
}

// ==================== FITUR BARU: STATISTICS & ANALYTICS ====================
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
    
    if (!stats.dailyStats[today]) {
        stats.dailyStats[today] = { transactions: 0, revenue: 0, users: 0 };
    }
    
    switch (type) {
        case 'purchase':
            stats.totalTransactions++;
            stats.totalRevenue += data.amount;
            stats.dailyStats[today].transactions++;
            stats.dailyStats[today].revenue += data.amount;
            
            if (!stats.popularProducts[data.productName]) {
                stats.popularProducts[data.productName] = 0;
            }
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

// ==================== FITUR BARU: SISTEM REWARD TRANSAKSI ====================
async function loadRewardSettings(binding) {
    try {
        const data = await binding.get('reward_settings', 'json');
        return data || {
            enabled: true,
            depositBonus: {
                enabled: true,
                percentage: 5, // 5% bonus
                minAmount: 10000,
                maxBonus: 50000
            },
            purchaseBonus: {
                enabled: true,
                cashback: 2, // 2% cashback
                minPurchase: 20000
            },
            referralBonus: {
                enabled: true,
                bonus: 10000, // Rp 10.000 untuk referrer
                bonusReferee: 5000 // Rp 5.000 untuk yang direferensikan
            },
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
    } catch (error) {
        return {
            enabled: true,
            depositBonus: { enabled: true, percentage: 5, minAmount: 10000, maxBonus: 50000 },
            purchaseBonus: { enabled: true, cashback: 2, minPurchase: 20000 },
            referralBonus: { enabled: true, bonus: 10000, bonusReferee: 5000 },
            achievementRewards: { enabled: true, rewards: {
                firstPurchase: 2000,
                fivePurchases: 5000,
                tenPurchases: 10000,
                bigSpender: 15000
            }}
        };
    }
}

async function saveRewardSettings(binding, settings) {
    try {
        await binding.put('reward_settings', JSON.stringify(settings));
        return true;
    } catch (error) {
        console.error('Error saving reward settings:', error);
        return false;
    }
}

// ==================== FUNGSI REWARD DEPOSIT ====================
async function calculateDepositBonus(env, nominal) {
    const settings = await loadRewardSettings(env.BOT_DB);
    
    if (!settings.enabled || !settings.depositBonus.enabled) {
        return 0;
    }
    
    if (nominal < settings.depositBonus.minAmount) {
        return 0;
    }
    
    let bonus = Math.floor(nominal * settings.depositBonus.percentage / 100);
    
    if (bonus > settings.depositBonus.maxBonus) {
        bonus = settings.depositBonus.maxBonus;
    }
    
    return bonus;
}

// ==================== FUNGSI REWARD PEMBELIAN ====================
async function calculatePurchaseCashback(env, amount) {
    const settings = await loadRewardSettings(env.BOT_DB);
    
    if (!settings.enabled || !settings.purchaseBonus.enabled) {
        return 0;
    }
    
    if (amount < settings.purchaseBonus.minPurchase) {
        return 0;
    }
    
    const cashback = Math.floor(amount * settings.purchaseBonus.cashback / 100);
    return cashback;
}

// ==================== FUNGSI REWARD ACHIEVEMENT ====================
async function getAchievementReward(env, achievementId) {
    const settings = await loadRewardSettings(env.BOT_DB);
    
    if (!settings.enabled || !settings.achievementRewards.enabled) {
        return 0;
    }
    
    return settings.achievementRewards.rewards[achievementId] || 0;
}

// ==================== PROSES DEPOSIT DENGAN BONUS ====================
async function processDepositWithBonus(env, userId, nominal, transactionId) {
    const users = await loadDB(env.BOT_DB, 'users');
    const userIdStr = userId.toString();
    
    if (!users[userIdStr]) {
        users[userIdStr] = { saldo: 0 };
    }
    
    // Hitung bonus deposit
    const bonus = await calculateDepositBonus(env, nominal);
    const totalCredit = nominal + bonus;
    
    users[userIdStr].saldo += totalCredit;
    await saveDB(env.BOT_DB, users, 'users');
    
    // Update statistics
    await updateStatistics(env.BOT_DB, 'deposit', {
        amount: nominal
    });
    
    // Add transaction history
    await addTransaction(env.BOT_DB, userIdStr, 'deposit', {
        amount: nominal,
        productName: 'Deposit'
    });
    
    // Add bonus transaction jika ada bonus
    if (bonus > 0) {
        await addTransaction(env.BOT_DB, userIdStr, 'bonus', {
            amount: bonus,
            productName: 'Bonus Deposit'
        });
    }
    
    return {
        nominal: nominal,
        bonus: bonus,
        totalCredit: totalCredit,
        newBalance: users[userIdStr].saldo
    };
}

// ==================== PROSES PEMBELIAN DENGAN CASHBACK ====================
async function processPurchaseWithCashback(env, userId, productName, amount) {
    const users = await loadDB(env.BOT_DB, 'users');
    const userIdStr = userId.toString();
    
    // Kurangi saldo untuk pembelian
    users[userIdStr].saldo -= amount;
    
    // Hitung cashback
    const cashback = await calculatePurchaseCashback(env, amount);
    
    // Tambahkan cashback jika ada
    if (cashback > 0) {
        users[userIdStr].saldo += cashback;
    }
    
    await saveDB(env.BOT_DB, users, 'users');
    
    // Update statistics
    await updateStatistics(env.BOT_DB, 'purchase', {
        amount: amount,
        productName: productName
    });
    
    // Add transaction history
    await addTransaction(env.BOT_DB, userIdStr, 'purchase', {
        amount: amount,
        productName: productName
    });
    
    // Add cashback transaction jika ada
    if (cashback > 0) {
        await addTransaction(env.BOT_DB, userIdStr, 'cashback', {
            amount: cashback,
            productName: 'Cashback Pembelian'
        });
    }
    
    // Check achievements
    await checkAchievements(env, userIdStr, 'purchase', {
        amount: amount
    });
    
    return {
        amount: amount,
        cashback: cashback,
        newBalance: users[userIdStr].saldo
    };
}

// ==================== FITUR BARU: ACHIEVEMENT SYSTEM ====================
async function checkAchievements(env, userId, action, data = {}) {
    const users = await loadDB(env.BOT_DB, 'users');
    const user = users[userId];
    
    if (!user.achievements) {
        user.achievements = {
            firstPurchase: false,
            fivePurchases: false,
            tenPurchases: false,
            bigSpender: false
        };
        user.purchaseCount = 0;
        user.totalSpent = 0;
    }
    
    let achievementUnlocked = null;
    
    switch (action) {
        case 'purchase':
            user.purchaseCount = (user.purchaseCount || 0) + 1;
            user.totalSpent = (user.totalSpent || 0) + (data.amount || 0);
            
            // Gunakan reward dari settings
            const rewardSettings = await loadRewardSettings(env.BOT_DB);
            const achievementRewards = rewardSettings.achievementRewards.rewards;
            
            if (!user.achievements.firstPurchase) {
                user.achievements.firstPurchase = true;
                achievementUnlocked = {
                    title: "Pembeli Pertama 🎯",
                    description: "Selamat! Anda telah melakukan pembelian pertama",
                    reward: achievementRewards.firstPurchase
                };
            } else if (user.purchaseCount >= 5 && !user.achievements.fivePurchases) {
                user.achievements.fivePurchases = true;
                achievementUnlocked = {
                    title: "Pelanggan Setia ⭐",
                    description: "Anda telah melakukan 5 pembelian!",
                    reward: achievementRewards.fivePurchases
                };
            } else if (user.purchaseCount >= 10 && !user.achievements.tenPurchases) {
                user.achievements.tenPurchases = true;
                achievementUnlocked = {
                    title: "Pelanggan Premium 👑",
                    description: "Anda telah melakukan 10 pembelian!",
                    reward: achievementRewards.tenPurchases
                };
            }
            
            if (achievementUnlocked && rewardSettings.enabled && rewardSettings.achievementRewards.enabled) {
                user.saldo += achievementUnlocked.reward;
                await saveDB(env.BOT_DB, users, 'users');
                
                await sendTelegramMessage(env.BOT_TOKEN, parseInt(userId),
                    `🏆 <b>Pencapaian Terbuka!</b>\n\n` +
                    `<b>${achievementUnlocked.title}</b>\n` +
                    `${achievementUnlocked.description}\n` +
                    `🎁 <b>Hadiah:</b> Rp ${formatNumber(achievementUnlocked.reward)}\n\n` +
                    `💰 <b>Saldo bertambah menjadi:</b> Rp ${formatNumber(user.saldo)}`
                );
            }
            break;
    }
    
    await saveDB(env.BOT_DB, users, 'users');
}

// ==================== FITUR BARU: RIWAYAT TRANSAKSI ====================
async function addTransaction(binding, userId, type, data) {
    const transactions = await loadDB(binding, 'transactions') || {};
    
    if (!transactions[userId]) {
        transactions[userId] = [];
    }
    
    const transaction = {
        id: generateTransactionId(),
        type: type,
        amount: data.amount,
        productName: data.productName,
        timestamp: new Date().toISOString(),
        status: 'completed'
    };
    
    transactions[userId].push(transaction);
    
    // Cleanup: maksimal 50 transaksi per user
    if (transactions[userId].length > 50) {
        transactions[userId] = transactions[userId].slice(-50);
    }
    
    await saveDB(binding, transactions, 'transactions');
    return transaction.id;
}

function generateTransactionId() {
    return 'TXN' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
}

// ==================== IMPROVED HELPER FUNCTIONS ====================
function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function getRandomAmount(env) {
    const min = parseInt(env.RANDOM_AMOUNT_MIN) || 1;
    const max = parseInt(env.RANDOM_AMOUNT_MAX) || 50;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==================== IMPROVED TELEGRAM MESSAGING ====================
async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: parseMode
    };
    
    if (replyMarkup) {
        payload.reply_markup = replyMarkup;
    }
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        
        return await response.json();
    } catch (error) {
        console.error('Error sending Telegram message:', error);
        return null;
    }
}

async function sendTelegramPhoto(botToken, chatId, photoUrl, caption = '', replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
    
    const payload = {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: parseMode
    };
    
    if (replyMarkup) {
        payload.reply_markup = replyMarkup;
    }
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        
        return await response.json();
    } catch (error) {
        console.error('Error sending Telegram photo:', error);
        return null;
    }
}

async function editMessageText(botToken, chatId, messageId, text, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: parseMode
    };
    
    if (replyMarkup) {
        payload.reply_markup = replyMarkup;
    }
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        
        return await response.json();
    } catch (error) {
        console.error('Error editing message text:', error);
        return null;
    }
}

async function editMessageCaption(botToken, chatId, messageId, caption, replyMarkup = null, parseMode = 'HTML') {
    const url = `https://api.telegram.org/bot${botToken}/editMessageCaption`;
    
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        caption: caption,
        parse_mode: parseMode
    };
    
    if (replyMarkup) {
        payload.reply_markup = replyMarkup;
    }
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        
        return await response.json();
    } catch (error) {
        console.error('Error editing message caption:', error);
        return null;
    }
}

async function answerCallbackQuery(botToken, callbackQueryId, text = null, showAlert = false) {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    
    const payload = {
        callback_query_id: callbackQueryId
    };
    
    if (text) {
        payload.text = text;
        payload.show_alert = showAlert;
    }
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        
        return await response.json();
    } catch (error) {
        console.error('Error answering callback query:', error);
        return null;
    }
}

// ==================== IMPROVED START COMMAND ====================
async function handleStart(update, env) {
    const user = update.message.from;
    const userId = user.id.toString();
    
    // ⚡ RESET STATE USER - Ini yang paling penting!
    clearUserSession(userId);
    
    const username = user.username || "Tidak Ada";
    
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    
    if (!users[userId]) {
        users[userId] = { 
            saldo: 0,
            joinDate: new Date().toISOString(),
            firstLogin: new Date().toISOString()
        };
        await saveDB(env.BOT_DB, users, 'users');
        await updateStatistics(env.BOT_DB, 'user_registered', {});
    }
    
    const saldo = users[userId].saldo;
    const formattedSaldo = formatNumber(saldo);
    const stok = Object.keys(accounts).length;
    
    const adminUsername = env.ADMIN_USERNAME || "@admin";

    const message = `
🎊 <b>Selamat Datang di Bot Premium Store!</b>

┌─── 📊 <b>INFO AKUN</b> ───┐
│ 👤 <b>User ID:</b> <code>${userId}</code>
│ 📝 <b>Username:</b> <code>@${username}</code>
│ 💰 <b>Saldo:</b> <code>Rp ${formattedSaldo}</code>
│ 📦 <b>Stok Tersedia:</b> <code>${stok} produk</code>
└─────────────────────

👨‍💼 <b>Admin:</b> ${adminUsername}

<code>================================</code>

✨ <b>Fitur Unggulan:</b>
• 🛒 Beli Akun Premium Otomatis
• 💳 Deposit Instant QRIS
• 🏆 Sistem Achievement
• 📊 Riwayat Transaksi
• ⚡ Proses Cepat & Aman

Pilih menu di bawah untuk memulai:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🛒 Beli Akun", callback_data: "beli_akun" },
                { text: "💳 Deposit", callback_data: "deposit" }
            ],
            [
                { text: "📊 Riwayat", callback_data: "riwayat" },
                { text: "🏆 Pencapaian", callback_data: "achievements" }
            ],
            [
                { text: "ℹ️ Bantuan", callback_data: "help" },
                { text: "👤 Profile", callback_data: "profile" }
            ]
        ]
    };
    
    return await sendTelegramMessage(env.BOT_TOKEN, user.id, message, keyboard);
}

// ==================== FITUR BARU: PROFILE USER ====================
async function handleProfile(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id.toString();
    
    const users = await loadDB(env.BOT_DB, 'users');
    const userData = users[userId];
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTransactions = transactions[userId] || [];
    
    const joinDate = new Date(userData.joinDate).toLocaleDateString('id-ID');
    const purchaseCount = userData.purchaseCount || 0;
    const totalSpent = userData.totalSpent || 0;
    const formattedTotalSpent = formatNumber(totalSpent);
    const formattedSaldo = formatNumber(userData.saldo);
    
    const message = `
👤 <b>Profile Pengguna</b>

┌─── 📊 <b>STATISTIK</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📅 <b>Bergabung:</b> <code>${joinDate}</code>
│ 🛒 <b>Total Pembelian:</b> <code>${purchaseCount}x</code>
│ 💰 <b>Total Pengeluaran:</b> <code>Rp ${formattedTotalSpent}</code>
│ 💳 <b>Saldo Saat Ini:</b> <code>Rp ${formattedSaldo}</code>
│ 📋 <b>Total Transaksi:</b> <code>${userTransactions.length}</code>
└─────────────────────

<code>================================</code>
💡 <i>Teruskan transaksi untuk membuka achievement!</i>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🏆 Pencapaian", callback_data: "achievements" },
                { text: "📊 Riwayat", callback_data: "riwayat" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: RIWAYAT TRANSAKSI ====================
async function handleRiwayat(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id.toString();
    
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTransactions = transactions[userId] || [];
    
    if (userTransactions.length === 0) {
        const message = `
📊 <b>Riwayat Transaksi</b>

Belum ada transaksi yang dilakukan.
Mulai belanja sekarang! 🛒
        `;
        
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "🛒 Belanja Sekarang", callback_data: "beli_akun" },
                    { text: "💳 Deposit", callback_data: "deposit" }
                ],
                [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
            ]
        };
        
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
    }
    
    const recentTransactions = userTransactions.slice(-10).reverse();
    const transactionList = recentTransactions.map((trans, index) => {
        const date = new Date(trans.timestamp).toLocaleDateString('id-ID');
        const time = new Date(trans.timestamp).toLocaleTimeString('id-ID', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        const amount = formatNumber(trans.amount);
        const type = trans.type === 'purchase' ? '🛒' : 
                    trans.type === 'deposit' ? '💳' :
                    trans.type === 'bonus' ? '🎁' :
                    trans.type === 'cashback' ? '💰' : '📊';
        const product = trans.productName ? `- ${trans.productName}` : '';
        
        return `${index + 1}. ${type} ${product}\n   💰 Rp ${amount} | 📅 ${date} ${time}`;
    }).join('\n\n');
    
    const totalTransactions = userTransactions.length;
    const totalSpent = userTransactions.reduce((sum, trans) => sum + trans.amount, 0);
    const formattedTotalSpent = formatNumber(totalSpent);
    
    const message = `
📊 <b>Riwayat Transaksi Terakhir</b>

${transactionList}

<code>================================</code>
📈 <b>Statistik:</b>
├ Total Transaksi: <b>${totalTransactions}</b>
└ Total Pengeluaran: <b>Rp ${formattedTotalSpent}</b>

<code>================================</code>
💡 <i>Menampilkan 10 transaksi terakhir</i>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🔄 Refresh", callback_data: "riwayat" },
                { text: "📋 Semua Riwayat", callback_data: "full_riwayat" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: FULL RIWAYAT ====================
async function handleFullRiwayat(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id.toString();
    
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const userTransactions = transactions[userId] || [];
    
    if (userTransactions.length === 0) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Tidak ada riwayat transaksi!", true);
        return;
    }
    
    const allTransactions = userTransactions.reverse();
    const transactionSummary = allTransactions.map((trans, index) => {
        const date = new Date(trans.timestamp).toLocaleDateString('id-ID');
        const amount = formatNumber(trans.amount);
        const type = trans.type === 'purchase' ? '🛒 Beli' : 
                    trans.type === 'deposit' ? '💳 Deposit' :
                    trans.type === 'bonus' ? '🎁 Bonus' :
                    trans.type === 'cashback' ? '💰 Cashback' : '📊 Lainnya';
        const product = trans.productName ? `- ${trans.productName}` : '';
        
        return `${index + 1}. ${type} ${product}\n   💰 Rp ${amount} | 📅 ${date}`;
    }).join('\n\n');
    
    const totalSpent = userTransactions.reduce((sum, trans) => sum + trans.amount, 0);
    const formattedTotalSpent = formatNumber(totalSpent);
    
    const message = `
📋 <b>Semua Riwayat Transaksi</b>

Total: <b>${userTransactions.length} transaksi</b>

${transactionSummary}

<code>================================</code>
💰 <b>Total Pengeluaran:</b> Rp ${formattedTotalSpent}
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali ke Riwayat", callback_data: "riwayat" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: ACHIEVEMENTS ====================
async function handleAchievements(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id.toString();
    
    const users = await loadDB(env.BOT_DB, 'users');
    const userData = users[userId];
    const rewardSettings = await loadRewardSettings(env.BOT_DB);
    
    if (!userData.achievements) {
        userData.achievements = {
            firstPurchase: false,
            fivePurchases: false,
            tenPurchases: false,
            bigSpender: false
        };
        userData.purchaseCount = 0;
        userData.totalSpent = 0;
    }
    
    const achievements = [
        {
            id: 'firstPurchase',
            title: 'Pembeli Pertama 🎯',
            description: 'Lakukan pembelian pertama',
            unlocked: userData.achievements.firstPurchase,
            reward: rewardSettings.achievementRewards.rewards.firstPurchase
        },
        {
            id: 'fivePurchases',
            title: 'Pelanggan Setia ⭐',
            description: 'Lakukan 5 pembelian',
            unlocked: userData.achievements.fivePurchases,
            progress: userData.purchaseCount || 0,
            target: 5,
            reward: rewardSettings.achievementRewards.rewards.fivePurchases
        },
        {
            id: 'tenPurchases',
            title: 'Pelanggan Premium 👑',
            description: 'Lakukan 10 pembelian',
            unlocked: userData.achievements.tenPurchases,
            progress: userData.purchaseCount || 0,
            target: 10,
            reward: rewardSettings.achievementRewards.rewards.tenPurchases
        },
        {
            id: 'bigSpender',
            title: 'Big Spender 💎',
            description: 'Habiskan total Rp 100.000',
            unlocked: userData.achievements.bigSpender,
            progress: userData.totalSpent || 0,
            target: 100000,
            reward: rewardSettings.achievementRewards.rewards.bigSpender
        }
    ];
    
    const unlockedCount = achievements.filter(ach => ach.unlocked).length;
    const totalRewards = achievements.filter(ach => ach.unlocked).reduce((sum, ach) => sum + ach.reward, 0);
    
    const achievementList = achievements.map(ach => {
        const status = ach.unlocked ? '✅' : '❌';
        const progress = ach.progress !== undefined ? ` (${ach.progress}/${ach.target})` : '';
        const rewardText = ach.unlocked ? `🎁 Rp ${formatNumber(ach.reward)}` : `💡 Reward: Rp ${formatNumber(ach.reward)}`;
        
        return `${status} <b>${ach.title}</b>\n   📝 ${ach.description}${progress}\n   ${rewardText}`;
    }).join('\n\n');
    
    const message = `
🏆 <b>Pencapaian Anda</b>

${achievementList}

<code>================================</code>
📊 <b>Statistik:</b>
├ 🎯 Terbuka: <b>${unlockedCount}/${achievements.length}</b>
├ 🎁 Total Reward: <b>Rp ${formatNumber(totalRewards)}</b>
├ 🛒 Total Pembelian: <b>${userData.purchaseCount || 0}</b>
└ 💰 Total Pengeluaran: <b>Rp ${formatNumber(userData.totalSpent || 0)}</b>

<code>================================</code>
💡 <i>Lanjutkan transaksi untuk membuka achievement lainnya!</i>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🛒 Lanjut Belanja", callback_data: "beli_akun" },
                { text: "📊 Riwayat", callback_data: "riwayat" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: HELP & SUPPORT ====================
async function handleHelp(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    const message = `
ℹ️ <b>Pusat Bantuan</b>

<u>📖 Cara Menggunakan Bot:</u>
1. <b>Deposit:</b> Klik menu deposit → masukkan nominal → scan QRIS → konfirmasi
2. <b>Beli Akun:</b> Pilih produk → konfirmasi pembelian → dapatkan akun
3. <b>Cek Saldo:</b> Lihat di menu utama atau profile

<u>⚡ Fitur Utama:</u>
• 🛒 Beli akun premium otomatis
• 💳 Deposit instant dengan QRIS
• 🏆 Achievement dan reward
• 📊 Riwayat transaksi lengkap
• 👤 Profile dan statistik

<u>🔧 Bantuan & Support:</u>
• Deposit bermasalah? Hubungi admin
• Produk tidak valid? Laporkan ke admin
• Butuh bantuan lain? Chat admin

<u>⚠️ Penting:</u>
• Simpan bukti transaksi dengan baik
• Jangan bagikan data akun ke orang lain
• Laporkan masalah segera ke admin

👨‍💼 <b>Admin Support:</b> ${env.ADMIN_USERNAME || "@admin"}
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "💬 Chat Admin", url: `https://t.me/${env.ADMIN_USERNAME?.replace('@', '') || 'admin'}` },
                { text: "🛒 Beli Akun", callback_data: "beli_akun" }
            ],
            [
                { text: "💳 Deposit", callback_data: "deposit" },
                { text: "🔙 Kembali", callback_data: "back_to_main" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== IMPROVED ADMIN FEATURES ====================
async function handleAdmin(update, env) {
    const message = update.message;
    const user = message.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        const responseMessage = `
❌ <b>Akses Ditolak!</b>

Hanya admin yang dapat menggunakan perintah ini.
        `;
        return await sendTelegramMessage(env.BOT_TOKEN, user.id, responseMessage);
    }
    
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const stats = await loadStatistics(env.BOT_DB);
    
    const totalMembers = Object.keys(users).length;
    const totalProducts = Object.keys(accounts).length;
    const totalRevenue = formatNumber(stats.totalRevenue);
    
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyStats[today] || { transactions: 0, revenue: 0, users: 0 };
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "💰 Kelola Saldo", callback_data: "admin_saldo" },
                { text: "🛒 Kelola Produk", callback_data: "admin_produk" }
            ],
            [
                { text: "📊 Statistik", callback_data: "admin_stats" },
                { text: "👥 Management User", callback_data: "admin_users" }
            ],
            [
                { text: "🎁 Reward Settings", callback_data: "admin_reward_settings" },
                { text: "⚙️ Settings", callback_data: "admin_settings" }
            ],
            [
                { text: "🔔 Broadcast", callback_data: "admin_broadcast" }
            ]
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

// ==================== FITUR BARU: ADMIN STATISTICS ====================
async function handleAdminStats(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const stats = await loadStatistics(env.BOT_DB);
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const pendingPayments = await loadPendingPayments(env.BOT_DB);
    
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyStats[today] || { transactions: 0, revenue: 0, users: 0 };
    
    // Popular products
    const popularProducts = Object.entries(stats.popularProducts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([product, count], index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '▫️';
            return `${medal} ${product}: ${count}x`;
        })
        .join('\n') || '▫️ Tidak ada data';
    
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
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🔄 Refresh", callback_data: "admin_stats" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: ADMIN USER MANAGEMENT ====================
async function handleAdminUsers(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const users = await loadDB(env.BOT_DB, 'users');
    const totalUsers = Object.keys(users).length;
    
    // User dengan saldo tertinggi
    const topUsers = Object.entries(users)
        .sort(([,a], [,b]) => b.saldo - a.saldo)
        .slice(0, 5)
        .map(([userId, userData], index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '▫️';
            return `${medal} ${userId}: Rp ${formatNumber(userData.saldo)}`;
        })
        .join('\n') || '▫️ Tidak ada data';
    
    // User aktif (dengan transaksi)
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

🛠️ <b>Management Tools:</b>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "📋 List Users", callback_data: "admin_list_users" }
            ],
            [
                { text: "💰 Top Up Manual", callback_data: "admin_manual_topup" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE ADMIN SALDO ====================
async function handleAdminSaldo(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const message = `
💰 <b>Kelola Saldo User</b>

Pilih aksi yang ingin dilakukan:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "➕ Tambah Saldo", callback_data: "admin_tambah_saldo" },
                { text: "➖ Kurangi Saldo", callback_data: "admin_kurangi_saldo" }
            ],
            [
                { text: "📋 Cek Saldo User", callback_data: "admin_cek_saldo" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE ADMIN PRODUK ====================
async function handleAdminProduk(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const totalProducts = Object.keys(accounts).length;
    
    const message = `
🛒 <b>Kelola Produk</b>

Total produk: <code>${totalProducts}</code>

Pilih aksi yang ingin dilakukan:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "➕ Tambah Produk", callback_data: "admin_tambah_akun" },
                { text: "🗑️ Hapus Produk", callback_data: "admin_hapus_akun" }
            ],
            [
                { text: "📋 List Produk", callback_data: "admin_list_akun" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE ADMIN SETTINGS ====================
async function handleAdminSettings(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const message = `
⚙️ <b>Admin Settings</b>

Pengaturan sistem bot:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🎁 Reward Settings", callback_data: "admin_reward_settings" },
                { text: "🔄 Cleanup Data", callback_data: "admin_cleanup" }
            ],
            [
                { text: "📋 Pending Payments", callback_data: "admin_pending" }
            ],
            [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: ADMIN REWARD SETTINGS ====================
async function handleAdminRewardSettings(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
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
            [
                { text: settings.enabled ? "❌ Nonaktifkan Sistem" : "✅ Aktifkan Sistem", 
                  callback_data: `reward_toggle_system` }
            ],
            [
                { text: "💰 Atur Bonus Deposit", callback_data: "reward_setting_deposit" },
                { text: "🛒 Atur Cashback", callback_data: "reward_setting_purchase" }
            ],
            [
                { text: "👥 Atur Referral", callback_data: "reward_setting_referral" },
                { text: "🏆 Atur Achievement", callback_data: "reward_setting_achievement" }
            ],
            [
                { text: "🔙 Kembali", callback_data: "admin_settings" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE TOGGLE REWARD SYSTEM ====================
async function handleRewardToggleSystem(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.enabled = !settings.enabled;
    
    await saveRewardSettings(env.BOT_DB, settings);
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, 
        `✅ Sistem reward ${settings.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    
    return await handleAdminRewardSettings(update, env);
}

// ==================== HANDLE REWARD SETTING DEPOSIT ====================
async function handleRewardSettingDeposit(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const deposit = settings.depositBonus;
    
    const message = `
💰 <b>Pengaturan Bonus Deposit</b>

Status: <code>${deposit.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih yang ingin diubah:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: deposit.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", 
                  callback_data: "reward_toggle_deposit" }
            ],
            [
                { text: `📊 Persentase (${deposit.percentage}%)`, callback_data: "reward_set_deposit_percentage" },
                { text: `💵 Minimal (Rp ${formatNumber(deposit.minAmount)})`, callback_data: "reward_set_deposit_min" }
            ],
            [
                { text: `🎯 Maksimal (Rp ${formatNumber(deposit.maxBonus)})`, callback_data: "reward_set_deposit_max" }
            ],
            [
                { text: "🔙 Kembali", callback_data: "admin_reward_settings" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE TOGGLE DEPOSIT BONUS ====================
async function handleRewardToggleDeposit(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.depositBonus.enabled = !settings.depositBonus.enabled;
    
    await saveRewardSettings(env.BOT_DB, settings);
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, 
        `✅ Bonus deposit ${settings.depositBonus.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    
    return await handleRewardSettingDeposit(update, env);
}

// ==================== HANDLE SET DEPOSIT PERCENTAGE ====================
async function handleRewardSetDepositPercentage(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_deposit_percentage',
        setting: 'deposit_percentage'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentPercentage = settings.depositBonus.percentage;
    
    const message = `
📊 <b>Atur Persentase Bonus Deposit</b>

Persentase saat ini: <code>${currentPercentage}%</code>

Silakan kirim persentase baru (1-100):

Contoh: <code>10</code> untuk 10%
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_deposit" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET DEPOSIT MIN AMOUNT ====================
async function handleRewardSetDepositMin(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_deposit_min_amount',
        setting: 'deposit_min_amount'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentMin = settings.depositBonus.minAmount;
    
    const message = `
💵 <b>Atur Minimal Deposit untuk Bonus</b>

Minimal saat ini: <code>Rp ${formatNumber(currentMin)}</code>

Silakan kirim nominal minimal baru:

Contoh: <code>50000</code> untuk Rp 50.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_deposit" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET DEPOSIT MAX BONUS ====================
async function handleRewardSetDepositMax(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_deposit_max_bonus',
        setting: 'deposit_max_bonus'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentMax = settings.depositBonus.maxBonus;
    
    const message = `
🎯 <b>Atur Maksimal Bonus Deposit</b>

Maksimal saat ini: <code>Rp ${formatNumber(currentMax)}</code>

Silakan kirim nominal maksimal bonus baru:

Contoh: <code>100000</code> untuk Rp 100.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_deposit" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE REWARD SETTING PURCHASE ====================
async function handleRewardSettingPurchase(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const purchase = settings.purchaseBonus;
    
    const message = `
🛒 <b>Pengaturan Cashback Pembelian</b>

Status: <code>${purchase.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih yang ingin diubah:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: purchase.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", 
                  callback_data: "reward_toggle_purchase" }
            ],
            [
                { text: `📊 Cashback (${purchase.cashback}%)`, callback_data: "reward_set_purchase_cashback" },
                { text: `💵 Minimal (Rp ${formatNumber(purchase.minPurchase)})`, callback_data: "reward_set_purchase_min" }
            ],
            [
                { text: "🔙 Kembali", callback_data: "admin_reward_settings" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE TOGGLE PURCHASE BONUS ====================
async function handleRewardTogglePurchase(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.purchaseBonus.enabled = !settings.purchaseBonus.enabled;
    
    await saveRewardSettings(env.BOT_DB, settings);
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, 
        `✅ Cashback pembelian ${settings.purchaseBonus.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    
    return await handleRewardSettingPurchase(update, env);
}

// ==================== HANDLE SET PURCHASE CASHBACK ====================
async function handleRewardSetPurchaseCashback(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_purchase_cashback',
        setting: 'purchase_cashback'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentCashback = settings.purchaseBonus.cashback;
    
    const message = `
📊 <b>Atur Persentase Cashback Pembelian</b>

Cashback saat ini: <code>${currentCashback}%</code>

Silakan kirim persentase cashback baru (0-100):

Contoh: <code>5</code> untuk 5%
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_purchase" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET PURCHASE MIN AMOUNT ====================
async function handleRewardSetPurchaseMin(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_purchase_min_amount',
        setting: 'purchase_min_amount'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentMin = settings.purchaseBonus.minPurchase;
    
    const message = `
💵 <b>Atur Minimal Pembelian untuk Cashback</b>

Minimal saat ini: <code>Rp ${formatNumber(currentMin)}</code>

Silakan kirim nominal minimal baru:

Contoh: <code>50000</code> untuk Rp 50.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_purchase" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE REWARD SETTING REFERRAL ====================
async function handleRewardSettingReferral(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const referral = settings.referralBonus;
    
    const message = `
👥 <b>Pengaturan Bonus Referral</b>

Status: <code>${referral.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih yang ingin diubah:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: referral.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", 
                  callback_data: "reward_toggle_referral" }
            ],
            [
                { text: `🤵 Bonus Referrer (Rp ${formatNumber(referral.bonus)})`, callback_data: "reward_set_referrer_bonus" },
                { text: `👤 Bonus Referee (Rp ${formatNumber(referral.bonusReferee)})`, callback_data: "reward_set_referee_bonus" }
            ],
            [
                { text: "🔙 Kembali", callback_data: "admin_reward_settings" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE TOGGLE REFERRAL BONUS ====================
async function handleRewardToggleReferral(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.referralBonus.enabled = !settings.referralBonus.enabled;
    
    await saveRewardSettings(env.BOT_DB, settings);
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, 
        `✅ Bonus referral ${settings.referralBonus.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    
    return await handleRewardSettingReferral(update, env);
}

// ==================== HANDLE SET REFERRER BONUS ====================
async function handleRewardSetReferrerBonus(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_referrer_bonus',
        setting: 'referrer_bonus'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentBonus = settings.referralBonus.bonus;
    
    const message = `
🤵 <b>Atur Bonus untuk Referrer</b>

Bonus saat ini: <code>Rp ${formatNumber(currentBonus)}</code>

Silakan kirim nominal bonus baru untuk referrer:

Contoh: <code>15000</code> untuk Rp 15.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_referral" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET REFEREE BONUS ====================
async function handleRewardSetRefereeBonus(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_referee_bonus',
        setting: 'referee_bonus'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentBonus = settings.referralBonus.bonusReferee;
    
    const message = `
👤 <b>Atur Bonus untuk Referee</b>

Bonus saat ini: <code>Rp ${formatNumber(currentBonus)}</code>

Silakan kirim nominal bonus baru untuk referee:

Contoh: <code>10000</code> untuk Rp 10.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_referral" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE REWARD SETTING ACHIEVEMENT ====================
async function handleRewardSettingAchievement(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const achievement = settings.achievementRewards;
    
    const message = `
🏆 <b>Pengaturan Reward Achievement</b>

Status: <code>${achievement.enabled ? 'AKTIF' : 'NON-AKTIF'}</code>

Silakan pilih achievement yang ingin diubah reward-nya:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: achievement.enabled ? "❌ Nonaktifkan" : "✅ Aktifkan", 
                  callback_data: "reward_toggle_achievement" }
            ],
            [
                { text: `🎯 First Purchase (Rp ${formatNumber(achievement.rewards.firstPurchase)})`, 
                  callback_data: "reward_set_achievement_first" }
            ],
            [
                { text: `⭐ 5 Purchases (Rp ${formatNumber(achievement.rewards.fivePurchases)})`, 
                  callback_data: "reward_set_achievement_five" }
            ],
            [
                { text: `👑 10 Purchases (Rp ${formatNumber(achievement.rewards.tenPurchases)})`, 
                  callback_data: "reward_set_achievement_ten" }
            ],
            [
                { text: `💎 Big Spender (Rp ${formatNumber(achievement.rewards.bigSpender)})`, 
                  callback_data: "reward_set_achievement_big" }
            ],
            [
                { text: "🔙 Kembali", callback_data: "admin_reward_settings" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE TOGGLE ACHIEVEMENT REWARDS ====================
async function handleRewardToggleAchievement(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const settings = await loadRewardSettings(env.BOT_DB);
    settings.achievementRewards.enabled = !settings.achievementRewards.enabled;
    
    await saveRewardSettings(env.BOT_DB, settings);
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, 
        `✅ Reward achievement ${settings.achievementRewards.enabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
    
    return await handleRewardSettingAchievement(update, env);
}

// ==================== HANDLE SET ACHIEVEMENT FIRST PURCHASE ====================
async function handleRewardSetAchievementFirst(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_achievement_first',
        setting: 'achievement_first'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.firstPurchase;
    
    const message = `
🎯 <b>Atur Reward First Purchase</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:

Contoh: <code>5000</code> untuk Rp 5.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET ACHIEVEMENT FIVE PURCHASES ====================
async function handleRewardSetAchievementFive(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_achievement_five',
        setting: 'achievement_five'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.fivePurchases;
    
    const message = `
⭐ <b>Atur Reward 5 Purchases</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:

Contoh: <code>10000</code> untuk Rp 10.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET ACHIEVEMENT TEN PURCHASES ====================
async function handleRewardSetAchievementTen(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_achievement_ten',
        setting: 'achievement_ten'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.tenPurchases;
    
    const message = `
👑 <b>Atur Reward 10 Purchases</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:

Contoh: <code>20000</code> untuk Rp 20.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE SET ACHIEVEMENT BIG SPENDER ====================
async function handleRewardSetAchievementBig(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'set_achievement_big',
        setting: 'achievement_big'
    });
    
    const settings = await loadRewardSettings(env.BOT_DB);
    const currentReward = settings.achievementRewards.rewards.bigSpender;
    
    const message = `
💎 <b>Atur Reward Big Spender</b>

Reward saat ini: <code>Rp ${formatNumber(currentReward)}</code>

Silakan kirim nominal reward baru:

Contoh: <code>30000</code> untuk Rp 30.000
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "reward_setting_achievement" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE ADMIN BROADCAST ====================
async function handleAdminBroadcast(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const message = `
🔔 <b>Broadcast Message</b>

Kirim pesan ke semua user:

1. Balas pesan ini dengan perintah:
   <code>/broadcast</code> - untuk semua user
   
2. Atau format spesifik:
   <code>/broadcast id1,id2,id3</code> - untuk user tertentu
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "back_to_admin" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: TAMBAH SALDO ====================
async function handleAdminTambahSaldo(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { action: 'tambah_saldo' });
    
    const message = `
💰 <b>Tambah Saldo User</b>

Silakan kirim format:
<code>user_id nominal</code>

Contoh:
<code>123456789 50000</code>

Akan menambahkan Rp 50.000 ke user ID 123456789
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_saldo" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: KURANGI SALDO ====================
async function handleAdminKurangiSaldo(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { action: 'kurangi_saldo' });
    
    const message = `
💰 <b>Kurangi Saldo User</b>

Silakan kirim format:
<code>user_id nominal</code>

Contoh:
<code>123456789 25000</code>

Akan mengurangi Rp 25.000 dari user ID 123456789
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_saldo" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: CEK SALDO ====================
async function handleAdminCekSaldo(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { action: 'cek_saldo' });
    
    const message = `
💰 <b>Cek Saldo User</b>

Silakan kirim User ID yang ingin dicek saldonya:

Contoh:
<code>123456789</code>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_saldo" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: TAMBAH PRODUK ====================
async function handleAdminTambahAkun(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { 
        action: 'tambah_akun',
        step: 'nama',
        data: {}
    });
    
    const message = `
🛒 <b>Tambah Produk Baru</b>

Silakan masukkan <b>nama produk</b>:

Contoh:
<code>Netflix Premium</code>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_produk" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: HAPUS PRODUK ====================
async function handleAdminHapusAkun(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { action: 'hapus_akun' });
    
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const accountList = Object.entries(accounts)
        .slice(0, 10)
        .map(([email, akun], index) => 
            `${index + 1}. ${akun.name} - ${email}`
        )
        .join('\n') || 'Tidak ada produk';
    
    const message = `
🗑️ <b>Hapus Produk</b>

Produk tersedia:
${accountList}

Silakan kirim <b>email produk</b> yang ingin dihapus:

Contoh:
<code>user@example.com</code>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_produk" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: LIST PRODUK ====================
async function handleAdminListAkun(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    
    if (Object.keys(accounts).length === 0) {
        const message = `
📋 <b>List Produk</b>

Tidak ada produk yang tersedia.
        `;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔙 Kembali", callback_data: "admin_produk" }]
            ]
        };
        
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
    }
    
    const accountList = Object.entries(accounts)
        .map(([email, akun], index) => 
            `${index + 1}. <b>${akun.name}</b>\n   📧 ${email}\n   💰 Rp ${formatNumber(akun.price)}\n   ───────────────────`
        )
        .join('\n');
    
    const message = `
📋 <b>List Semua Produk</b>

Total: <b>${Object.keys(accounts).length} produk</b>

${accountList}
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_produk" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: LIST USERS ====================
async function handleAdminListUsers(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const users = await loadDB(env.BOT_DB, 'users');
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    
    if (Object.keys(users).length === 0) {
        const message = `
📋 <b>List Users</b>

Tidak ada user yang terdaftar.
        `;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔙 Kembali", callback_data: "admin_users" }]
            ]
        };
        
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
    }
    
    const userList = Object.entries(users)
        .slice(0, 15)
        .map(([userId, userData], index) => {
            const userTransactions = transactions[userId] || [];
            const transactionCount = userTransactions.length;
            return `${index + 1}. <b>${userId}</b>\n   💰 Rp ${formatNumber(userData.saldo)} | 📊 ${transactionCount} transaksi`;
        })
        .join('\n\n');
    
    const message = `
📋 <b>List Users</b>

Total: <b>${Object.keys(users).length} users</b>

${userList}

<code>================================</code>
💡 Menampilkan 15 user pertama
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_users" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR ADMIN: MANUAL TOPUP ====================
async function handleAdminManualTopup(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    setUserSession(user.id, { action: 'manual_topup' });
    
    const message = `
💰 <b>Manual Top Up</b>

Silakan kirim format:
<code>user_id nominal</code>

Contoh:
<code>123456789 100000</code>

Akan menambahkan Rp 100.000 ke saldo user
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_users" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== FITUR BARU: CLEANUP DATA ====================
async function handleAdminCleanup(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const message = `
🔄 <b>Cleanup Data</b>

Pilih data yang ingin dibersihkan:

• <b>Pending Payments</b> - Hapus pembayaran expired
• <b>Old Transactions</b> - Hapus transaksi lama
• <b>Inactive Users</b> - Hapus user tidak aktif
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🧹 Pending Payments", callback_data: "admin_cleanup_pending" },
                { text: "🗑️ Old Transactions", callback_data: "admin_cleanup_transactions" }
            ],
            [
                { text: "👥 Inactive Users", callback_data: "admin_cleanup_users" }
            ],
            [{ text: "🔙 Kembali", callback_data: "admin_settings" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== CLEANUP PENDING PAYMENTS ====================
async function handleAdminCleanupPending(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const pendingPayments = await loadPendingPayments(env.BOT_DB);
    const now = new Date();
    let cleanedCount = 0;
    
    for (const [userId, payment] of Object.entries(pendingPayments)) {
        const paymentTime = new Date(payment.timestamp);
        const diffMinutes = (now - paymentTime) / (1000 * 60);
        
        if (diffMinutes > 10) {
            await removePendingPayment(env.BOT_DB, parseInt(userId));
            cleanedCount++;
        }
    }
    
    const message = `
🧹 <b>Cleanup Pending Payments Selesai</b>

✅ <b>Berhasil membersihkan:</b> <code>${cleanedCount} pembayaran expired</code>
📊 <b>Sisa pending:</b> <code>${Object.keys(pendingPayments).length - cleanedCount} pembayaran</code>

<code>================================</code>
💡 <i>Pembersihan otomatis dilakukan setiap request</i>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_cleanup" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== CLEANUP OLD TRANSACTIONS ====================
async function handleAdminCleanupTransactions(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    let cleanedCount = 0;
    let totalUsers = 0;
    
    for (const [userId, userTransactions] of Object.entries(transactions)) {
        if (userTransactions && Array.isArray(userTransactions)) {
            // Simpan hanya 50 transaksi terbaru per user
            if (userTransactions.length > 50) {
                transactions[userId] = userTransactions.slice(-50);
                cleanedCount += (userTransactions.length - 50);
            }
            totalUsers++;
        }
    }
    
    await saveDB(env.BOT_DB, transactions, 'transactions');
    
    const message = `
🗑️ <b>Cleanup Transaksi Lama Selesai</b>

✅ <b>Berhasil membersihkan:</b> <code>${cleanedCount} transaksi lama</code>
📊 <b>Total users dengan transaksi:</b> <code>${totalUsers} users</code>

<code>================================</code>
💡 <i>Setiap user maksimal menyimpan 50 transaksi terbaru</i>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_cleanup" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== CLEANUP INACTIVE USERS ====================
async function handleAdminCleanupUsers(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const users = await loadDB(env.BOT_DB, 'users');
    const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    let inactiveUsers = 0;
    let deletedUsers = 0;
    
    for (const [userId, userData] of Object.entries(users)) {
        const lastActivity = await getUserLastActivity(env.BOT_DB, userId);
        const joinDate = new Date(userData.joinDate || userData.firstLogin || now);
        
        // User dianggap inactive jika tidak ada transaksi dalam 30 hari
        if (lastActivity < thirtyDaysAgo && joinDate < thirtyDaysAgo) {
            // Hanya hapus jika saldo = 0 dan tidak ada transaksi penting
            if (userData.saldo === 0 && (!transactions[userId] || transactions[userId].length === 0)) {
                delete users[userId];
                if (transactions[userId]) {
                    delete transactions[userId];
                }
                deletedUsers++;
            } else {
                inactiveUsers++;
            }
        }
    }
    
    await saveDB(env.BOT_DB, users, 'users');
    await saveDB(env.BOT_DB, transactions, 'transactions');
    
    const message = `
👥 <b>Cleanup User Tidak Aktif Selesai</b>

✅ <b>User dihapus:</b> <code>${deletedUsers} user</code>
📊 <b>User tidak aktif (saldo > 0):</b> <code>${inactiveUsers} user</code>
👤 <b>Total user tersisa:</b> <code>${Object.keys(users).length} user</code>

<code>================================</code>
💡 <i>User dengan saldo 0 dan tidak aktif >30 hari akan dihapus</i>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "admin_cleanup" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== GET USER LAST ACTIVITY ====================
async function getUserLastActivity(binding, userId) {
    const transactions = await loadDB(binding, 'transactions') || {};
    const userTransactions = transactions[userId] || [];
    
    if (userTransactions.length > 0) {
        // Ambil transaksi terbaru
        const latestTransaction = userTransactions.reduce((latest, transaction) => {
            const transactionTime = new Date(transaction.timestamp);
            return transactionTime > latest ? transactionTime : latest;
        }, new Date(0));
        
        return latestTransaction;
    }
    
    // Jika tidak ada transaksi, gunakan join date
    const users = await loadDB(binding, 'users');
    const userData = users[userId];
    if (userData && userData.joinDate) {
        return new Date(userData.joinDate);
    }
    
    return new Date(0);
}

// ==================== FITUR ADMIN: PENDING PAYMENTS ====================
async function handleAdminPending(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const pendingPayments = await loadPendingPayments(env.BOT_DB);
    
    if (Object.keys(pendingPayments).length === 0) {
        const message = `
📋 <b>Pending Payments</b>

Tidak ada pembayaran pending.
        `;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔙 Kembali", callback_data: "admin_settings" }]
            ]
        };
        
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
    }
    
    const now = new Date();
    const pendingList = Object.entries(pendingPayments)
        .map(([userId, payment]) => {
            const paymentTime = new Date(payment.timestamp);
            const diffMinutes = Math.floor((now - paymentTime) / (1000 * 60));
            const remaining = 10 - diffMinutes;
            return `• <b>${userId}</b>\n  🆔 ${payment.transactionId}\n  💰 Rp ${formatNumber(payment.nominal)}\n  ⏰ ${remaining}m left`;
        })
        .join('\n\n');
    
    const message = `
📋 <b>Pending Payments</b>

Total: <b>${Object.keys(pendingPayments).length} pending</b>

${pendingList}
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🔄 Refresh", callback_data: "admin_pending" },
                { text: "🧹 Cleanup", callback_data: "admin_cleanup_pending" }
            ],
            [{ text: "🔙 Kembali", callback_data: "admin_settings" }]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE ADMIN MESSAGE PROCESSING ====================
async function handleAdminMessage(update, env) {
    const message = update.message;
    const user = message.from;
    const text = message.text;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        return;
    }
    
    const session = getUserSession(user.id);
    if (!session) {
        return;
    }
    
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const settings = await loadRewardSettings(env.BOT_DB);
    
    try {
        switch (session.action) {
            case 'tambah_saldo':
            case 'kurangi_saldo':
            case 'manual_topup':
                const [targetId, amountStr] = text.split(' ');
                const amount = parseInt(amountStr);
                
                if (!targetId || !amountStr) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Format salah. Gunakan: user_id nominal</b>");
                    clearUserSession(user.id);
                    return;
                }
                
                if (!users[targetId]) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>User tidak ditemukan.</b>");
                    clearUserSession(user.id);
                    return;
                }
                
                if (isNaN(amount) || amount <= 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                
                const oldSaldo = users[targetId].saldo;
                
                if (session.action === 'tambah_saldo' || session.action === 'manual_topup') {
                    users[targetId].saldo += amount;
                } else {
                    if (users[targetId].saldo < amount) {
                        await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Saldo user tidak cukup untuk dikurangi.</b>");
                        clearUserSession(user.id);
                        return;
                    }
                    users[targetId].saldo -= amount;
                }
                
                await saveDB(env.BOT_DB, users, 'users');
                
                const formattedAmount = formatNumber(amount);
                const formattedOldSaldo = formatNumber(oldSaldo);
                const formattedNewSaldo = formatNumber(users[targetId].saldo);
                
                const actionType = session.action === 'tambah_saldo' ? 'Penambahan' : 
                                 session.action === 'manual_topup' ? 'Top Up Manual' : 'Pengurangan';
                
                const adminMsg = `
✅ <b>Saldo berhasil diperbarui!</b>

┌─── 👤 <b>USER</b> ───┐
│ 🆔 <b>User ID:</b> <code>${targetId}</code>
│ 💰 <b>Saldo Lama:</b> <code>Rp ${formattedOldSaldo}</code>
└─────────────────────

┌─── 💰 <b>TRANSAKSI</b> ───┐
│ 📝 <b>Tipe:</b> <code>${actionType}</code>
│ 💵 <b>Nominal:</b> <code>Rp ${formattedAmount}</code>
│ 💳 <b>Saldo Baru:</b> <code>Rp ${formattedNewSaldo}</code>
└─────────────────────
                `;
                
                // Kirim notifikasi ke user jika saldo berubah
                const userMsg = `
✅ <b>Saldo Anda telah diperbarui!</b>

📝 <b>Tipe:</b> <code>${actionType}</code>
💵 <b>Nominal:</b> <code>Rp ${formattedAmount}</code>
💳 <b>Saldo Sekarang:</b> <code>Rp ${formattedNewSaldo}</code>

👨‍💼 <i>Perubahan dilakukan oleh Admin</i>
                `;
                
                await sendTelegramMessage(env.BOT_TOKEN, user.id, adminMsg);
                await sendTelegramMessage(env.BOT_TOKEN, parseInt(targetId), userMsg);
                
                clearUserSession(user.id);
                break;
                
            case 'cek_saldo':
                const targetUserId = text.trim();
                
                if (!users[targetUserId]) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>User tidak ditemukan.</b>");
                    clearUserSession(user.id);
                    return;
                }
                
                const userSaldo = users[targetUserId].saldo;
                const formattedUserSaldo = formatNumber(userSaldo);
                const joinDate = new Date(users[targetUserId].joinDate).toLocaleDateString('id-ID');
                
                const saldoMsg = `
💰 <b>Info Saldo User</b>

┌─── 👤 <b>USER INFO</b> ───┐
│ 🆔 <b>User ID:</b> <code>${targetUserId}</code>
│ 📅 <b>Bergabung:</b> <code>${joinDate}</code>
│ 💰 <b>Saldo:</b> <code>Rp ${formattedUserSaldo}</code>
└─────────────────────
                `;
                
                await sendTelegramMessage(env.BOT_TOKEN, user.id, saldoMsg);
                clearUserSession(user.id);
                break;
                
            case 'tambah_akun':
                const step = session.step;
                const data = session.data;
                
                if (step === 'nama') {
                    data.name = text;
                    session.step = 'email';
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "📧 <b>Masukkan email/username:</b>");
                } else if (step === 'email') {
                    data.email = text;
                    session.step = 'password';
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "🔑 <b>Masukkan password:</b>");
                } else if (step === 'password') {
                    data.password = text;
                    session.step = 'harga';
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "💰 <b>Masukkan harga (angka):</b>");
                } else if (step === 'harga') {
                    data.price = parseInt(text);
                    if (isNaN(data.price)) {
                        await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Harga harus berupa angka. Masukkan harga:</b>");
                        return;
                    }
                    session.step = 'deskripsi';
                    const formattedPrice = formatNumber(data.price);
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, `📝 <b>Masukkan deskripsi produk:</b>\n💰 Harga: <code>Rp ${formattedPrice}</code>`);
                } else if (step === 'deskripsi') {
                    data.description = text;
                    session.step = 'catatan';
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "📋 <b>Masukkan catatan produk (misal: detail login/2FA):</b>\nKetik 'tidak ada' jika tidak ada catatan");
                } else if (step === 'catatan') {
                    data.note = text.toLowerCase() !== "tidak ada" ? text : "Tidak ada catatan";
                    
                    // Simpan produk ke database
                    accounts[data.email] = {
                        name: data.name,
                        email: data.email,
                        password: data.password,
                        price: data.price,
                        description: data.description,
                        note: data.note
                    };
                    
                    await saveDB(env.BOT_DB, accounts, 'accounts');
                    
                    const formattedPrice = formatNumber(data.price);
                    
                    const successMsg = `
✅ <b>Produk berhasil ditambahkan!</b>

┌─── 🛒 <b>PRODUK BARU</b> ───┐
│ 🏷️ <b>Nama:</b> <code>${data.name}</code>
│ 📧 <b>Email:</b> <code>${data.email}</code>
│ 🔑 <b>Password:</b> <code>${data.password}</code>
│ 💰 <b>Harga:</b> <code>Rp ${formattedPrice}</code>
│ 📝 <b>Deskripsi:</b> ${data.description}
│ 📋 <b>Catatan:</b> ${data.note}
└─────────────────────
                    `;
                    
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, successMsg);
                    clearUserSession(user.id);
                }
                break;
                
            case 'hapus_akun':
                const emailToDelete = text.trim();
                
                if (accounts[emailToDelete]) {
                    const deletedProduct = accounts[emailToDelete];
                    delete accounts[emailToDelete];
                    await saveDB(env.BOT_DB, accounts, 'accounts');
                    
                    const deleteMsg = `
✅ <b>Produk berhasil dihapus!</b>

🏷️ <b>Nama:</b> <code>${deletedProduct.name}</code>
📧 <b>Email:</b> <code>${emailToDelete}</code>
💰 <b>Harga:</b> <code>Rp ${formatNumber(deletedProduct.price)}</code>
                    `;
                    
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, deleteMsg);
                } else {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Produk tidak ditemukan.</b>");
                }
                clearUserSession(user.id);
                break;

            // ==================== REWARD SETTINGS HANDLERS ====================
            case 'set_deposit_percentage':
                const percentage = parseInt(text);
                if (isNaN(percentage) || percentage < 0 || percentage > 100) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Persentase harus antara 0-100.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.depositBonus.percentage = percentage;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Persentase bonus deposit diubah menjadi ${percentage}%</b>`);
                clearUserSession(user.id);
                break;

            case 'set_deposit_min_amount':
                const minAmount = parseInt(text);
                if (isNaN(minAmount) || minAmount < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal minimal harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.depositBonus.minAmount = minAmount;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Minimal deposit untuk bonus diubah menjadi Rp ${formatNumber(minAmount)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_deposit_max_bonus':
                const maxBonus = parseInt(text);
                if (isNaN(maxBonus) || maxBonus < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal maksimal bonus harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.depositBonus.maxBonus = maxBonus;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Maksimal bonus deposit diubah menjadi Rp ${formatNumber(maxBonus)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_purchase_cashback':
                const cashback = parseInt(text);
                if (isNaN(cashback) || cashback < 0 || cashback > 100) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Persentase cashback harus antara 0-100.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.purchaseBonus.cashback = cashback;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Cashback pembelian diubah menjadi ${cashback}%</b>`);
                clearUserSession(user.id);
                break;

            case 'set_purchase_min_amount':
                const minPurchase = parseInt(text);
                if (isNaN(minPurchase) || minPurchase < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal minimal harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.purchaseBonus.minPurchase = minPurchase;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Minimal pembelian untuk cashback diubah menjadi Rp ${formatNumber(minPurchase)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_referrer_bonus':
                const referrerBonus = parseInt(text);
                if (isNaN(referrerBonus) || referrerBonus < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal bonus harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.referralBonus.bonus = referrerBonus;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Bonus referrer diubah menjadi Rp ${formatNumber(referrerBonus)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_referee_bonus':
                const refereeBonus = parseInt(text);
                if (isNaN(refereeBonus) || refereeBonus < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal bonus harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.referralBonus.bonusReferee = refereeBonus;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Bonus referee diubah menjadi Rp ${formatNumber(refereeBonus)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_achievement_first':
                const firstReward = parseInt(text);
                if (isNaN(firstReward) || firstReward < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal reward harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.achievementRewards.rewards.firstPurchase = firstReward;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Reward first purchase diubah menjadi Rp ${formatNumber(firstReward)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_achievement_five':
                const fiveReward = parseInt(text);
                if (isNaN(fiveReward) || fiveReward < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal reward harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.achievementRewards.rewards.fivePurchases = fiveReward;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Reward 5 purchases diubah menjadi Rp ${formatNumber(fiveReward)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_achievement_ten':
                const tenReward = parseInt(text);
                if (isNaN(tenReward) || tenReward < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal reward harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.achievementRewards.rewards.tenPurchases = tenReward;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Reward 10 purchases diubah menjadi Rp ${formatNumber(tenReward)}</b>`);
                clearUserSession(user.id);
                break;

            case 'set_achievement_big':
                const bigReward = parseInt(text);
                if (isNaN(bigReward) || bigReward < 0) {
                    await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Nominal reward harus angka positif.</b>");
                    clearUserSession(user.id);
                    return;
                }
                settings.achievementRewards.rewards.bigSpender = bigReward;
                await saveRewardSettings(env.BOT_DB, settings);
                await sendTelegramMessage(env.BOT_TOKEN, user.id, `✅ <b>Reward big spender diubah menjadi Rp ${formatNumber(bigReward)}</b>`);
                clearUserSession(user.id);
                break;
                
            default:
                await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Session tidak valid.</b>");
                clearUserSession(user.id);
                break;
        }
    } catch (error) {
        console.error('Error processing admin message:', error);
        await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Terjadi kesalahan saat memproses perintah.</b>");
        clearUserSession(user.id);
    }
}

// ==================== HANDLE BROADCAST COMMAND ====================
async function handleBroadcast(update, env) {
    const message = update.message;
    const user = message.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        const responseMessage = `
❌ <b>Akses Ditolak!</b>

Anda tidak memiliki akses ke perintah ini.
        `;
        return await sendTelegramMessage(env.BOT_TOKEN, user.id, responseMessage);
    }
    
    if (!message.reply_to_message) {
        const responseMessage = `
⚠️ <b>Perintah Tidak Lengkap!</b>

Silakan balas pesan yang ingin di-broadcast dengan perintah <code>/broadcast</code>, atau tambahkan ID spesifik dengan format <code>/broadcast id1,id2,...</code> di balasan.
        `;
        return await sendTelegramMessage(env.BOT_TOKEN, user.id, responseMessage);
    }
    
    const replyMessage = message.reply_to_message;
    const specificIds = message.text.split(' ')[1]?.split(',').filter(id => id.trim()) || [];
    
    const users = await loadDB(env.BOT_DB, 'users');
    const targetUsers = specificIds.length > 0 ? specificIds : Object.keys(users);
    const targetType = specificIds.length > 0 ? "ID tertentu" : "semua pengguna";
    
    let successCount = 0;
    let failedCount = 0;
    
    // Kirim broadcast ke setiap user
    for (const targetId of targetUsers) {
        try {
            if (replyMessage.text) {
                await sendTelegramMessage(env.BOT_TOKEN, parseInt(targetId), replyMessage.text);
            } else {
                // Untuk tipe media lain, kirim pesan teks sederhana
                await sendTelegramMessage(env.BOT_TOKEN, parseInt(targetId), "📢 <b>Pesan Broadcast dari Admin</b>\n\nHubungi admin untuk informasi lebih lanjut.");
            }
            successCount++;
        } catch (error) {
            failedCount++;
        }
        
        // Tunggu sebentar untuk menghindari rate limit
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const resultMessage = `
🎉 <b>Broadcast Selesai!</b>

📍 Target: <b>${targetType}</b>
✅ <b>Berhasil terkirim:</b> <code>${successCount}</code>
❌ <b>Gagal terkirim:</b> <code>${failedCount}</code>

Terima kasih telah menggunakan bot ini! 😊
    `;
    
    await sendTelegramMessage(env.BOT_TOKEN, user.id, resultMessage);
}

// ==================== HANDLE BELI AKUN CALLBACK ====================
async function handleBeliAkunCallback(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    
    if (Object.keys(accounts).length === 0) {
        const message = `
⚠️ <b>Maaf, saat ini item tidak tersedia.</b>  
Silakan cek kembali nanti! 🙏
        `;
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message);
    }
    
    const groupedAccounts = {};
    for (const [email, akun] of Object.entries(accounts)) {
        const key = `${akun.name}_${akun.price}`;
        if (!groupedAccounts[key]) {
            groupedAccounts[key] = [];
        }
        groupedAccounts[key].push(email);
    }
    
    const keyboardButtons = Object.entries(groupedAccounts).map(([key, emails]) => {
        const [name, price] = key.split('_');
        const count = emails.length;
        const formattedPrice = formatNumber(parseInt(price));
        return [{
            text: `${name} - Rp ${formattedPrice} (${count})`,
            callback_data: `group_${name}_${price}`
        }];
    });
    
    // Tambahkan tombol kembali
    keyboardButtons.push([{ text: "🔙 Kembali", callback_data: "back_to_main" }]);
    
    const keyboard = {
        inline_keyboard: keyboardButtons
    };
    
    const message = `
🛒 <b>Silakan pilih produk yang tersedia:</b>

📋 <b>Total produk:</b> <code>${Object.keys(accounts).length}</code>

Klik produk untuk melihat detail:
    `;
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE DEPOSIT CALLBACK ====================
async function handleDepositCallback(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    // ⚡ RESET STATE sebelum memulai deposit baru
    clearUserSession(user.id);
    
    // Cek apakah ada deposit pending di database
    const pendingPayment = await getPendingPayment(env.BOT_DB, user.id);
    if (pendingPayment) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "⚠️ Anda masih memiliki deposit yang belum selesai. Silakan selesaikan atau batalkan deposit sebelumnya.", true);
        return;
    }
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    
    const minAmount = parseInt(env.MIN_AMOUNT) || 1000;
    const formattedMinAmount = formatNumber(minAmount);
    
    const message = `
💰 <b>Deposit Saldo</b>

Masukkan nominal deposit:

💰 <b>Minimal deposit:</b> <code>Rp ${formattedMinAmount}</code>

Silakan ketik jumlah saldo yang ingin Anda deposit:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "back_to_main" }]
        ]
    };
    
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE BACK TO MAIN ====================
async function handleBackToMain(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id.toString();
    
    // ⚡ RESET STATE USER ketika kembali ke menu utama
    clearUserSession(userId);
    
    const username = user.username || "Tidak Ada";
    
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    
    const saldo = users[userId].saldo;
    const formattedSaldo = formatNumber(saldo);
    const stok = Object.keys(accounts).length;
    
    const adminUsername = env.ADMIN_USERNAME || "@admin";

    const message = `
🎊 <b>Selamat Datang di Bot Premium Store!</b>

┌─── 📊 <b>INFO AKUN</b> ───┐
│ 👤 <b>User ID:</b> <code>${userId}</code>
│ 📝 <b>Username:</b> <code>@${username}</code>
│ 💰 <b>Saldo:</b> <code>Rp ${formattedSaldo}</code>
│ 📦 <b>Stok Tersedia:</b> <code>${stok} produk</code>
└─────────────────────

👨‍💼 <b>Admin:</b> ${adminUsername}

<code>================================</code>

✨ <b>Fitur Unggulan:</b>
• 🛒 Beli Akun Premium Otomatis
• 💳 Deposit Instant QRIS
• 🏆 Sistem Achievement
• 📊 Riwayat Transaksi
• ⚡ Proses Cepat & Aman

Pilih menu di bawah untuk memulai:
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🛒 Beli Akun", callback_data: "beli_akun" },
                { text: "💳 Deposit", callback_data: "deposit" }
            ],
            [
                { text: "📊 Riwayat", callback_data: "riwayat" },
                { text: "🏆 Pencapaian", callback_data: "achievements" }
            ],
            [
                { text: "ℹ️ Bantuan", callback_data: "help" },
                { text: "👤 Profile", callback_data: "profile" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

// ==================== HANDLE BACK TO ADMIN ====================
async function handleBackToAdmin(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    
    if (user.id.toString() !== env.ADMIN_ID) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Akses ditolak!", true);
        return;
    }
    
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    const stats = await loadStatistics(env.BOT_DB);
    
    const totalMembers = Object.keys(users).length;
    const totalProducts = Object.keys(accounts).length;
    const totalRevenue = formatNumber(stats.totalRevenue);
    
    const today = new Date().toISOString().split('T')[0];
    const todayStats = stats.dailyStats[today] || { transactions: 0, revenue: 0, users: 0 };
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "💰 Kelola Saldo", callback_data: "admin_saldo" },
                { text: "🛒 Kelola Produk", callback_data: "admin_produk" }
            ],
            [
                { text: "📊 Statistik", callback_data: "admin_stats" },
                { text: "👥 Management User", callback_data: "admin_users" }
            ],
            [
                { text: "🎁 Reward Settings", callback_data: "admin_reward_settings" },
                { text: "⚙️ Settings", callback_data: "admin_settings" }
            ],
            [
                { text: "🔔 Broadcast", callback_data: "admin_broadcast" }
            ]
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
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, adminMessage, keyboard);
}

// ==================== HANDLE CALLBACK QUERY UTAMA ====================
async function handleCallbackQuery(update, env) {
    const callbackQuery = update.callback_query;
    const callbackData = callbackQuery.data;
    const user = callbackQuery.from;
    
    console.log('Callback data received:', callbackData);
    
    // Handle semua callback data
    switch (callbackData) {
        // User menus
        case 'profile':
            return new Response(JSON.stringify(await handleProfile(update, env)));
        case 'riwayat':
            return new Response(JSON.stringify(await handleRiwayat(update, env)));
        case 'full_riwayat':
            return new Response(JSON.stringify(await handleFullRiwayat(update, env)));
        case 'achievements':
            return new Response(JSON.stringify(await handleAchievements(update, env)));
        case 'help':
            return new Response(JSON.stringify(await handleHelp(update, env)));
        case 'beli_akun':
            return new Response(JSON.stringify(await handleBeliAkunCallback(update, env)));
        case 'deposit':
            return new Response(JSON.stringify(await handleDepositCallback(update, env)));
        case 'back_to_main':
            return new Response(JSON.stringify(await handleBackToMain(update, env)));
            
        // Admin menus
        case 'admin_saldo':
            return new Response(JSON.stringify(await handleAdminSaldo(update, env)));
        case 'admin_produk':
            return new Response(JSON.stringify(await handleAdminProduk(update, env)));
        case 'admin_stats':
            return new Response(JSON.stringify(await handleAdminStats(update, env)));
        case 'admin_users':
            return new Response(JSON.stringify(await handleAdminUsers(update, env)));
        case 'admin_settings':
            return new Response(JSON.stringify(await handleAdminSettings(update, env)));
        case 'admin_reward_settings':
            return new Response(JSON.stringify(await handleAdminRewardSettings(update, env)));
        case 'admin_broadcast':
            return new Response(JSON.stringify(await handleAdminBroadcast(update, env)));
        case 'back_to_admin':
            return new Response(JSON.stringify(await handleBackToAdmin(update, env)));
            
        // Admin sub-menus
        case 'admin_tambah_saldo':
            return new Response(JSON.stringify(await handleAdminTambahSaldo(update, env)));
        case 'admin_kurangi_saldo':
            return new Response(JSON.stringify(await handleAdminKurangiSaldo(update, env)));
        case 'admin_cek_saldo':
            return new Response(JSON.stringify(await handleAdminCekSaldo(update, env)));
        case 'admin_tambah_akun':
            return new Response(JSON.stringify(await handleAdminTambahAkun(update, env)));
        case 'admin_hapus_akun':
            return new Response(JSON.stringify(await handleAdminHapusAkun(update, env)));
        case 'admin_list_akun':
            return new Response(JSON.stringify(await handleAdminListAkun(update, env)));
        case 'admin_list_users':
            return new Response(JSON.stringify(await handleAdminListUsers(update, env)));
        case 'admin_manual_topup':
            return new Response(JSON.stringify(await handleAdminManualTopup(update, env)));
        case 'admin_cleanup':
            return new Response(JSON.stringify(await handleAdminCleanup(update, env)));
        case 'admin_cleanup_pending':
            return new Response(JSON.stringify(await handleAdminCleanupPending(update, env)));
        case 'admin_cleanup_transactions':
            return new Response(JSON.stringify(await handleAdminCleanupTransactions(update, env)));
        case 'admin_cleanup_users':
            return new Response(JSON.stringify(await handleAdminCleanupUsers(update, env)));
        case 'admin_pending':
            return new Response(JSON.stringify(await handleAdminPending(update, env)));
            
        // Reward settings
        case 'reward_toggle_system':
            return new Response(JSON.stringify(await handleRewardToggleSystem(update, env)));
        case 'reward_setting_deposit':
            return new Response(JSON.stringify(await handleRewardSettingDeposit(update, env)));
        case 'reward_toggle_deposit':
            return new Response(JSON.stringify(await handleRewardToggleDeposit(update, env)));
        case 'reward_set_deposit_percentage':
            return new Response(JSON.stringify(await handleRewardSetDepositPercentage(update, env)));
        case 'reward_set_deposit_min':
            return new Response(JSON.stringify(await handleRewardSetDepositMin(update, env)));
        case 'reward_set_deposit_max':
            return new Response(JSON.stringify(await handleRewardSetDepositMax(update, env)));
        case 'reward_setting_purchase':
            return new Response(JSON.stringify(await handleRewardSettingPurchase(update, env)));
        case 'reward_toggle_purchase':
            return new Response(JSON.stringify(await handleRewardTogglePurchase(update, env)));
        case 'reward_set_purchase_cashback':
            return new Response(JSON.stringify(await handleRewardSetPurchaseCashback(update, env)));
        case 'reward_set_purchase_min':
            return new Response(JSON.stringify(await handleRewardSetPurchaseMin(update, env)));
        case 'reward_setting_referral':
            return new Response(JSON.stringify(await handleRewardSettingReferral(update, env)));
        case 'reward_toggle_referral':
            return new Response(JSON.stringify(await handleRewardToggleReferral(update, env)));
        case 'reward_set_referrer_bonus':
            return new Response(JSON.stringify(await handleRewardSetReferrerBonus(update, env)));
        case 'reward_set_referee_bonus':
            return new Response(JSON.stringify(await handleRewardSetRefereeBonus(update, env)));
        case 'reward_setting_achievement':
            return new Response(JSON.stringify(await handleRewardSettingAchievement(update, env)));
        case 'reward_toggle_achievement':
            return new Response(JSON.stringify(await handleRewardToggleAchievement(update, env)));
        case 'reward_set_achievement_first':
            return new Response(JSON.stringify(await handleRewardSetAchievementFirst(update, env)));
        case 'reward_set_achievement_five':
            return new Response(JSON.stringify(await handleRewardSetAchievementFive(update, env)));
        case 'reward_set_achievement_ten':
            return new Response(JSON.stringify(await handleRewardSetAchievementTen(update, env)));
        case 'reward_set_achievement_big':
            return new Response(JSON.stringify(await handleRewardSetAchievementBig(update, env)));
            
        // Fallback untuk callback yang belum dihandle
        default:
            if (callbackData.startsWith('group_')) {
                return new Response(JSON.stringify(await handleDetailAkun(update, env)));
            } else if (callbackData.startsWith('beli_')) {
                return new Response(JSON.stringify(await handleProsesPembelian(update, env)));
            } else if (callbackData.startsWith('confirm_payment_')) {
                return new Response(JSON.stringify(await handleConfirmPayment(update, env)));
            } else if (callbackData === 'cancel_payment') {
                return new Response(JSON.stringify(await handleCancelPayment(update, env)));
            } else {
                await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "⚠️ Fitur sedang dalam pengembangan", true);
                return new Response('OK');
            }
    }
}

// ==================== FUNGSI YANG SUDAH ADA ====================
async function handleGetId(update, env) {
    const user = update.message.from;
    const userId = user.id;
    const username = user.username;
    
    let message;
    if (username) {
        message = `
🆔 <b>Informasi Akun Anda:</b>
📄 <b>ID Pengguna:</b> <code>${userId}</code>
👤 <b>Username:</b> <code>@${username}</code>

Terima kasih telah menggunakan bot ini! 😊
        `;
    } else {
        message = `
🆔 <b>Informasi Akun Anda:</b>
📄 <b>ID Pengguna:</b> <code>${userId}</code>
👤 <b>Username:</b> <i>(not found)</i>

Terima kasih telah menggunakan bot ini! 😊
        `;
    }
    
    return await sendTelegramMessage(env.BOT_TOKEN, userId, message);
}

async function handleDetailAkun(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const callbackData = callbackQuery.data;
    
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    
    const [, name, price] = callbackData.split('_');
    const priceInt = parseInt(price);
    
    const filteredAccounts = Object.entries(accounts).filter(([email, akun]) => 
        akun.name === name && akun.price === priceInt
    );
    
    if (filteredAccounts.length === 0) {
        const message = `
❌ <b>Akun yang dipilih tidak tersedia.</b>  
Silakan pilih akun lain dari daftar yang tersedia.
        `;
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message);
    }
    
    const randomIndex = Math.floor(Math.random() * filteredAccounts.length);
    const [email, akun] = filteredAccounts[randomIndex];
    const formattedPrice = formatNumber(akun.price);
    
    const message = `
<b>Detail Produk</b>

<b>Nama:</b> <code>${akun.name}</code>
<b>Harga:</b> <code>Rp ${formattedPrice}</code>
<b>Deskripsi Produk:</b>  
${akun.description}

❓ <b>Apakah Anda ingin membeli produk ini?</b>
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ Iya", callback_data: `beli_${email}` },
                { text: "❌ Tidak", callback_data: "beli_akun" }
            ]
        ]
    };
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message, keyboard);
}

async function handleProsesPembelian(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id.toString();
    const callbackData = callbackQuery.data;
    
    const users = await loadDB(env.BOT_DB, 'users');
    const accounts = await loadDB(env.BOT_DB, 'accounts');
    
    const email = callbackData.split('_')[1];
    
    if (!accounts[email]) {
        const message = "<b>⚠️ Akun yang dipilih tidak tersedia.</b>";
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message);
    }
    
    const akun = accounts[email];
    const harga = akun.price;
    
    if (!users[userId]) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "⚠️ Anda belum terdaftar!", true);
        return;
    }
    
    const saldo = users[userId].saldo;
    if (saldo < harga) {
        const message = `
<b>💰 Saldo Anda tidak cukup untuk pembelian ini.</b>

Saldo saat ini: <code>Rp ${formatNumber(saldo)}</code>
Dibutuhkan: <code>Rp ${formatNumber(harga)}</code>
Kekurangan: <code>Rp ${formatNumber(harga - saldo)}</code>

Silakan deposit terlebih dahulu.
        `;
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
        return await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, message);
    }
    
    // Proses pembelian dengan cashback
    const purchaseResult = await processPurchaseWithCashback(env, userId, akun.name, harga);
    
    // Hapus akun dari database
    delete accounts[email];
    await saveDB(env.BOT_DB, accounts, 'accounts');
    
    const formattedPrice = formatNumber(akun.price);
    const currentSaldo = purchaseResult.newBalance;
    const formattedSaldo = formatNumber(currentSaldo);
    
    const akunStr = `
✅ <b>Pembelian Berhasil!</b>

┌─── 📦 <b>DETAIL PRODUK</b> ───┐
│ 🏷️ <b>Nama:</b> <code>${akun.name}</code>
│ 📧 <b>Email/Username:</b> <code>${akun.email}</code>
│ 🔑 <b>Password:</b> <code>${akun.password}</code>
│ 💰 <b>Harga:</b> <code>Rp ${formattedPrice}</code>
└─────────────────────

📝 <b>Catatan Produk:</b>
${akun.note || 'Tidak ada catatan'}

┌─── 💰 <b>INFO SALDO</b> ───┐
│ 💳 <b>Saldo Sekarang:</b> <code>Rp ${formattedSaldo}</code>
│ 📊 <b>Total Pembelian:</b> <code>${users[userId].purchaseCount || 1}x</code>
└─────────────────────

💡 <i>Simpan informasi akun dengan baik!</i>
    `;
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id);
    await editMessageText(env.BOT_TOKEN, user.id, callbackQuery.message.message_id, akunStr);
    
    // Kirim notifikasi cashback jika ada
    if (purchaseResult.cashback > 0) {
        const cashbackMessage = `
🎁 <b>Anda mendapatkan cashback!</b>

💰 <b>Cashback:</b> <code>Rp ${formatNumber(purchaseResult.cashback)}</code>
💳 <b>Saldo setelah cashback:</b> <code>Rp ${formattedSaldo}</code>
        `;
        await sendTelegramMessage(env.BOT_TOKEN, user.id, cashbackMessage);
    }
    
    // Kirim notifikasi ke admin
    const username = user.username || "null";
    const adminMessage = `
📦 <b>Notifikasi Pembelian Baru</b>

┌─── 👤 <b>PEMBELI</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📝 <b>Username:</b> <code>@${username}</code>
└─────────────────────

┌─── 🛒 <b>PRODUK</b> ───┐
│ 🏷️ <b>Nama:</b> <code>${akun.name}</code>
│ 📧 <b>Email:</b> <code>${akun.email}</code>
│ 💰 <b>Harga:</b> <code>Rp ${formattedPrice}</code>
└─────────────────────

┌─── 💰 <b>SALDO</b> ───┐
│ 💳 <b>Saldo Setelah:</b> <code>Rp ${formattedSaldo}</code>
│ 📊 <b>Total Transaksi:</b> <code>${users[userId].purchaseCount || 1}</code>
└─────────────────────
    `;
    
    await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, adminMessage);
}

// ==================== FUNGSI DEPOSIT ====================
async function handleDepositMessage(update, env) {
    const message = update.message;
    const user = message.from;
    const text = message.text;
    
    // ⚡ RESET STATE jika user mengirim perintah start atau kembali
    if (text.startsWith('/start') || text === '🔙 Kembali') {
        clearUserSession(user.id);
        return;
    }
    
    // Cek apakah ada deposit pending di database
    const pendingPayment = await getPendingPayment(env.BOT_DB, user.id);
    if (pendingPayment) {
        const responseMessage = `
⚠️ <b>Anda masih memiliki deposit yang belum selesai.</b>

Silakan selesaikan atau batalkan deposit sebelumnya sebelum melakukan deposit baru.
        `;
        return await sendTelegramMessage(env.BOT_TOKEN, user.id, responseMessage);
    }
    
    try {
        const nominal = parseInt(text);
        const minAmount = parseInt(env.MIN_AMOUNT) || 1000;
        
        if (isNaN(nominal) || nominal <= 0) {
            throw new Error("Nominal tidak valid");
        }
        
        if (nominal < minAmount) {
            const formattedMinAmount = formatNumber(minAmount);
            const responseMessage = `⚠️ <b>Nominal deposit minimal Rp ${formattedMinAmount}.</b>`;
            return await sendTelegramMessage(env.BOT_TOKEN, user.id, responseMessage);
        }
        
        // Buat QRIS dan konfirmasi
        await createQrisAndConfirm(env, user, nominal);
        
    } catch (error) {
        const responseMessage = "⚠️ <b>Nominal tidak valid. Harap masukkan angka.</b>";
        return await sendTelegramMessage(env.BOT_TOKEN, user.id, responseMessage);
    }
}

async 
async function createQrisAndConfirm(env, user, nominal) {
    const randomAddition = getRandomAmount(env);
    const finalNominal = nominal + randomAddition;

    try {
        const apiKey = env.PAYMENT_API_KEY || env.API_KEY || '';
        const url = `${env.API_CREATE_URL}?amount=${finalNominal}&apikey=${apiKey}`;
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) throw new Error('Gagal membuat QRIS (HTTP ' + response.status + ')');

        const data = await response.json();
        if (!data || data.status !== 'success' || !data.data) throw new Error('Response API tidak valid');

        const qrisUrl = data.data.qris_url;
        const transactionId = data.data.transaction_id;
        const totalAmount = data.data.total_amount || finalNominal;
        const fee = data.data.fee || 0;
        const expiredMinutes = data.data.expired_minutes || 10;

        if (!qrisUrl || !transactionId) throw new Error('QRIS atau transaction_id tidak ditemukan');

        const paymentData = {
            nominal, finalNominal: totalAmount, transactionId,
            timestamp: new Date().toISOString(), status: 'pending',
            messageId: null, expired_minutes: expiredMinutes, fee
        };
        await savePendingPayment(env.BOT_DB, user.id.toString(), paymentData);

        const keyboard = {
            inline_keyboard: [
                [{ text: "✅ Konfirmasi Pembayaran", callback_data: `confirm_payment_${transactionId}` }],
                [{ text: "❌ Batalkan", callback_data: "cancel_payment" }]
            ]
        };

        const caption = `💳 <b>Silahkan Scan QRIS</b>

` +
            `💰 Nominal: Rp ${formatNumber(nominal)}
` +
            `➕ Fee: Rp ${formatNumber(fee)}
` +
            `🔢 Total: <b>Rp ${formatNumber(totalAmount)}</b>

` +
            `⌛ Berlaku ±${expiredMinutes} Menit`;

        const sent = await sendTelegramPhoto(env.BOT_TOKEN, user.id, qrisUrl, caption, keyboard);
        if (sent?.ok && sent.result?.message_id) {
            paymentData.messageId = sent.result.message_id;
            await savePendingPayment(env.BOT_DB, user.id.toString(), paymentData);
        }
    } catch (error) {
        await sendTelegramMessage(env.BOT_TOKEN, user.id, `❌ Error saat membuat pembayaran: ${error.message}`);
    }
}

                    ]
                ]
            };
            
            const caption = `
💰 <b>Top Up Pending</b>

┌─── 📋 <b>DETAIL TRANSAKSI</b> ───┐
│ 🆔 <b>ID Transaksi:</b> <code>${transactionId}</code>
│ 💰 <b>Nominal:</b> <code>Rp ${formattedNominal}</code>
│ 📊 <b>Fee Random:</b> <code>Rp ${randomAddition}</code>
│ 💳 <b>Total Bayar:</b> <code>Rp ${formattedFinal}</code>
│ ⏰ <b>Expired:</b> <code>10 menit</code>
└─────────────────────

💡 <b>Instruksi:</b>
1. Scan QRIS di atas untuk pembayaran
2. Setelah bayar, klik "Konfirmasi Pembayaran"
3. Saldo akan otomatis ditambahkan

⚠️ <i>Transaksi akan expired dalam 10 menit</i>
            `;
            
            // Kirim photo QRIS dan simpan message ID
            const sentMessage = await sendTelegramPhoto(env.BOT_TOKEN, user.id, qrisUrl, caption, keyboard);
            if (sentMessage && sentMessage.ok) {
                // Update payment data dengan message ID
                paymentData.messageId = sentMessage.result.message_id;
                await savePendingPayment(env.BOT_DB, user.id, paymentData);
            }
            
            // Add pending transaction
            await addTransaction(env.BOT_DB, user.id.toString(), 'deposit_pending', {
                amount: nominal,
                productName: 'Deposit'
            });
            
            // Kirim notifikasi ke admin
            const adminMessage = `
⏳ <b>Pembayaran Pending</b>

┌─── 👤 <b>USER</b> ───┐
│ 🆔 <b>User ID:</b> <code>${user.id}</code>
│ 📝 <b>Username:</b> <code>@${user.username || 'N/A'}</code>
└─────────────────────

┌─── 💰 <b>TRANSAKSI</b> ───┐
│ 🆔 <b>ID Transaksi:</b> <code>${transactionId}</code>
│ 💰 <b>Nominal:</b> <code>Rp ${formattedNominal}</code>
│ 📊 <b>Fee Random:</b> <code>Rp ${randomAddition}</code>
│ 💳 <b>Total Bayar:</b> <code>Rp ${formattedFinal}</code>
└─────────────────────
            `;
            
            await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, adminMessage);
        } else {
            await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Gagal membuat QRIS. Silakan coba lagi.</b>");
        }
    } catch (error) {
        console.error('Error creating QRIS:', error);
        await sendTelegramMessage(env.BOT_TOKEN, user.id, "❌ <b>Terjadi kesalahan saat membuat QRIS. Silakan coba lagi.</b>");
    }
}

async 
async function handleConfirmPayment(update, env) {
    const callbackQuery = update.callback_query;
    const userId = callbackQuery.from.id.toString();

    const pending = await getPendingPayment(env.BOT_DB, userId);
    if (!pending) {
        return answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Tidak ada pembayaran pending", true);
    }

    const apiKey = env.PAYMENT_API_KEY;
    const url = `${env.API_CHECK_PAYMENT}?transaction_id=${pending.transactionId}&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data?.paid === true) {
        const result = await processDepositWithBonus(env, userId, pending.nominal, pending.transactionId);
        await removePendingPayment(env.BOT_DB, userId);
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "✅ Pembayaran berhasil!", true);
        return sendTelegramMessage(env.BOT_TOKEN, userId, `✅ Deposit Berhasil!

💰+Rp ${formatNumber(result.totalCredit)}
💳 Saldo: Rp ${formatNumber(result.newBalance)}`);
    }

    return answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "⏳ Belum dibayar. Coba lagi sebentar.", true);
}

    
    const transactionId = callbackData.split('_')[2];
    
    // Pastikan transaction_id sesuai
    if (paymentData.transactionId !== transactionId) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ ID transaksi tidak sesuai.", true);
        return;
    }
    
    // Cek apakah pembayaran sudah expired
    const now = new Date();
    const paymentTime = new Date(paymentData.timestamp);
    const diffMinutes = (now - paymentTime) / (1000 * 60);
    
    if (diffMinutes > 10) {
        await removePendingPayment(env.BOT_DB, userId);
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Pembayaran telah expired. Silakan buat deposit baru.", true);
        
        // Update pesan
        const expiredCaption = `
❌ <b>Pembayaran Expired</b>

🆔 <b>ID Transaksi:</b> <code>${transactionId}</code>

Pembayaran telah expired. Silakan buat deposit baru.
        `;
        
        if (paymentData.messageId) {
            await editMessageCaption(env.BOT_TOKEN, user.id, paymentData.messageId, expiredCaption);
        }
        return;
    }
    
    // Cek pembayaran via API
    try {
        const response = await fetch(`${env.API_CHECK_PAYMENT}?merchant=${env.MERCHANT_ID}&key=${env.API_KEY}`);
        if (response.ok) {
            const data = await response.json();
            
            if (data.status === "success") {
                const payments = data.data || [];
                let paymentFound = false;
                
                for (const payment of payments) {
                    if (payment && typeof payment === 'object' && payment.amount === paymentData.finalNominal) {
                        paymentFound = true;
                        break;
                    }
                }
                
                if (paymentFound) {
                    // Pembayaran ditemukan, proses deposit dengan bonus
                    const depositResult = await processDepositWithBonus(env, userId, paymentData.nominal, transactionId);
                    
                    // Hapus dari pending payments di database
                    await removePendingPayment(env.BOT_DB, userId);
                    
                    const formattedNominal = formatNumber(paymentData.nominal);
                    const formattedBonus = formatNumber(depositResult.bonus);
                    const formattedSaldo = formatNumber(depositResult.newBalance);
                    
                    // Edit pesan asli
                    const newCaption = `
✅ <b>Pembayaran Berhasil Dikonfirmasi!</b>

┌─── 💰 <b>DETAIL DEPOSIT</b> ───┐
│ 🆔 <b>ID Transaksi:</b> <code>${transactionId}</code>
│ 💰 <b>Nominal:</b> <code>Rp ${formattedNominal}</code>
│ 🎁 <b>Bonus Deposit:</b> <code>Rp ${formattedBonus}</code>
│ 💳 <b>Saldo Sekarang:</b> <code>Rp ${formattedSaldo}</code>
└─────────────────────

🎉 <b>Terima kasih telah melakukan top-up!</b>

💡 <i>Gunakan saldo untuk membeli produk premium</i>
                    `;
                    
                    if (paymentData.messageId) {
                        await editMessageCaption(
                            env.BOT_TOKEN,
                            user.id,
                            paymentData.messageId,
                            newCaption
                        );
                    }
                    
                    // Kirim notifikasi bonus jika ada
                    if (depositResult.bonus > 0) {
                        const bonusMessage = `
🎁 <b>Anda mendapatkan bonus deposit!</b>

💰 <b>Bonus:</b> <code>Rp ${formattedBonus}</code>
💳 <b>Total yang ditambahkan:</b> <code>Rp ${formatNumber(depositResult.totalCredit)}</code>
                        `;
                        await sendTelegramMessage(env.BOT_TOKEN, user.id, bonusMessage);
                    }
                    
                    // Kirim notifikasi ke admin
                    const adminMessage = `
✅ <b>Pembayaran Dikonfirmasi</b>

┌─── 👤 <b>USER</b> ───┐
│ 🆔 <b>User ID:</b> <code>${userId}</code>
│ 📝 <b>Username:</b> <code>@${user.username || 'null'}</code>
└─────────────────────

┌─── 💰 <b>TRANSAKSI</b> ───┐
│ 🆔 <b>ID Transaksi:</b> <code>${transactionId}</code>
│ 💰 <b>Nominal:</b> <code>Rp ${formattedNominal}</code>
│ 🎁 <b>Bonus:</b> <code>Rp ${formattedBonus}</code>
│ 💳 <b>Saldo Baru:</b> <code>Rp ${formattedSaldo}</code>
└─────────────────────
                    `;
                    
                    await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, adminMessage);
                    
                    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "✅ Pembayaran berhasil dikonfirmasi! Saldo telah ditambahkan.", true);
                } else {
                    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "⚠️ Pembayaran belum terdeteksi. Silakan tunggu beberapa menit atau hubungi admin jika sudah melakukan pembayaran.", true);
                }
            } else {
                await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Gagal memeriksa pembayaran. Silakan coba lagi.", true);
            }
        } else {
            await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Gagal terhubung ke sistem pembayaran. Silakan coba lagi.", true);
        }
    } catch (error) {
        console.error('Error checking payment:', error);
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, `❌ Terjadi kesalahan: ${error.message}`, true);
    }
}

async function handleCancelPayment(update, env) {
    const callbackQuery = update.callback_query;
    const user = callbackQuery.from;
    const userId = user.id;
    
    // Cek apakah ada pembayaran pending di database
    const paymentData = await getPendingPayment(env.BOT_DB, userId);
    if (!paymentData) {
        await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Tidak ada deposit yang pending.", true);
        return;
    }
    
    // Hapus dari pending payments di database
    const transactionId = paymentData.transactionId;
    await removePendingPayment(env.BOT_DB, userId);
    
    // Edit pesan asli
    const newCaption = `
❌ <b>Pembayaran Dibatalkan</b>

🆔 <b>ID Transaksi:</b> <code>${transactionId}</code>

Pembayaran telah dibatalkan. Anda dapat melakukan deposit kembali kapan saja.
    `;
    
    if (paymentData.messageId) {
        await editMessageCaption(
            env.BOT_TOKEN,
            user.id,
            paymentData.messageId,
            newCaption
        );
    }
    
    // Kirim notifikasi ke admin
    const adminMessage = `
❌ <b>Pembayaran Dibatalkan</b>
<b>Username:</b> <code>@${user.username || 'null'}</code>
<b>User ID:</b> <code>${userId}</code>
<b>Id Transaksi:</b> <code>${transactionId}</code>
    `;
    
    await sendTelegramMessage(env.BOT_TOKEN, env.ADMIN_ID, adminMessage);
    
    await answerCallbackQuery(env.BOT_TOKEN, callbackQuery.id, "❌ Pembayaran telah dibatalkan.", true);
}

// ==================== CLEANUP EXPIRED PAYMENTS ====================
async function cleanupExpiredPayments(env) {
    try {
        const pendingPayments = await loadPendingPayments(env.BOT_DB);
        const now = new Date();
        let cleanedCount = 0;
        
        for (const [userId, payment] of Object.entries(pendingPayments)) {
            const paymentTime = new Date(payment.timestamp);
            const diffMinutes = (now - paymentTime) / (1000 * 60);
            
            if (diffMinutes > 10) {
                // Kirim notifikasi expired ke user
                const expiredCaption = `
❌ <b>Pembayaran Expired</b>

🆔 <b>ID Transaksi:</b> <code>${payment.transactionId}</code>

Pembayaran telah expired. Silakan buat deposit baru.
                `;
                
                if (payment.messageId) {
                    try {
                        await editMessageCaption(env.BOT_TOKEN, parseInt(userId), payment.messageId, expiredCaption);
                    } catch (error) {
                        console.log('Message already deleted or inaccessible');
                    }
                }
                
                // Hapus dari database
                await removePendingPayment(env.BOT_DB, parseInt(userId));
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} expired payments`);
        }
    } catch (error) {
        console.error('Error cleaning up expired payments:', error);
    }
}

// ==================== SCHEDULED CLEANUP ====================
async function handleScheduledCleanup(env) {
    console.log('Running scheduled cleanup...');
    
    try {
        // Cleanup expired payments
        await cleanupExpiredPayments(env);
        
        // Cleanup old transactions (keep only last 50 per user)
        const transactions = await loadDB(env.BOT_DB, 'transactions') || {};
        let cleanedTransactions = 0;
        
        for (const [userId, userTransactions] of Object.entries(transactions)) {
            if (userTransactions && Array.isArray(userTransactions) && userTransactions.length > 50) {
                transactions[userId] = userTransactions.slice(-50);
                cleanedTransactions += (userTransactions.length - 50);
            }
        }
        
        await saveDB(env.BOT_DB, transactions, 'transactions');
        
        console.log(`Scheduled cleanup completed: ${cleanedTransactions} transactions cleaned`);
        
        return new Response('Cleanup completed');
    } catch (error) {
        console.error('Scheduled cleanup error:', error);
        return new Response('Cleanup error', { status: 500 });
    }
}

// ==================== MAIN ROUTER HANDLER ====================
router.post('/', async (request, env) => {
    try {
        const update = await request.json();
        
        // Cleanup expired payments setiap kali ada request
        await cleanupExpiredPayments(env);
        
        // Handle different types of updates
        if (update.message) {
            const text = update.message.text || '';
            
            if (text.startsWith('/start')) {
                return new Response(JSON.stringify(await handleStart(update, env)));
            } else if (text.startsWith('/id')) {
                return new Response(JSON.stringify(await handleGetId(update, env)));
            } else if (text.startsWith('/admin')) {
                return new Response(JSON.stringify(await handleAdmin(update, env)));
            } else if (text.startsWith('/broadcast')) {
                return new Response(JSON.stringify(await handleBroadcast(update, env)));
            } else if (update.message.text && !text.startsWith('/')) {
                // Handle regular messages
                const user = update.message.from;
                
                // Cek jika admin sedang dalam session
                if (user.id.toString() === env.ADMIN_ID && getUserSession(user.id)) {
                    return new Response(JSON.stringify(await handleAdminMessage(update, env)));
                }
                
                // Handle deposit message untuk user biasa
                return new Response(JSON.stringify(await handleDepositMessage(update, env)));
            }
        } else if (update.callback_query) {
            // Handle semua callback queries
            return new Response(JSON.stringify(await handleCallbackQuery(update, env)));
        }
        
        return new Response('OK');
    } catch (error) {
        console.error('Error handling update:', error);
        return new Response('Error', { status: 500 });
    }
});

router.get('/', () => new Response('Premium Telegram Bot is running! 🚀'));

// Scheduled endpoint untuk cleanup
router.get('/cleanup', async (request, env) => {
    return await handleScheduledCleanup(env);
});

export default {
    fetch: router.handle,
    scheduled: async (event, env, ctx) => {
        ctx.waitUntil(handleScheduledCleanup(env));
    }
};
