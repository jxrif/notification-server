// firebase-notification-server.js
const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- TELEGRAM ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ---------- DISCORD (for /imp messages) ----------
const DISCORD_IMP_WEBHOOK_URL = process.env.DISCORD_IMP_WEBHOOK_URL;
let DISCORD_WEBHOOK_ID = null;
let DISCORD_WEBHOOK_TOKEN = null;

if (DISCORD_IMP_WEBHOOK_URL) {
  const parts = DISCORD_IMP_WEBHOOK_URL.match(/\/webhooks\/(\d+)\/([^\/]+)/);
  if (parts) {
    DISCORD_WEBHOOK_ID = parts[1];
    DISCORD_WEBHOOK_TOKEN = parts[2];
    console.log('✅ Discord webhook parsed successfully (auto-delete enabled).');
  } else {
    console.warn('⚠️ Could not parse Discord webhook URL – auto-delete will not work, but messages will still be sent.');
  }
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ CRITICAL: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set.');
  process.exit(1);
}

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

// ---------- USER CONSTANTS ----------
const USER_FIDHA = 'Fidha';
const USER_JARIF = 'Jarif';
const FIDHA_ALIASES = ['fidha', '7uvfii'];

// ---------- COOLDOWNS ----------
const MESSAGE_COOLDOWN = 3000;
const PRESENCE_COOLDOWN = 5000;
const LOGIN_COOLDOWN = 0;
const DEVICE_NOTIFICATION_COOLDOWN = 30000;

// ---------- STATE ----------
let jarifIsActuallyOffline = true;
let previousFiOnlineState = false;

const processedMessageIds = new Set();
const processedPresenceEvents = new Set();
const processedJarifLoginIds = new Set();
const processedImpMessageIds = new Set();
const lastDeviceNotificationTimes = new Map();

let lastMessageNotificationTime = 0;
let lastPresenceNotificationTime = 0;
let lastLoginNotificationTime = 0;

// Cache for Jarif presence (reduces DB reads)
let jarifPresenceCache = { online: false, heartbeat: 0, lastCheck: 0 };
const PRESENCE_CACHE_TTL = 5000;
const JARIF_OFFLINE_THRESHOLD_MS = 60000;

// Catch-up window after downtime
const MESSAGE_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOGIN_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- FIREBASE ----------
const FIREBASE_DATABASE_URL = 'https://ephemeral-chat-three-default-rtdb.firebaseio.com';

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (error) {
  console.error('❌ Cannot parse Firebase service account JSON.');
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL,
});
const db = admin.database();

