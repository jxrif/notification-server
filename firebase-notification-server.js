// firebase-notification-server.js
const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- TELEGRAM ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ CRITICAL: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set.");
  process.exit(1);
}

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

// ---------- USER CONSTANTS ----------
const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

// ---------- COOLDOWNS ----------
const MESSAGE_COOLDOWN = 3000;        // 3 seconds
const PRESENCE_COOLDOWN = 5000;       // 5 seconds
const LOGIN_COOLDOWN = 0;            // immediate
const DEVICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds

// ---------- STATE ----------
let jarifIsActuallyOffline = true;
let previousFiOnlineState = false;

const processedMessageIds = new Set();
const processedPresenceEvents = new Set();
const processedJarifLoginIds = new Set();
const lastDeviceNotificationTimes = new Map();

let lastMessageNotificationTime = 0;
let lastPresenceNotificationTime = 0;
let lastLoginNotificationTime = 0;

// ---------- FIREBASE – IMPORTANT: USE YOUR REAL DATABASE URL ----------
// Match your frontend config: "ephemeral-chat-three-default-rtdb.firebaseio.com"
const FIREBASE_DATABASE_URL =
  "https://ephemeral-chat-three-default-rtdb.firebaseio.com";

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (error) {
  console.error("❌ Cannot parse Firebase service account JSON.");
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
  new Date(ts).toLocaleTimeString("en-US", {
    timeZone: "Asia/Bahrain",
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatBahrainDateTime = (ts = Date.now()) =>
  new Date(ts).toLocaleString("en-US", {
    timeZone: "Asia/Bahrain",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

// ---------- TELEGRAM SEND WITH AUTO‑RETRY ON 429 ----------
async function sendTelegramMessage(text, parseMode = "HTML") {
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
        console.warn(`⏸️ Telegram rate limit. Retrying after ${waitSec}s...`);
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Telegram API error (${response.status}): ${errorText}`);
        // Don't retry on 4xx except 429
        break;
      }

      console.log("✅ Telegram message sent.");
      return; // success
    } catch (error) {
      if (error.name === "AbortError") {
        console.error("⏱️ Request timeout.");
      } else {
        console.error(`🔥 Network error: ${error.message}`);
      }
      // Wait a bit before retrying on network errors
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.error("❌ Failed to send Telegram message after multiple attempts.");
}

// ---------- CENTRAL NOTIFICATION DISPATCHER ----------
async function sendNotification(title, description, type = "info", isJarifLogin = false) {
  const now = Date.now();

  // ---- Cooldowns ----
  if (type === "message") {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) return;
    lastMessageNotificationTime = now;
  } else if (type === "presence") {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) return;
    lastPresenceNotificationTime = now;
  } else if (type === "login" && !isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) return;
    lastLoginNotificationTime = now;
  }

  // ---- Emoji ----
  const emoji = {
    message: "💬",
    presence: "🟢",
    offline: "🔴",
    login: isJarifLogin ? "🚨" : "🔓",
    block: "🚫",
  }[type] || "ℹ️";

  const bahrainTime = formatBahrainTime();
  const fullMessage = `${emoji} <b>${title}</b>\n\n${description}\n\n🕒 <i>${bahrainTime} (Bahrain)</i>`;

  await sendTelegramMessage(fullMessage, "HTML");
}

// ---------- JARIF PRESENCE CHECK ----------
async function checkJarifPresence() {
  try {
    const snap = await db.ref(`ephemeral/presence/${USER_JARIF}`).once("value");
    const val = snap.val();
    if (!val) {
      jarifIsActuallyOffline = true;
      return;
    }
    const isOnline = val.online === true;
    const heartbeat = val.heartbeat || 0;
    jarifIsActuallyOffline = !isOnline || Date.now() - heartbeat > 60000;
  } catch (error) {
    console.error(`❌ checkJarifPresence: ${error.message}`);
    jarifIsActuallyOffline = true;
  }
}

// ---------- FIDHA ACTIVITY (ONLINE / OFFLINE) ----------
async function checkActivityForNotification(isActive) {
  await checkJarifPresence();
  if (!jarifIsActuallyOffline) return; // only notify if Jarif is offline

  // Get Jarif's notification settings
  let settings;
  try {
    const snap = await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).once("value");
    settings = snap.val() || {};
  } catch {
    settings = {};
  }

  const nowOnline = isActive;
  const dateTime = formatBahrainDateTime();

  if (previousFiOnlineState && !nowOnline) {
    // went offline
    if (settings.offlineNotifications !== false) {
      await sendNotification("Fi✨ went offline", `📅 <b>Time:</b> ${dateTime}`, "offline");
    }
  } else if (!previousFiOnlineState && nowOnline) {
    // came online
    if (settings.activityNotifications !== false) {
      await sendNotification("Fi✨ is now active", `📅 <b>Time:</b> ${dateTime}`, "presence");
    }
  }

  previousFiOnlineState = nowOnline;
}

// ---------- FIDHA'S MESSAGES (WHEN JARIF OFFLINE) ----------
async function checkMessageForNotification(message) {
  if (message.sender !== USER_FIDHA) return;

  await checkJarifPresence();
  if (!jarifIsActuallyOffline) return;

  if (processedMessageIds.has(message.id)) return;

  // Get Jarif's notification settings
  let settings;
  try {
    const snap = await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).once("value");
    settings = snap.val();
  } catch {
    settings = null;
  }

  if (!settings) {
    // create default
    settings = { messageNotifications: true, activityNotifications: true, offlineNotifications: true };
    await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).set(settings);
  }

  if (!settings.messageNotifications) return;

  // Skip if already saved/read by Jarif
  if (
    (message.savedBy && message.savedBy[USER_JARIF]) ||
    (message.readBy && message.readBy[USER_JARIF])
  ) return;

  // Format content
  let content;
  if (message.text) {
    content = message.text;
  } else if (message.attachment) {
    if (message.attachment.isVoiceMessage) content = "🎤 Voice message";
    else if (message.attachment.type?.startsWith("image/")) content = "🖼️ Image";
    else if (message.attachment.type?.startsWith("video/")) content = "🎬 Video";
    else if (message.attachment.type?.startsWith("audio/")) content = "🔊 Audio file";
    else content = `📎 File: ${message.attachment.name || "Attachment"}`;
  } else {
    content = "Empty message";
  }

  if (content.length > 1000) content = content.slice(0, 1000) + "…";

  const dateTime = formatBahrainDateTime(message.timestampFull);

  await sendNotification(
    "📩 New message from Fi✨",
    `<b>Message:</b> ${content}\n<b>Time:</b> ${dateTime}`,
    "message"
  );

  processedMessageIds.add(message.id);
  // Keep set size manageable
  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds.clear();
    arr.slice(-500).forEach((id) => processedMessageIds.add(id));
  }
}

// ---------- JARIF LOGIN (IMMEDIATE) ----------
async function checkJarifLoginForNotification(loginData) {
  const deviceInfo = loginData.deviceInfo || {};
  const deviceId = deviceInfo.deviceId || "unknown";

  // Device cooldown (30s)
  const now = Date.now();
  const lastTime = lastDeviceNotificationTimes.get(deviceId) || 0;
  if (now - lastTime < DEVICE_NOTIFICATION_COOLDOWN) return;

  // Time‑window dedup (1 minute)
  const timeWindow = Math.floor(now / 60000);
  const uniqueKey = `${deviceId}_${timeWindow}`;
  if (processedJarifLoginIds.has(uniqueKey)) return;

  const dateTime = formatBahrainDateTime(loginData.timestamp || now);

  let details = `<b>Device Model:</b> ${deviceInfo.deviceModel || "Unknown"}\n`;
  details += `<b>Device Type:</b> ${deviceInfo.deviceType || "Unknown"}\n`;
  details += `<b>Platform:</b> ${deviceInfo.platform || "Unknown"}\n`;
  details += `<b>Screen:</b> ${deviceInfo.screenSize || "Unknown"}\n`;
  details += `<b>Window:</b> ${deviceInfo.windowSize || "Unknown"}\n`;
  details += `<b>Device ID:</b> <code>${deviceId}</code>\n`;
  details += `<b>Timezone:</b> ${deviceInfo.timezone || "Unknown"}\n`;

  const ua = deviceInfo.userAgent || "Unknown";
  details += `<b>Browser:</b> ${ua.length > 800 ? ua.slice(0, 800) + "…" : ua}`;

  await sendNotification(
    "🚨 Jarif logged in",
    details + `\n\n<b>Login Time:</b> ${dateTime}`,
    "login",
    true // isJarifLogin – bypass cooldown
  );

  lastDeviceNotificationTimes.set(deviceId, now);
  processedJarifLoginIds.add(uniqueKey);

  // Clean old device entries (keep 50 most recent)
  if (lastDeviceNotificationTimes.size > 100) {
    const entries = Array.from(lastDeviceNotificationTimes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    lastDeviceNotificationTimes.clear();
    entries.forEach(([k, v]) => lastDeviceNotificationTimes.set(k, v));
  }

  // Clean old processed IDs (keep last hour)
  if (processedJarifLoginIds.size > 100) {
    const oneHourAgo = now - 3600000;
    const recent = Array.from(processedJarifLoginIds).filter((key) => {
      const [, ts] = key.split("_");
      return Number(ts) * 60000 > oneHourAgo;
    });
    processedJarifLoginIds.clear();
    recent.forEach((k) => processedJarifLoginIds.add(k));
  }
}

// ---------- LOGIN PAGE ACCESS (NON‑JARIF) ----------
async function checkLoginPageAccess(loginData) {
  const userId = loginData.userId || "Unknown user";
  if (userId === USER_JARIF || userId.includes(USER_JARIF)) return;

  const dateTime = formatBahrainDateTime(loginData.timestamp);

  const deviceId = loginData.deviceId || "Unknown";
  const model = loginData.deviceModel || "Unknown";
  const type = loginData.deviceType || "Unknown";
  const platform = loginData.platform || "Unknown";
  const screen = loginData.screenSize || "Unknown";
  const window = loginData.windowSize || "Unknown";
  const ua = loginData.userAgent || "Unknown";

  const deviceInfo = `<b>Device ID:</b> <code>${deviceId}</code>\n<b>Model:</b> ${model} (${type})\n<b>Platform:</b> ${platform}\n<b>Screen:</b> ${screen}\n<b>Window:</b> ${window}`;

  await sendNotification(
    "🔓 Login page accessed",
    `<b>User:</b> ${userId}\n${deviceInfo}\n<b>User Agent:</b> ${ua.length > 800 ? ua.slice(0, 800) + "…" : ua}\n<b>Time:</b> ${dateTime}`,
    "login",
    false
  );
}

// ---------- FIREBASE LISTENERS (NO SPAM LOGS) ----------
function startFirebaseListeners() {
  console.log("🔥 Starting Firebase listeners (Telegram mode)...");

  // --- Messages: only process recent messages, ignore edits ---
  const messagesRef = db.ref("ephemeral/messages");
  messagesRef.on("child_added", async (snapshot) => {
    const msg = snapshot.val();
    if (!msg) return;
    msg.id = snapshot.key;

    // Only consider messages from last 5 minutes
    const msgTime = msg.timestampFull || Date.now();
    if (Date.now() - msgTime > 5 * 60 * 1000) return;

    await checkMessageForNotification(msg);
  });

  // --- Fidha presence (only state changes) ---
  let lastFiState = null;
  db.ref("ephemeral/presence/Fidha").on("value", async (snapshot) => {
    const val = snapshot.val();
    const isActive = val ? val.online === true : false;
    if (lastFiState === isActive) return;
    lastFiState = isActive;
    await checkActivityForNotification(isActive);
  });

  // --- Jarif presence (update offline flag) ---
  db.ref("ephemeral/presence/Jarif").on("value", async (snapshot) => {
    const val = snapshot.val();
    if (val) {
      const isOnline = val.online === true;
      const hb = val.heartbeat || 0;
      jarifIsActuallyOffline = !isOnline || Date.now() - hb > 60000;
    } else {
      jarifIsActuallyOffline = true;
    }
  });

  // --- Login page access ---
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  loginAccessRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    await checkLoginPageAccess(data);
    // Clean immediately
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 1000);
  });

  // --- Jarif explicit logins ---
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  jarifLoginRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    data.id = snapshot.key;
    console.log("🚨 Jarif login event detected");
    await checkJarifLoginForNotification(data);
    // Clean after 30 seconds
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 30000);
  });

  // --- Blocked devices – log only, no notification ---
  db.ref("ephemeral/blockedDevices").on("child_added", (snapshot) => {
    const block = snapshot.val();
    if (block?.deviceId) {
      console.log(`🚫 Device blocked: ${block.deviceId}`);
    }
  });
}

// ---------- PERIODIC CLEANUP ----------
setInterval(async () => {
  const ref = db.ref("ephemeral/loginAccess");
  const snap = await ref.once("value");
  const records = snap.val();
  if (!records) return;
  const fiveMinAgo = Date.now() - 300000;
  Object.keys(records).forEach((key) => {
    if (records[key].timestamp && records[key].timestamp < fiveMinAgo) {
      ref.child(key).remove().catch(() => {});
    }
  });
}, 300000); // every 5 min

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
}, 300000); // every 5 min

setInterval(checkJarifPresence, 30000); // every 30 sec

// ---------- EXPRESS ENDPOINTS ----------
app.get("/", (req, res) => res.send("Telegram Notification Server is running."));
app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => {
  res.json({
    status: "active",
    telegram: TELEGRAM_BOT_TOKEN ? "configured" : "missing",
    chatId: TELEGRAM_CHAT_ID ? "configured" : "missing",
    cooldowns: {
      message: MESSAGE_COOLDOWN,
      presence: PRESENCE_COOLDOWN,
      device: DEVICE_NOTIFICATION_COOLDOWN,
    },
    devicesTracked: lastDeviceNotificationTimes.size,
  });
});

app.listen(PORT, () => {
  console.log("=========================================");
  console.log("🚀 TELEGRAM NOTIFICATION SERVER STARTED");
  console.log("=========================================");
  console.log(`   Port: ${PORT}`);
  console.log(`   Bot Token: ${TELEGRAM_BOT_TOKEN ? "✓" : "✗"}`);
  console.log(`   Chat ID: ${TELEGRAM_CHAT_ID ? "✓" : "✗"}`);
  console.log(`   Database URL: ${FIREBASE_DATABASE_URL}`);
  console.log("=========================================");
});

// Graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});

startFirebaseListeners();
