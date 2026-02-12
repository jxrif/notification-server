// firebase-notification-server.js
const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- TELEGRAM CONFIGURATION ----------
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

// ---------- COOLDOWN SETTINGS ----------
const MESSAGE_COOLDOWN = 3000; // 3 seconds
const PRESENCE_COOLDOWN = 5000; // 5 seconds
const LOGIN_COOLDOWN = 0; // immediate (no cooldown)
const DEVICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds

// ---------- STATE VARIABLES ----------
let jarifIsActuallyOffline = true;
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let processedJarifLoginIds = new Set();
let lastMessageNotificationTime = 0;
let lastPresenceNotificationTime = 0;
let lastLoginNotificationTime = 0;

const lastDeviceNotificationTimes = new Map();

// ---------- FIREBASE ----------
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (error) {
  console.error("❌ Could not parse Firebase service account JSON.");
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://two-ephemeral-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

// ---------- TIME FORMATTERS (Bahrain time) ----------
function formatBahrainTime(timestamp = Date.now()) {
  return new Date(Number(timestamp)).toLocaleTimeString("en-US", {
    timeZone: "Asia/Bahrain",
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatBahrainDateTime(timestamp = Date.now()) {
  return new Date(Number(timestamp)).toLocaleString("en-US", {
    timeZone: "Asia/Bahrain",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

// ---------- TELEGRAM SEND FUNCTION ----------
async function sendTelegramMessage(messageText, parseMode = "HTML") {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ Telegram credentials missing.");
    return;
  }

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: messageText,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

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

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Telegram API error (${response.status}): ${errorText}`);
      // 429 = Too Many Requests – Telegram rate limit (30 msg/sec per chat)
      if (response.status === 429) {
        console.warn(
          "⏸️ Telegram rate limit hit. Will retry later (cooldown applied).",
        );
      }
    } else {
      console.log("✅ Telegram message sent successfully.");
    }
  } catch (error) {
    console.error(`🔥 Telegram send error: ${error.message}`);
  }
}

// ---------- CENTRAL NOTIFICATION DISPATCHER ----------
async function sendNotification(
  title,
  description,
  type = "info",
  isJarifLogin = false,
) {
  const now = Date.now();

  // ---- Cooldown handling ----
  if (type === "message") {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      console.log(`⏸️ Message cooldown active (${MESSAGE_COOLDOWN}ms)`);
      return;
    }
    lastMessageNotificationTime = now;
  } else if (type === "presence") {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      console.log(`⏸️ Presence cooldown active (${PRESENCE_COOLDOWN}ms)`);
      return;
    }
    lastPresenceNotificationTime = now;
  } else if (type === "login" && !isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      console.log(`⏸️ Login cooldown active (${LOGIN_COOLDOWN}ms)`);
      return;
    }
    lastLoginNotificationTime = now;
  }

  // ---- Emoji mapping ----
  let emoji = "ℹ️";
  if (type === "message") emoji = "💬";
  else if (type === "presence") emoji = "🟢";
  else if (type === "offline") emoji = "🔴";
  else if (type === "login") emoji = isJarifLogin ? "🚨" : "🔓";
  else if (type === "block") emoji = "🚫";

  // ---- Format final message ----
  const bahrainTime = formatBahrainTime();
  const header = `${emoji} <b>${title}</b>`;
  const footer = `🕒 <i>${bahrainTime} (Bahrain)</i>`;
  const fullMessage = `${header}\n\n${description}\n\n${footer}`;

  await sendTelegramMessage(fullMessage, "HTML");
}

// ---------- PRESENCE / ACTIVITY CHECK (Fidha) ----------
async function checkJarifPresence() {
  try {
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (!jarifPresence) {
      jarifIsActuallyOffline = true;
      return;
    }

    const isOnline = jarifPresence.online === true;
    const lastHeartbeat = jarifPresence.heartbeat || 0;
    const timeSinceHeartbeat = Date.now() - lastHeartbeat;

    jarifIsActuallyOffline = !isOnline || timeSinceHeartbeat > 60000;
  } catch (error) {
    console.error(`❌ checkJarifPresence error: ${error.message}`);
    jarifIsActuallyOffline = true;
  }
}

async function checkActivityForNotification(isActive) {
  console.log(`👤 Fidha presence: ${isActive ? "online" : "offline"}`);
  await checkJarifPresence();

  if (!jarifIsActuallyOffline) {
    console.log(`⏭️ Jarif is online – skipping presence notification`);
    return;
  }

  // Fetch Jarif's notification settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val() || {
      activityNotifications: true,
      offlineNotifications: true,
    };
  } catch {
    jarifSettings = { activityNotifications: true, offlineNotifications: true };
  }

  const nowOnline = isActive;
  const bahrainDateTime = formatBahrainDateTime();

  // Offline event
  if (previousFiOnlineState && !nowOnline) {
    if (jarifSettings.offlineNotifications) {
      await sendNotification(
        "Fi✨ went offline",
        `**Time:** ${bahrainDateTime}`,
        "offline",
      );
    }
  }
  // Online event
  else if (!previousFiOnlineState && nowOnline) {
    if (jarifSettings.activityNotifications) {
      await sendNotification(
        "Fi✨ is now active",
        `**Time:** ${bahrainDateTime}`,
        "presence",
      );
    }
  }

  previousFiOnlineState = nowOnline;
}

// ---------- MESSAGE NOTIFICATION (Fidha → Jarif when offline) ----------
async function checkMessageForNotification(message) {
  if (message.sender !== USER_FIDHA) {
    return; // only notify for Fidha's messages
  }

  await checkJarifPresence();
  if (!jarifIsActuallyOffline) {
    console.log(`⏭️ Jarif is online – skipping message notification`);
    return;
  }

  // Check if message already processed
  if (processedMessageIds.has(message.id)) {
    console.log(`⏭️ Duplicate message ID: ${message.id}`);
    return;
  }

  // Check Jarif's notification settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch {
    jarifSettings = null;
  }

  if (!jarifSettings) {
    jarifSettings = {
      messageNotifications: true,
      activityNotifications: true,
      offlineNotifications: true,
    };
    await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .set(jarifSettings);
  }

  if (!jarifSettings.messageNotifications) {
    console.log(`⏭️ Message notifications disabled for Jarif`);
    return;
  }

  // Skip if message is saved or read by Jarif
  if (
    (message.savedBy && message.savedBy[USER_JARIF]) ||
    (message.readBy && message.readBy[USER_JARIF])
  ) {
    console.log(`⏭️ Message already saved/read by Jarif`);
    return;
  }

  // Format content
  let messageContent;
  if (message.text) {
    messageContent = message.text;
  } else if (message.attachment) {
    if (message.attachment.isVoiceMessage) {
      messageContent = "🎤 Voice message";
    } else if (message.attachment.type?.startsWith("image/")) {
      messageContent = "🖼️ Image";
    } else if (message.attachment.type?.startsWith("video/")) {
      messageContent = "🎬 Video";
    } else if (message.attachment.type?.startsWith("audio/")) {
      messageContent = "🔊 Audio file";
    } else {
      messageContent = `📎 File: ${message.attachment.name || "Attachment"}`;
    }
  } else {
    messageContent = "Empty message";
  }

  if (messageContent.length > 1000) {
    messageContent = messageContent.substring(0, 1000) + "…";
  }

  const bahrainDateTime = formatBahrainDateTime(message.timestampFull);

  await sendNotification(
    "📩 New message from Fi✨",
    `<b>Message:</b> ${messageContent}\n<b>Time:</b> ${bahrainDateTime}`,
    "message",
  );

  processedMessageIds.add(message.id);
  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

// ---------- JARIF LOGIN NOTIFICATION (IMMEDIATE) ----------
async function checkJarifLoginForNotification(loginData) {
  const deviceInfo = loginData.deviceInfo || {};
  const deviceId = deviceInfo.deviceId || "unknown";

  // Device cooldown (30 seconds)
  const now = Date.now();
  const lastTime = lastDeviceNotificationTimes.get(deviceId) || 0;
  if (now - lastTime < DEVICE_NOTIFICATION_COOLDOWN) {
    console.log(`⏭️ Device ${deviceId} still in cooldown`);
    return;
  }

  // Time‑window deduplication (1 minute)
  const timeWindow = Math.floor(now / 60000);
  const uniqueKey = `${deviceId}_${timeWindow}`;
  if (processedJarifLoginIds.has(uniqueKey)) {
    console.log(`⏭️ Duplicate Jarif login in this time window`);
    return;
  }

  const bahrainDateTime = formatBahrainDateTime(loginData.timestamp || now);

  let deviceDetails = `<b>Device Model:</b> ${deviceInfo.deviceModel || "Unknown"}\n`;
  deviceDetails += `<b>Device Type:</b> ${deviceInfo.deviceType || "Unknown"}\n`;
  deviceDetails += `<b>Platform:</b> ${deviceInfo.platform || "Unknown"}\n`;
  deviceDetails += `<b>Screen:</b> ${deviceInfo.screenSize || "Unknown"}\n`;
  deviceDetails += `<b>Window:</b> ${deviceInfo.windowSize || "Unknown"}\n`;
  deviceDetails += `<b>Device ID:</b> <code>${deviceId}</code>\n`;
  deviceDetails += `<b>Timezone:</b> ${deviceInfo.timezone || "Unknown"}\n`;

  const userAgent = deviceInfo.userAgent || "Unknown";
  const safeUserAgent =
    userAgent.length > 800 ? userAgent.substring(0, 800) + "…" : userAgent;
  deviceDetails += `<b>Browser:</b> ${safeUserAgent}`;

  await sendNotification(
    "🚨 Jarif logged in",
    deviceDetails + `\n\n<b>Login Time:</b> ${bahrainDateTime}`,
    "login",
    true, // isJarifLogin = true (bypass cooldown)
  );

  // Update tracking
  lastDeviceNotificationTimes.set(deviceId, now);
  processedJarifLoginIds.add(uniqueKey);

  // Cleanup old device entries (keep 50 most recent)
  if (lastDeviceNotificationTimes.size > 100) {
    const entries = Array.from(lastDeviceNotificationTimes.entries());
    entries.sort((a, b) => b[1] - a[1]); // descending
    const recent = entries.slice(0, 50);
    lastDeviceNotificationTimes.clear();
    recent.forEach(([k, v]) => lastDeviceNotificationTimes.set(k, v));
  }

  // Cleanup login ID cache (keep last hour)
  if (processedJarifLoginIds.size > 100) {
    const oneHourAgo = now - 3600000;
    const arr = Array.from(processedJarifLoginIds);
    const recentIds = arr.filter((key) => {
      const [, ts] = key.split("_");
      return Number(ts) * 60000 > oneHourAgo;
    });
    processedJarifLoginIds = new Set(recentIds);
  }
}

// ---------- LOGIN PAGE ACCESS (non‑Jarif users) ----------
async function checkLoginPageAccess(loginData) {
  const userId = loginData.userId || "Unknown user";
  if (userId === USER_JARIF || userId.includes(USER_JARIF)) {
    return; // Jarif's own access is handled separately
  }

  const bahrainDateTime = formatBahrainDateTime(loginData.timestamp);

  const deviceId = loginData.deviceId || "Unknown";
  const deviceModel = loginData.deviceModel || "Unknown";
  const deviceType = loginData.deviceType || "Unknown";
  const platform = loginData.platform || "Unknown";
  const screenSize = loginData.screenSize || "Unknown";
  const windowSize = loginData.windowSize || "Unknown";
  const userAgent = loginData.userAgent || "Unknown";
  const safeUserAgent =
    userAgent.length > 800 ? userAgent.substring(0, 800) + "…" : userAgent;

  const deviceInfo = `<b>Device ID:</b> <code>${deviceId}</code>\n<b>Model:</b> ${deviceModel} (${deviceType})\n<b>Platform:</b> ${platform}\n<b>Screen:</b> ${screenSize}\n<b>Window:</b> ${windowSize}`;

  await sendNotification(
    "🔓 Login page accessed",
    `<b>User:</b> ${userId}\n${deviceInfo}\n<b>User Agent:</b> ${safeUserAgent}\n<b>Time:</b> ${bahrainDateTime}`,
    "login",
    false,
  );
}

// ---------- FIREBASE LISTENERS ----------
function startFirebaseListeners() {
  console.log("🔥 Starting Firebase listeners...");

  // --- Messages ---
  const messagesRef = db.ref("ephemeral/messages");
  messagesRef.on("child_added", async (snapshot) => {
    const message = snapshot.val();
    if (!message) return;
    message.id = snapshot.key;

    // Log to console
    const sender = message.sender === USER_FIDHA ? "Fi✨" : "7uvjx";
    const content =
      message.text || (message.attachment ? "Attachment" : "Empty");
    console.log(`📨 [MESSAGE] ${sender}: ${content}`);

    // Only consider recent messages (last 5 minutes)
    const msgTime = message.timestampFull || Date.now();
    if (Date.now() - msgTime < 5 * 60 * 1000) {
      await checkMessageForNotification(message);
    }
  });

  // --- Fidha presence ---
  let lastFiPresenceState = null;
  db.ref("ephemeral/presence/Fidha").on("value", async (snapshot) => {
    const val = snapshot.val();
    const isActive = val ? val.online === true : false;
    if (lastFiPresenceState === isActive) return;
    lastFiPresenceState = isActive;
    await checkActivityForNotification(isActive);
  });

  // --- Jarif presence (update offline flag) ---
  db.ref("ephemeral/presence/Jarif").on("value", async (snapshot) => {
    const val = snapshot.val();
    if (val) {
      const isOnline = val.online === true;
      const heartbeat = val.heartbeat || 0;
      jarifIsActuallyOffline = !isOnline || Date.now() - heartbeat > 60000;
    } else {
      jarifIsActuallyOffline = true;
    }
  });

  // --- Login page access (ephemeral/loginAccess) ---
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  loginAccessRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    await checkLoginPageAccess(data);
    // Clean up after 1 second
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 1000);
  });

  // --- Jarif explicit logins (ephemeral/jarifLogins) ---
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  jarifLoginRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    data.id = snapshot.key;
    console.log("🚨 Jarif login event detected");
    await checkJarifLoginForNotification(data);
    // Clean up after 30 seconds
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 30000);
  });

  // --- Blocked devices (log only) ---
  db.ref("ephemeral/blockedDevices").on("child_added", (snapshot) => {
    const blocked = snapshot.val();
    if (blocked?.deviceId) {
      console.log(`🚫 Device blocked: ${blocked.deviceId}`);
    }
  });
}

// ---------- PERIODIC CLEANUP ----------
// Clean old loginAccess records every 5 minutes
setInterval(async () => {
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const snapshot = await loginAccessRef.once("value");
  const records = snapshot.val();
  if (!records) return;
  const fiveMinAgo = Date.now() - 300000;
  Object.keys(records).forEach((key) => {
    if (records[key].timestamp && records[key].timestamp < fiveMinAgo) {
      loginAccessRef
        .child(key)
        .remove()
        .catch(() => {});
    }
  });
}, 300000);

// Clean old device notification entries every 5 minutes
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  let count = 0;
  for (const [deviceId, ts] of lastDeviceNotificationTimes.entries()) {
    if (ts < oneHourAgo) {
      lastDeviceNotificationTimes.delete(deviceId);
      count++;
    }
  }
  if (count > 0) console.log(`🧹 Cleaned ${count} old device entries`);
}, 300000);

// Check Jarif presence every 30 seconds
setInterval(checkJarifPresence, 30000);

// ---------- EXPRESS SERVER ----------
app.get("/", (req, res) =>
  res.send("Telegram Notification Server is running."),
);
app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => {
  res.json({
    status: "active",
    telegram: TELEGRAM_BOT_TOKEN ? "configured" : "missing",
    chatId: TELEGRAM_CHAT_ID ? "configured" : "missing",
    cooldowns: {
      message: `${MESSAGE_COOLDOWN}ms`,
      presence: `${PRESENCE_COOLDOWN}ms`,
      device: `${DEVICE_NOTIFICATION_COOLDOWN}ms`,
    },
    devicesTracked: lastDeviceNotificationTimes.size,
  });
});

// Start server
app.listen(PORT, () => {
  console.log("=========================================");
  console.log("🚀 TELEGRAM NOTIFICATION SERVER STARTED");
  console.log("=========================================");
  console.log(`   Port: ${PORT}`);
  console.log(`   Bot Token: ${TELEGRAM_BOT_TOKEN ? "✓" : "✗"}`);
  console.log(`   Chat ID: ${TELEGRAM_CHAT_ID ? "✓" : "✗"}`);
  console.log("=========================================");
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});

startFirebaseListeners();
