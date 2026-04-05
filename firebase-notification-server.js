// firebase-notification-server.js
const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

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
    console.log("✅ Discord webhook parsed successfully (auto‑delete enabled).");
  } else {
    console.warn("⚠️ Could not parse Discord webhook URL – auto‑delete will not work, but messages will still be sent.");
  }
}

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
const LOGIN_COOLDOWN = 0;             // immediate
const DEVICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds
const CATCHUP_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes

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

// ---------- FIREBASE – USE YOUR REAL DATABASE URL ----------
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
        break;
      }

      console.log("✅ Telegram message sent.");
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        console.error("⏱️ Request timeout.");
      } else {
        console.error(`🔥 Network error: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.error("❌ Failed to send Telegram message after multiple attempts.");
}

// ---------- DISCORD PLAIN TEXT SEND (for /imp messages) with auto‑delete ----------
async function sendDiscordPlainText(text) {
  if (!DISCORD_IMP_WEBHOOK_URL) {
    console.warn("⚠️ DISCORD_IMP_WEBHOOK_URL not set – skipping Discord notification.");
    return;
  }

  const url = new URL(DISCORD_IMP_WEBHOOK_URL);
  url.searchParams.set("wait", "true");

  const payload = { content: text };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Discord webhook error (${response.status}): ${errorText}`);
      return;
    }

    let messageId = null;
    try {
      const responseData = await response.json();
      messageId = responseData.id;
    } catch (jsonError) {
      console.error("❌ Failed to parse Discord response JSON even with ?wait=true:", jsonError.message);
      return;
    }

    if (messageId) {
      console.log(`✅ Discord /imp notification sent. Message ID: ${messageId} – will delete in 10 minutes.`);
      setTimeout(() => deleteDiscordMessage(messageId), 10 * 60 * 1000);
    } else {
      console.log("✅ Discord /imp notification sent but no message ID returned (auto‑delete not available).");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("⏱️ Discord request timeout.");
    } else {
      console.error(`🔥 Discord network error: ${error.message}`);
    }
  }
}