// ---------- TIME FORMATTERS (Bahrain) ----------
const formatBahrainTime = (ts = Date.now()) =>
  new Date(ts).toLocaleTimeString('en-US', {
    timeZone: 'Asia/Bahrain',
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const formatBahrainDateTime = (ts = Date.now()) =>
  new Date(ts).toLocaleString('en-US', {
    timeZone: 'Asia/Bahrain',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isFidhaSender(message = {}) {
  const candidates = [
    message.sender,
    message.from,
    message.displayName,
    message.userName,
    message.user,
    message.author,
    message.name,
    message.uid,
    message.userId,
  ];

  return candidates.some((value) => {
    const text = normalizeText(value);
    return FIDHA_ALIASES.some((alias) => text.includes(alias));
  });
}

function getMessageTimestamp(message = {}) {
  const candidates = [
    message.timestampFull,
    message.timestamp,
    message.createdAt,
    message.sentAt,
    message.time,
  ];

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
      const dateParsed = Date.parse(value);
      if (Number.isFinite(dateParsed)) return dateParsed;
    }
  }

  return Date.now();
}

function isCommandImp(message = {}) {
  const candidates = [message.text, message.message, message.body, message.content];
  return candidates.some((value) => normalizeText(value).startsWith('/imp'));
}

function rememberId(set, id, limit = 1000, trimTo = 500) {
  if (!id) return;
  set.add(id);
  if (set.size > limit) {
    const arr = Array.from(set);
    set.clear();
    arr.slice(-trimTo).forEach((item) => set.add(item));
  }
}

// ---------- TELEGRAM SEND WITH AUTO-RETRY ON 429 ----------
async function sendTelegramMessage(text, parseMode = 'HTML') {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(TELEGRAM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
        console.warn(`⏸️ Telegram rate limit. Retrying after ${waitSec}s...`);
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Telegram API error (${response.status}): ${errorText}`);
        break;
      }

      console.log('✅ Telegram message sent.');
      return true;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('⏱️ Telegram request timeout.');
      } else {
        console.error(`🔥 Telegram network error: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.error('❌ Failed to send Telegram message after multiple attempts.');
  return false;
}

// ---------- DISCORD PLAIN TEXT SEND (for /imp messages) ----------
async function sendDiscordPlainText(text) {
  if (!DISCORD_IMP_WEBHOOK_URL) {
    console.warn('⚠️ DISCORD_IMP_WEBHOOK_URL not set – skipping Discord notification.');
    return false;
  }

  const payload = {
    content: text,
    allowed_mentions: {
      parse: ['users', 'roles', 'everyone'],
    },
  };

  try {
    const url = new URL(DISCORD_IMP_WEBHOOK_URL);
    url.searchParams.set('wait', 'true');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const raw = await response.text();
    if (!response.ok) {
      console.error(`❌ Discord webhook error (${response.status}): ${raw}`);
      return false;
    }

    let messageId = null;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      messageId = parsed?.id || null;
    } catch {
      messageId = null;
    }

    if (messageId) {
      console.log(`✅ Discord /imp notification sent. Message ID: ${messageId} – will delete in 10 minutes.`);
      setTimeout(() => deleteDiscordMessage(messageId), 10 * 60 * 1000);
    } else {
      console.log('✅ Discord /imp notification sent but no message ID returned (auto-delete not available).');
    }

    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('⏱️ Discord request timeout.');
    } else {
      console.error(`🔥 Discord network error: ${error.message}`);
    }
    return false;
  }
}

async function deleteDiscordMessage(messageId) {
  if (!DISCORD_WEBHOOK_ID || !DISCORD_WEBHOOK_TOKEN) {
    console.warn('⚠️ Discord webhook ID/token missing – cannot delete message.');
    return;
  }

  const url = `https://discord.com/api/webhooks/${DISCORD_WEBHOOK_ID}/${DISCORD_WEBHOOK_TOKEN}/messages/${messageId}`;

  try {
    const response = await fetch(url, { method: 'DELETE' });

    if (response.ok) {
      console.log(`✅ Discord message ${messageId} deleted after 10 minutes.`);
    } else if (response.status === 404) {
      console.log(`ℹ️ Discord message ${messageId} already deleted or not found (nothing to do).`);
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed to delete Discord message ${messageId}: ${response.status} – ${errorText}`);
    }
  } catch (err) {
    console.error(`❌ Error deleting Discord message: ${err.message}`);
  }
}

// ---------- CENTRAL NOTIFICATION DISPATCHER ----------
async function sendNotification(title, description, type = 'info', isJarifLogin = false) {
  const now = Date.now();

  if (type === 'message') {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) return;
    lastMessageNotificationTime = now;
  } else if (type === 'presence') {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) return;
    lastPresenceNotificationTime = now;
  } else if (type === 'login' && !isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) return;
    lastLoginNotificationTime = now;
  }

  const emoji = {
    message: '💬',
    presence: '🟢',
    offline: '🔴',
    login: isJarifLogin ? '🚨' : '🔓',
    block: '🚫',
  }[type] || 'ℹ️';

  const bahrainTime = formatBahrainTime();
  const fullMessage = `${emoji} <b>${title}</b>\n\n${description}\n\n🕒 <i>${bahrainTime} (Bahrain)</i>`;

  await sendTelegramMessage(fullMessage, 'HTML');
}

// ---------- JARIF PRESENCE CHECK ----------
async function checkJarifPresence() {
  const now = Date.now();

  if (now - jarifPresenceCache.lastCheck < PRESENCE_CACHE_TTL) {
    return jarifIsActuallyOffline;
  }

  try {
    const snap = await db.ref(`ephemeral/presence/${USER_JARIF}`).once('value');
    const val = snap.val();

    if (!val) {
      jarifPresenceCache = { online: false, heartbeat: 0, lastCheck: now };
      jarifIsActuallyOffline = true;
      return true;
    }

    const isOnline = val.online === true;
    const heartbeat = typeof val.heartbeat === 'number' ? val.heartbeat : Number(val.heartbeat || 0);

    jarifPresenceCache = { online: isOnline, heartbeat, lastCheck: now };
    jarifIsActuallyOffline = !isOnline || (heartbeat > 0 && now - heartbeat > JARIF_OFFLINE_THRESHOLD_MS);
    return jarifIsActuallyOffline;
  } catch (error) {
    console.error(`❌ checkJarifPresence: ${error.message}`);
    jarifIsActuallyOffline = true;
    return true;
  }
}

// ---------- FIDHA ACTIVITY (ONLINE / OFFLINE) ----------
async function checkActivityForNotification(isActive) {
  await checkJarifPresence();
  if (!jarifIsActuallyOffline) return;

  let settings;
  try {
    const snap = await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).once('value');
    settings = snap.val() || {};
  } catch {
    settings = {};
  }

  const nowOnline = isActive;
  const dateTime = formatBahrainDateTime();

  if (previousFiOnlineState && !nowOnline) {
    if (settings.offlineNotifications !== false) {
      await sendNotification('Fi✨ went offline', `📅 <b>Time:</b> ${dateTime}`, 'offline');
    }
  } else if (!previousFiOnlineState && nowOnline) {
    if (settings.activityNotifications !== false) {
      await sendNotification('Fi✨ is now active', `📅 <b>Time:</b> ${dateTime}`, 'presence');
    }
  }

  previousFiOnlineState = nowOnline;
}

// ---------- FIDHA'S MESSAGES (WHEN JARIF OFFLINE) ----------
async function checkMessageForNotification(message) {
  if (!isFidhaSender(message)) return;

  // Skip if message is already saved/read by Jarif.
  if (
    (message.savedBy && message.savedBy[USER_JARIF]) ||
    (message.readBy && message.readBy[USER_JARIF])
  ) {
    return;
  }

  await checkJarifPresence();
  if (!jarifIsActuallyOffline) return;

  if (processedMessageIds.has(message.id)) return;

  let settings;
  try {
    const snap = await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).once('value');
    settings = snap.val();
  } catch {
    settings = null;
  }

  if (!settings) {
    settings = {
      messageNotifications: true,
      activityNotifications: true,
      offlineNotifications: true,
    };
    await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).set(settings);
  }

  if (settings.messageNotifications === false) return;

  let content;
  if (typeof message.text === 'string' && message.text.trim()) {
    content = message.text.trim();
  } else if (message.attachment) {
    if (message.attachment.isVoiceMessage) content = '🎤 Voice message';
    else if (message.attachment.type?.startsWith('image/')) content = '🖼️ Image';
    else if (message.attachment.type?.startsWith('video/')) content = '🎬 Video';
    else if (message.attachment.type?.startsWith('audio/')) content = '🔊 Audio file';
    else content = `📎 File: ${message.attachment.name || 'Attachment'}`;
  } else {
    content = 'Empty message';
  }

  if (content.length > 1000) content = `${content.slice(0, 1000)}…`;

  const messageTime = getMessageTimestamp(message);
  const dateTime = formatBahrainDateTime(messageTime);

  console.log(`📩 Message notification candidate from ${message.sender || message.from || 'unknown'} at ${dateTime}`);

  await sendNotification(
    '📩 New message from Fi✨',
    `<b>Message:</b> ${content}\n<b>Time:</b> ${dateTime}`,
    'message'
  );

  rememberId(processedMessageIds, message.id);
}

// ---------- /imp message to Discord ----------
async function checkImpMessageForDiscord(message) {
  if (!isCommandImp(message)) return;

  if (processedImpMessageIds.has(message.id)) return;
  rememberId(processedImpMessageIds, message.id);

  console.log(`🚨 /imp message detected (ID: ${message.id}) – sending Discord notification.`);

  const discordText = `<@1481266690410020996> This channel has been set up to receive official Discord announcements for admins and moderators of Public servers. We'll let you know about important updates, such as new moderation features or changes to your server's eligibility for Server Discovery, here.

You can change which channel these messages are sent to at any time inside Server Settings. We recommend choosing a moderators-only channel, as some information may be sensitive to your server.

Thanks for choosing Discord as the place to build your community!`;

  const sent = await sendDiscordPlainText(discordText);
  if (!sent) {
    console.error('❌ /imp Discord notification failed.');
  }
}

// ---------- JARIF LOGIN (IMMEDIATE) ----------
async function checkJarifLoginForNotification(loginData) {
  const deviceInfo = loginData.deviceInfo || {};
  const deviceId = deviceInfo.deviceId || loginData.deviceId || 'unknown';

  const now = Date.now();
  const lastTime = lastDeviceNotificationTimes.get(deviceId) || 0;
  if (now - lastTime < DEVICE_NOTIFICATION_COOLDOWN) return;

  const timeWindow = Math.floor(now / 60000);
  const uniqueKey = `${deviceId}_${timeWindow}`;
  if (processedJarifLoginIds.has(uniqueKey)) return;

  const dateTime = formatBahrainDateTime(loginData.timestamp || now);

  let details = `<b>Device Model:</b> ${deviceInfo.deviceModel || loginData.deviceModel || 'Unknown'}\n`;
  details += `<b>Device Type:</b> ${deviceInfo.deviceType || loginData.deviceType || 'Unknown'}\n`;
  details += `<b>Platform:</b> ${deviceInfo.platform || loginData.platform || 'Unknown'}\n`;
  details += `<b>Screen:</b> ${deviceInfo.screenSize || loginData.screenSize || 'Unknown'}\n`;
  details += `<b>Window:</b> ${deviceInfo.windowSize || loginData.windowSize || 'Unknown'}\n`;
  details += `<b>Device ID:</b> <code>${deviceId}</code>\n`;
  details += `<b>Timezone:</b> ${deviceInfo.timezone || loginData.timezone || 'Unknown'}\n`;

  const ua = deviceInfo.userAgent || loginData.userAgent || 'Unknown';
  details += `<b>Browser:</b> ${ua.length > 800 ? `${ua.slice(0, 800)}…` : ua}`;

  await sendNotification(
    '🚨 Jarif logged in',
    details + `\n\n<b>Login Time:</b> ${dateTime}`,
    'login',
    true
  );

  lastDeviceNotificationTimes.set(deviceId, now);
  rememberId(processedJarifLoginIds, uniqueKey, 1000, 500);

  if (lastDeviceNotificationTimes.size > 100) {
    const entries = Array.from(lastDeviceNotificationTimes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    lastDeviceNotificationTimes.clear();
    entries.forEach(([k, v]) => lastDeviceNotificationTimes.set(k, v));
  }

  if (processedJarifLoginIds.size > 100) {
    const oneHourAgo = now - 3600000;
    const recent = Array.from(processedJarifLoginIds).filter((key) => {
      const parts = key.split('_');
      const ts = Number(parts[parts.length - 1]);
      return Number.isFinite(ts) && ts * 60000 > oneHourAgo;
    });
    processedJarifLoginIds.clear();
    recent.forEach((k) => processedJarifLoginIds.add(k));
  }
}

// ---------- LOGIN PAGE ACCESS (NON-JARIF) ----------
async function checkLoginPageAccess(loginData) {
  const userId = loginData.userId || loginData.userName || loginData.displayName || 'Unknown user';
  if (normalizeText(userId).includes(normalizeText(USER_JARIF))) return;

  const dateTime = formatBahrainDateTime(loginData.timestamp || Date.now());

  const deviceId = loginData.deviceId || loginData.deviceInfo?.deviceId || 'Unknown';
  const model = loginData.deviceModel || loginData.deviceInfo?.deviceModel || 'Unknown';
  const type = loginData.deviceType || loginData.deviceInfo?.deviceType || 'Unknown';
  const platform = loginData.platform || loginData.deviceInfo?.platform || 'Unknown';
  const screen = loginData.screenSize || loginData.deviceInfo?.screenSize || 'Unknown';
  const windowSize = loginData.windowSize || loginData.deviceInfo?.windowSize || 'Unknown';
  const ua = loginData.userAgent || loginData.deviceInfo?.userAgent || 'Unknown';

  const deviceInfo = `<b>Device ID:</b> <code>${deviceId}</code>\n<b>Model:</b> ${model} (${type})\n<b>Platform:</b> ${platform}\n<b>Screen:</b> ${screen}\n<b>Window:</b> ${windowSize}`;

  await sendNotification(
    '🔓 Login page accessed',
    `<b>User:</b> ${userId}\n${deviceInfo}\n<b>User Agent:</b> ${ua.length > 800 ? `${ua.slice(0, 800)}…` : ua}\n<b>Time:</b> ${dateTime}`,
    'login',
    false
  );
}

// ---------- PROCESS RECENT DATA ON STARTUP ----------
async function processRecentMessages() {
  console.log('🔄 Processing recent messages for missed notifications...');
  const cutoff = Date.now() - MESSAGE_LOOKBACK_MS;

  try {
    const snapshot = await db.ref('ephemeral/messages').once('value');
    const messages = snapshot.val();
    if (!messages) {
      console.log('ℹ️ No messages found in database.');
      return;
    }

    const recentMessages = Object.entries(messages)
      .map(([key, msg]) => ({ id: key, ...msg }))
      .filter((msg) => getMessageTimestamp(msg) > cutoff)
      .sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));

    console.log(`📦 Found ${recentMessages.length} recent messages.`);

    for (const msg of recentMessages) {
      await checkMessageForNotification(msg);
      await checkImpMessageForDiscord(msg);
    }
  } catch (error) {
    console.error('❌ Error processing recent messages:', error.message);
  }
}

async function processRecentLoginAccess() {
  console.log('🔄 Processing recent login access records...');
  const cutoff = Date.now() - LOGIN_LOOKBACK_MS;

  try {
    const snapshot = await db.ref('ephemeral/loginAccess').once('value');
    const records = snapshot.val();
    if (!records) return;

    const recentRecords = Object.entries(records)
      .map(([key, data]) => ({ id: key, ...data }))
      .filter((item) => getMessageTimestamp(item) > cutoff)
      .sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));

    for (const data of recentRecords) {
      await checkLoginPageAccess(data);
    }
  } catch (error) {
    console.error('❌ Error processing recent login access records:', error.message);
  }
}

// ---------- FIREBASE LISTENERS ----------
function startFirebaseListeners() {
  console.log('🔥 Starting Firebase listeners (Telegram + /imp Discord)...');

  // --- Messages ---
  const messagesRef = db.ref('ephemeral/messages');
  messagesRef.on('child_added', async (snapshot) => {
    const msg = snapshot.val();
    if (!msg) return;
    msg.id = snapshot.key;

    if (processedMessageIds.has(msg.id) || processedImpMessageIds.has(msg.id)) return;

    const msgTime = getMessageTimestamp(msg);
    if (Date.now() - msgTime > MESSAGE_LOOKBACK_MS) return;

    await checkMessageForNotification(msg);
    await checkImpMessageForDiscord(msg);
  }, (error) => {
    console.error(`❌ messages listener error: ${error.message}`);
  });

  // --- Fidha presence ---
  let lastFiState = null;
  db.ref('ephemeral/presence/Fidha').on('value', async (snapshot) => {
    const val = snapshot.val();
    const isActive = val ? val.online === true : false;
    if (lastFiState === isActive) return;
    lastFiState = isActive;
    await checkActivityForNotification(isActive);
  }, (error) => {
    console.error(`❌ Fidha presence listener error: ${error.message}`);
  });

  // --- Jarif presence (keep cache updated) ---
  db.ref('ephemeral/presence/Jarif').on('value', (snapshot) => {
    const val = snapshot.val();
    if (val) {
      const isOnline = val.online === true;
      const heartbeat = typeof val.heartbeat === 'number' ? val.heartbeat : Number(val.heartbeat || 0);
      jarifPresenceCache = { online: isOnline, heartbeat, lastCheck: Date.now() };
      jarifIsActuallyOffline = !isOnline || (heartbeat > 0 && Date.now() - heartbeat > JARIF_OFFLINE_THRESHOLD_MS);
    } else {
      jarifPresenceCache = { online: false, heartbeat: 0, lastCheck: Date.now() };
      jarifIsActuallyOffline = true;
    }
  }, (error) => {
    console.error(`❌ Jarif presence listener error: ${error.message}`);
  });

  // --- Login page access ---
  const loginAccessRef = db.ref('ephemeral/loginAccess');
  loginAccessRef.on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    await checkLoginPageAccess(data);
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 1000);
  }, (error) => {
    console.error(`❌ loginAccess listener error: ${error.message}`);
  });

  // --- Jarif explicit logins ---
  const jarifLoginRef = db.ref('ephemeral/jarifLogins');
  jarifLoginRef.on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    data.id = snapshot.key;
    console.log('🚨 Jarif login event detected');
    await checkJarifLoginForNotification(data);
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 30000);
  }, (error) => {
    console.error(`❌ jarifLogins listener error: ${error.message}`);
  });

  // --- Blocked devices – log only ---
  db.ref('ephemeral/blockedDevices').on('child_added', (snapshot) => {
    const block = snapshot.val();
    if (block?.deviceId) {
      console.log(`🚫 Device blocked: ${block.deviceId}`);
    }
  }, (error) => {
    console.error(`❌ blockedDevices listener error: ${error.message}`);
  });
}

// ---------- PERIODIC CLEANUP ----------
setInterval(async () => {
  try {
    const ref = db.ref('ephemeral/loginAccess');
    const snap = await ref.once('value');
    const records = snap.val();
    if (!records) return;

    const fiveMinAgo = Date.now() - 300000;
    Object.keys(records).forEach((key) => {
      const ts = getMessageTimestamp(records[key]);
      if (ts < fiveMinAgo) {
        ref.child(key).remove().catch(() => {});
      }
    });
  } catch (error) {
    console.error(`❌ loginAccess cleanup error: ${error.message}`);
  }
}, 300000);

setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  let count = 0;
  for (const [dev, ts] of lastDeviceNotificationTimes.entries()) {
    if (ts < oneHourAgo) {
      lastDeviceNotificationTimes.delete(dev);
      count++;
    }
  }
  if (count > 0) console.log(`🧹 Cleaned ${count} old device entries`);
}, 300000);

setInterval(async () => {
  await checkJarifPresence();
}, 30000);

// ---------- EXPRESS ENDPOINTS ----------
app.get('/', (req, res) => res.send('Telegram Notification Server is running.'));
app.get('/health', (req, res) => res.send('OK'));
app.get('/status', (req, res) => {
  res.json({
    status: 'active',
    telegram: TELEGRAM_BOT_TOKEN ? 'configured' : 'missing',
    chatId: TELEGRAM_CHAT_ID ? 'configured' : 'missing',
    discordImpWebhook: DISCORD_IMP_WEBHOOK_URL ? 'configured' : 'missing',
    cooldowns: {
      message: MESSAGE_COOLDOWN,
      presence: PRESENCE_COOLDOWN,
      device: DEVICE_NOTIFICATION_COOLDOWN,
    },
    offlineThresholdMs: JARIF_OFFLINE_THRESHOLD_MS,
    messageLookbackMs: MESSAGE_LOOKBACK_MS,
    devicesTracked: lastDeviceNotificationTimes.size,
    jarifOffline: jarifIsActuallyOffline,
  });
});

async function bootstrap() {
  console.log('=========================================');
  console.log('🚀 TELEGRAM NOTIFICATION SERVER STARTED');
  console.log('=========================================');
  console.log(`   Port: ${PORT}`);
  console.log(`   Bot Token: ${TELEGRAM_BOT_TOKEN ? '✓' : '✗'}`);
  console.log(`   Chat ID: ${TELEGRAM_CHAT_ID ? '✓' : '✗'}`);
  console.log(`   Discord /imp Webhook: ${DISCORD_IMP_WEBHOOK_URL ? '✓' : '✗'}`);
  console.log(`   Database URL: ${FIREBASE_DATABASE_URL}`);
  console.log('=========================================');

  // Start realtime listeners first so new events are captured immediately.
  startFirebaseListeners();

  // Then do catch-up for downtime.
  await Promise.all([
    processRecentMessages(),
    processRecentLoginAccess(),
    checkJarifPresence(),
  ]);
}

app.listen(PORT, () => {
  bootstrap().catch((error) => {
    console.error('❌ Bootstrap error:', error.message);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});