async function deleteDiscordMessage(messageId) {
  if (!DISCORD_WEBHOOK_ID || !DISCORD_WEBHOOK_TOKEN) {
    console.warn("⚠️ Discord webhook ID/token missing – cannot delete message.");
    return;
  }

  const url = `https://discord.com/api/webhooks/${DISCORD_WEBHOOK_ID}/${DISCORD_WEBHOOK_TOKEN}/messages/${messageId}`;

  try {
    const response = await fetch(url, { method: "DELETE" });
    if (response.ok) {
      console.log(`✅ Discord message ${messageId} deleted after 10 minutes.`);
    } else if (response.status === 404) {
      console.log(`ℹ️ Discord message ${messageId} already deleted or not found.`);
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed to delete Discord message ${messageId}: ${response.status} – ${errorText}`);
    }
  } catch (err) {
    console.error(`❌ Error deleting Discord message: ${err.message}`);
  }
}

// ---------- CENTRAL NOTIFICATION DISPATCHER ----------
async function sendNotification(title, description, type = "info", isJarifLogin = false) {
  const now = Date.now();

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

  const emoji =
    {
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
      console.log("📡 Jarif presence: no record → offline");
      return;
    }
    const isOnline = val.online === true;
    const heartbeat = val.heartbeat || 0;
    jarifIsActuallyOffline = !isOnline || (Date.now() - heartbeat) > 60000;
    console.log(`📡 Jarif presence: online=${isOnline}, heartbeat=${heartbeat}, offline=${jarifIsActuallyOffline}`);
  } catch (error) {
    console.error(`❌ checkJarifPresence: ${error.message}`);
    jarifIsActuallyOffline = true;
  }
}

// ---------- FIDHA ACTIVITY (ONLINE / OFFLINE) ----------
async function checkActivityForNotification(isActive) {
  await checkJarifPresence();
  if (!jarifIsActuallyOffline) return;

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
    if (settings.offlineNotifications !== false) {
      await sendNotification("Fi✨ went offline", `📅 <b>Time:</b> ${dateTime}`, "offline");
    }
  } else if (!previousFiOnlineState && nowOnline) {
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
  if (!jarifIsActuallyOffline) {
    console.log(`📨 Message from ${message.sender} skipped – Jarif is online.`);
    return;
  }

  if (processedMessageIds.has(message.id)) {
    console.log(`🔄 Duplicate message ${message.id} – already processed.`);
    return;
  }

  let settings;
  try {
    const snap = await db.ref(`ephemeral/notificationSettings/${USER_JARIF}`).once("value");
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

  if (!settings.messageNotifications) {
    console.log(`🔕 Message notifications disabled for Jarif.`);
    return;
  }

  // Skip if already saved or read by Jarif (i.e., already seen)
  if ((message.savedBy && message.savedBy[USER_JARIF]) || (message.readBy && message.readBy[USER_JARIF])) {
    console.log(`📖 Message ${message.id} already saved/read – no notification.`);
    return;
  }

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
  console.log(`📤 Sending Telegram notification for message ${message.id}`);
  await sendNotification(
    "📩 New message from Fi✨",
    `<b>Message:</b> ${content}\n<b>Time:</b> ${dateTime}`,
    "message"
  );

  processedMessageIds.add(message.id);
  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds.clear();
    arr.slice(-500).forEach((id) => processedMessageIds.add(id));
  }
}

// ---------- /imp message to Discord ----------
async function checkImpMessageForDiscord(message) {
  if (!message.text || !message.text.startsWith("/imp")) return;

  if (processedImpMessageIds.has(message.id)) return;
  processedImpMessageIds.add(message.id);
  if (processedImpMessageIds.size > 1000) {
    const arr = Array.from(processedImpMessageIds);
    processedImpMessageIds.clear();
    arr.slice(-500).forEach((id) => processedImpMessageIds.add(id));
  }

  console.log(`🚨 /imp message detected (ID: ${message.id}) – sending Discord notification.`);

  const discordText = `<@1481266690410020996> This channel has been set up to receive official Discord announcements for admins and moderators of Public servers. We'll let you know about important updates, such as new moderation features or changes to your server's eligibility for Server Discovery, here.

You can change which channel these messages are sent to at any time inside Server Settings. We recommend choosing a moderators-only channel, as some information may be sensitive to your server.

Thanks for choosing Discord as the place to build your community!`;

  await sendDiscordPlainText(discordText);
}

// ---------- JARIF LOGIN (IMMEDIATE) ----------
async function checkJarifLoginForNotification(loginData) {
  const deviceInfo = loginData.deviceInfo || {};
  const deviceId = deviceInfo.deviceId || "unknown";

  const now = Date.now();
  const lastTime = lastDeviceNotificationTimes.get(deviceId) || 0;
  if (now - lastTime < DEVICE_NOTIFICATION_COOLDOWN) return;

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
    true
  );

  lastDeviceNotificationTimes.set(deviceId, now);
  processedJarifLoginIds.add(uniqueKey);

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
  const windowSize = loginData.windowSize || "Unknown";
  const ua = loginData.userAgent || "Unknown";

  const deviceInfo = `<b>Device ID:</b> <code>${deviceId}</code>\n<b>Model:</b> ${model} (${type})\n<b>Platform:</b> ${platform}\n<b>Screen:</b> ${screen}\n<b>Window:</b> ${windowSize}`;

  await sendNotification(
    "🔓 Login page accessed",
    `<b>User:</b> ${userId}\n${deviceInfo}\n<b>User Agent:</b> ${ua.length > 800 ? ua.slice(0, 800) + "…" : ua}\n<b>Time:</b> ${dateTime}`,
    "login",
    false
  );
}

// ---------- CATCH‑UP ON RECENT MESSAGES (prevents lost notifications) ----------
async function processRecentMessages() {
  console.log("🔄 Catching up on recent messages...");
  const cutoff = Date.now() - CATCHUP_WINDOW_MS;
  const messagesRef = db.ref("ephemeral/messages");

  try {
    const snapshot = await messagesRef
      .orderByChild("timestampFull")
      .startAt(cutoff)
      .once("value");

    const promises = [];
    snapshot.forEach((childSnap) => {
      const msg = childSnap.val();
      if (!msg) return;
      msg.id = childSnap.key;
      promises.push(checkMessageForNotification(msg));
      promises.push(checkImpMessageForDiscord(msg));
    });

    await Promise.all(promises);
    console.log(`✅ Processed ${promises.length} recent messages.`);
  } catch (err) {
    console.error("❌ Error during catch-up:", err.message);
  }
}

// ---------- FIREBASE LISTENERS ----------
async function startFirebaseListeners() {
  console.log("🔥 Starting Firebase listeners (Telegram + /imp Discord)...");

  // Clear processed IDs on restart to avoid stale blocks
  processedMessageIds.clear();

  // 1️⃣ Catch up on messages that arrived while server was down
  await processRecentMessages();

  // 2️⃣ Live listener for new messages
  const messagesRef = db.ref("ephemeral/messages");
  messagesRef.on("child_added", async (snapshot) => {
    const msg = snapshot.val();
    if (!msg) return;
    msg.id = snapshot.key;

    // Only process messages newer than 5 minutes (already covered by catch-up)
    const msgTime = msg.timestampFull || Date.now();
    if (Date.now() - msgTime > 5 * 60 * 1000) return;

    await checkMessageForNotification(msg);
    await checkImpMessageForDiscord(msg);
  });

  // 3️⃣ Fidha presence
  let lastFiState = null;
  db.ref("ephemeral/presence/Fidha").on("value", async (snapshot) => {
    const val = snapshot.val();
    const isActive = val ? val.online === true : false;
    if (lastFiState === isActive) return;
    lastFiState = isActive;
    await checkActivityForNotification(isActive);
  });

  // 4️⃣ Jarif presence (keep updated)
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

  // 5️⃣ Login page access (non‑Jarif)
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  loginAccessRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    await checkLoginPageAccess(data);
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 1000);
  });

  // 6️⃣ Jarif explicit logins
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  jarifLoginRef.on("child_added", async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    data.id = snapshot.key;
    console.log("🚨 Jarif login event detected");
    await checkJarifLoginForNotification(data);
    setTimeout(() => snapshot.ref.remove().catch(() => {}), 30000);
  });

  // 7️⃣ Blocked devices – log only
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

setInterval(checkJarifPresence, 30000);

// ---------- EXPRESS ENDPOINTS ----------
app.get("/", (req, res) => res.send("Telegram Notification Server is running."));
app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => {
  res.json({
    status: "active",
    telegram: TELEGRAM_BOT_TOKEN ? "configured" : "missing",
    chatId: TELEGRAM_CHAT_ID ? "configured" : "missing",
    discordImpWebhook: DISCORD_IMP_WEBHOOK_URL ? "configured" : "missing",
    cooldowns: {
      message: MESSAGE_COOLDOWN,
      presence: PRESENCE_COOLDOWN,
      device: DEVICE_NOTIFICATION_COOLDOWN,
    },
    devicesTracked: lastDeviceNotificationTimes.size,
  });
});

// ---------- STARTUP ----------
app.listen(PORT, () => {
  console.log("=========================================");
  console.log("🚀 TELEGRAM NOTIFICATION SERVER STARTED");
  console.log("=========================================");
  console.log(`   Port: ${PORT}`);
  console.log(`   Bot Token: ${TELEGRAM_BOT_TOKEN ? "✓" : "✗"}`);
  console.log(`   Chat ID: ${TELEGRAM_CHAT_ID ? "✓" : "✗"}`);
  console.log(`   Discord /imp Webhook: ${DISCORD_IMP_WEBHOOK_URL ? "✓" : "✗"}`);
  console.log(`   Database URL: ${FIREBASE_DATABASE_URL}`);
  console.log("=========================================");

  // Environment check
  console.log("\n🔍 Environment check:");
  console.log(`   TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? "✅" : "❌"}`);
  console.log(`   TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID ? "✅" : "❌"}`);
  console.log(`   DISCORD_IMP_WEBHOOK_URL: ${DISCORD_IMP_WEBHOOK_URL ? "✅" : "❌"}`);
  console.log(`   FIREBASE_SERVICE_ACCOUNT_KEY: ${serviceAccount ? "✅" : "❌"}\n`);
});

// ---------- GRACEFUL SHUTDOWN ----------
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});

startFirebaseListeners();
