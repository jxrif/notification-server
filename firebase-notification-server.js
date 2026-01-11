/**
 * firebase-notification-server.js
 *
 * Changes made:
 * - Explicit env vars for webhooks:
 *   DISCORD_WEBHOOK_URL_PRIMARY, DISCORD_WEBHOOK_URL_SECONDARY, DISCORD_WEBHOOK_URL_TERTIARY, DISCORD_WEBHOOK_URL_JARIF
 *   (backwards-compatible with older vars)
 * - TARGET_FIDHA_ID and TARGET_JARIF_ID env vars to target the correct DB keys (e.g. 7uvfii and 7uvjx)
 * - More robust message sender checks (sender, senderId, from, uid)
 * - Removed `.startAt(...)` on messages listener to avoid missing messages whose timestamps aren't set yet
 * - Extra debug logging to surface why notifications are being skipped
 * - Ensures heartbeat checks as the definitive "online" indicator for Jarif
 */

const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------
   Config / env parsing
   --------------------
   Expected environment variables (examples):
   - FIREBASE_SERVICE_ACCOUNT_KEY  (JSON string)
   - DISCORD_WEBHOOK_URL_PRIMARY
   - DISCORD_WEBHOOK_URL_SECONDARY
   - DISCORD_WEBHOOK_URL_TERTIARY
   - DISCORD_WEBHOOK_URL_JARIF
   - TARGET_FIDHA_ID (e.g. "7uvfii")
   - TARGET_JARIF_ID (e.g. "7uvjx")
*/
const WEBHOOKS = {
  primary:
    process.env.DISCORD_WEBHOOK_URL_PRIMARY ||
    process.env.DISCORD_WEBHOOK_URL ||
    null,
  secondary:
    process.env.DISCORD_WEBHOOK_URL_SECONDARY ||
    process.env.DISCORD_WEBHOOK_URL_2 ||
    null,
  tertiary:
    process.env.DISCORD_WEBHOOK_URL_TERTIARY ||
    process.env.DISCORD_WEBHOOK_URL_3 ||
    null,
  jarif:
    process.env.DISCORD_WEBHOOK_URL_JARIF ||
    process.env.JARIF_WEBHOOK_URL ||
    null,
};

// validate required envs: we need firebase key + at least one webhook
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error(
    "ERROR: FIREBASE_SERVICE_ACCOUNT_KEY environment variable is required."
  );
  process.exit(1);
}
if (
  !WEBHOOKS.primary &&
  !WEBHOOKS.secondary &&
  !WEBHOOKS.tertiary &&
  !WEBHOOKS.jarif
) {
  console.error(
    "ERROR: At least one Discord webhook env var is required (e.g. DISCORD_WEBHOOK_URL_PRIMARY)."
  );
  process.exit(1);
}

// Target user IDs (use these to match DB keys). Set these to 7uvfii / 7uvjx if that is how they appear in your DB.
const USER_FIDHA = process.env.TARGET_FIDHA_ID || "Fidha";
const USER_JARIF = process.env.TARGET_JARIF_ID || "Jarif";

/* --------------------
   Runtime state
   -------------------- */
let activeWebhook =
  WEBHOOKS.primary || WEBHOOKS.secondary || WEBHOOKS.tertiary || WEBHOOKS.jarif;
let activeWebhookName =
  activeWebhook === WEBHOOKS.primary
    ? "primary"
    : activeWebhook === WEBHOOKS.secondary
    ? "secondary"
    : activeWebhook === WEBHOOKS.tertiary
    ? "tertiary"
    : "jarif";
let webhookSwitchTime = 0;
let isRateLimited = false;
let rateLimitStartTime = 0;
let failedAttempts = 0;
const WEBHOOK_ROTATION_DURATION = 3 * 60 * 60 * 1000; // 3 hours

/* --------------------
   Firebase init
   -------------------- */
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (err) {
  console.error(
    "ERROR: Could not parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:",
    err.message
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://two-ephemeral-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

/* --------------------
   Notification tracking
   -------------------- */
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let processedJarifLoginIds = new Set();
let lastPresenceNotificationTime = 0;
let lastMessageNotificationTime = 0;
let lastLoginNotificationTime = 0;
const PRESENCE_COOLDOWN = 5000;
const MESSAGE_COOLDOWN = 10000;
const LOGIN_COOLDOWN = 5000;

/* --------------------
   Helpers
   -------------------- */
function formatBahrainTime(timestamp = Date.now()) {
  const now = new Date(Number(timestamp));
  return now.toLocaleTimeString("en-US", {
    timeZone: "Asia/Bahrain",
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatBahrainDateTime(timestamp = Date.now()) {
  const now = new Date(Number(timestamp));
  return now.toLocaleString("en-US", {
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

/* --------------------
   Webhook rotation
   -------------------- */
function rotateWebhook() {
  const now = Date.now();

  if (now - webhookSwitchTime < 60000) {
    return false;
  }

  console.log(`Attempting to rotate webhook from ${activeWebhookName}...`);

  if (activeWebhookName === "primary" && WEBHOOKS.secondary) {
    activeWebhook = WEBHOOKS.secondary;
    activeWebhookName = "secondary";
  } else if (activeWebhookName === "secondary" && WEBHOOKS.tertiary) {
    activeWebhook = WEBHOOKS.tertiary;
    activeWebhookName = "tertiary";
  } else if (activeWebhookName === "tertiary" && WEBHOOKS.primary) {
    activeWebhook = WEBHOOKS.primary;
    activeWebhookName = "primary";
  } else if (WEBHOOKS.primary) {
    activeWebhook = WEBHOOKS.primary;
    activeWebhookName = "primary";
  } else {
    // fallback to any available
    activeWebhook = WEBHOOKS.secondary || WEBHOOKS.tertiary || WEBHOOKS.jarif;
    activeWebhookName =
      activeWebhook === WEBHOOKS.secondary
        ? "secondary"
        : activeWebhook === WEBHOOKS.tertiary
        ? "tertiary"
        : "jarif";
  }

  webhookSwitchTime = now;
  isRateLimited = false;
  rateLimitStartTime = 0;
  failedAttempts = 0;

  console.log("Webhook rotation completed. Active webhook:", activeWebhookName);
  return true;
}

function checkWebhookRotation() {
  const now = Date.now();

  if (
    webhookSwitchTime > 0 &&
    now - webhookSwitchTime >= WEBHOOK_ROTATION_DURATION
  ) {
    if (activeWebhookName !== "primary" && WEBHOOKS.primary) {
      console.log("3 hours elapsed, rotating back to primary webhook");
      activeWebhook = WEBHOOKS.primary;
      activeWebhookName = "primary";
      webhookSwitchTime = now;
      isRateLimited = false;
      rateLimitStartTime = 0;
    }
  }

  if (
    isRateLimited &&
    rateLimitStartTime > 0 &&
    now - rateLimitStartTime > 30 * 60 * 1000
  ) {
    rotateWebhook();
  }
}

/* --------------------
   Jarif presence check (definitive)
   -------------------- */
async function checkJarifPresenceDirectly() {
  try {
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (!jarifPresence) {
      console.log("Jarif presence not found - treating as OFFLINE");
      return true; // Offline
    }

    const isOnlineFlag = jarifPresence.online === true;
    const lastHeartbeat = jarifPresence.heartbeat || 0;
    const now = Date.now();

    // Conservative criteria: online flag true AND heartbeat within 60s
    const isOffline = !isOnlineFlag || now - lastHeartbeat > 60000;

    if (isOffline) {
      console.log(
        `Jarif OFFLINE (online flag: ${isOnlineFlag}, heartbeat age: ${
          now - lastHeartbeat
        }ms)`
      );
    } else {
      console.log(`Jarif ONLINE (heartbeat age: ${now - lastHeartbeat}ms)`);
    }

    return isOffline;
  } catch (error) {
    console.error(`Error checking Jarif presence: ${error.message}`);
    return true; // Assume offline if error
  }
}

/* --------------------
   Discord notification sender
   -------------------- */
async function sendDiscordNotification(
  mention,
  embedDescription,
  webhookUrl = null,
  isActivity = false,
  isOffline = false,
  isLogin = false,
  isJarifLogin = false
) {
  let targetWebhookUrl = webhookUrl || activeWebhook;
  let targetWebhookName = isJarifLogin ? "jarif" : activeWebhookName;

  if (!targetWebhookUrl) {
    console.error("No webhook URL available - skipping send.");
    return;
  }

  const now = Date.now();

  // cooldowns
  if (isActivity || isOffline) {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      console.log("Presence cooldown active - skipping notification");
      return;
    }
  }
  if (!isActivity && !isOffline && !isLogin && !isJarifLogin) {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      console.log("Message cooldown active - skipping notification");
      return;
    }
  }
  if (isLogin || isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      console.log("Login cooldown active - skipping notification");
      return;
    }
  }

  const eventKey = `${
    isActivity
      ? "activity"
      : isOffline
      ? "offline"
      : isLogin
      ? "login"
      : isJarifLogin
      ? "jarif_login"
      : "message"
  }_${Math.floor(now / 1000)}`; // second-granularity

  if (processedPresenceEvents.has(eventKey)) {
    return;
  }
  processedPresenceEvents.add(eventKey);
  if (processedPresenceEvents.size > 200) {
    const arr = Array.from(processedPresenceEvents);
    processedPresenceEvents = new Set(arr.slice(-100));
  }

  const bahrainTime = formatBahrainTime();

  let footerText;
  if (isActivity) footerText = `Came online at ${bahrainTime}`;
  else if (isOffline) footerText = `Went offline at ${bahrainTime}`;
  else if (isLogin) footerText = `Accessed at ${bahrainTime}`;
  else if (isJarifLogin) footerText = `Logged in at ${bahrainTime}`;
  else footerText = `Sent at ${bahrainTime}`;

  let color = 10181046;
  if (isActivity) color = 3066993;
  if (isOffline) color = 15158332;
  if (isLogin) color = 16776960;
  if (isJarifLogin) color = 3447003;

  const webhookBody = {
    content: mention,
    embeds: [
      {
        description: embedDescription,
        color: color,
        footer: footerText ? { text: footerText } : undefined,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  console.log(
    `Posting to webhook (${targetWebhookName}): ${embedDescription.substring(
      0,
      80
    )}`
  );

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(targetWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; NotificationBot/1.0)",
      },
      body: JSON.stringify(webhookBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      console.error(`Rate limited on webhook ${targetWebhookName} (429)`);

      if (!isJarifLogin) {
        isRateLimited = true;
        rateLimitStartTime = now;
        failedAttempts++;
        rotateWebhook();
      }

      if (!isJarifLogin && activeWebhook !== targetWebhookUrl) {
        console.log("Retrying immediately with rotated webhook after 429...");
        setTimeout(() => {
          sendDiscordNotification(
            mention,
            embedDescription,
            activeWebhook,
            isActivity,
            isOffline,
            isLogin,
            isJarifLogin
          );
        }, 2000);
      }
    } else if (response.status === 403 || response.status === 404) {
      console.error(`Webhook ${targetWebhookName} invalid: ${response.status}`);
      if (!isJarifLogin) rotateWebhook();
    } else if (!response.ok) {
      const text = await response.text();
      console.error(
        `Discord webhook error (${targetWebhookName}): ${
          response.status
        } - ${text.substring(0, 200)}`
      );
      if (response.status >= 500 && !isJarifLogin) rotateWebhook();
    } else {
      console.log(`Notification sent to ${targetWebhookName}`);
      if (isActivity || isOffline) lastPresenceNotificationTime = now;
      else if (isLogin || isJarifLogin) lastLoginNotificationTime = now;
      else lastMessageNotificationTime = now;

      if (!isJarifLogin) {
        isRateLimited = false;
        failedAttempts = 0;
      }
    }
  } catch (error) {
    console.error(
      `Failed to send Discord notification (${targetWebhookName}): ${error.message}`
    );
    if (
      error.message.includes("Cloudflare") ||
      error.message.includes("rate limit") ||
      error.message.includes("banned")
    ) {
      if (!isJarifLogin) {
        isRateLimited = true;
        rateLimitStartTime = now;
        failedAttempts++;
        rotateWebhook();
      }
    }
    if (error.name === "AbortError") {
      console.error(`Request timeout for webhook ${targetWebhookName}`);
    }
  }
}

/* --------------------
   Message / activity checks
   -------------------- */
async function checkMessageForNotification(message) {
  // Robust sender matching: supports different field names
  const senderMatches =
    message.sender === USER_FIDHA ||
    message.senderId === USER_FIDHA ||
    message.from === USER_FIDHA ||
    message.uid === USER_FIDHA;

  if (!senderMatches) {
    // Not from target user
    return;
  }

  console.log(
    `Checking message from ${USER_FIDHA}: "${(message.text || "").substring(
      0,
      80
    )}"`
  );

  // ensure Jarif is offline before sending
  const jarifIsOffline = await checkJarifPresenceDirectly();
  if (!jarifIsOffline) {
    console.log("Jarif is ONLINE — skipping message notification.");
    return;
  }

  const messageTime = message.timestampFull || message.timestamp || Date.now();
  const bahrainDateTime = formatBahrainDateTime(messageTime);

  if (!message.id && message.key) message.id = message.key; // fallback
  if (processedMessageIds.has(message.id)) {
    console.log("Message already processed - skipping.");
    return;
  }

  // Get recipient's settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (err) {
    console.error("Error reading Jarif settings:", err.message);
    jarifSettings = null;
  }

  if (!jarifSettings || !jarifSettings.messageNotifications) {
    console.log("Jarif's message notifications are disabled - skipping.");
    return;
  }

  // Skip saved/read messages
  if (
    (message.savedBy && message.savedBy[USER_JARIF]) ||
    (message.readBy && message.readBy[USER_JARIF])
  ) {
    console.log("Message was saved/read by Jarif - skipping.");
    return;
  }

  const now = Date.now();
  if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
    console.log("Message cooldown active - skipping.");
    return;
  }

  let messageContent = message.text || "Attachment";
  if (message.attachment) {
    const fileType = message.isVoiceMessage
      ? "Voice message"
      : (message.attachment.type || "").startsWith("image/")
      ? "Image"
      : (message.attachment.type || "").startsWith("video/")
      ? "Video"
      : "File";
    messageContent = `[${fileType}: ${
      message.attachment.name || "Attachment"
    }]`;
  }

  if (messageContent.length > 500) {
    messageContent = messageContent.substring(0, 497) + "...";
  }

  console.log("SENDING MESSAGE NOTIFICATION — Jarif OFFLINE");
  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Fi✨ sent a message\`\n\n**Message:** ${messageContent}\n**Time:** ${bahrainDateTime}`
  );

  if (message.id) processedMessageIds.add(message.id);
  if (processedMessageIds.size > 2000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-1000));
  }
}

async function checkActivityForNotification(isActive) {
  console.log(`Fidha activity: ${isActive ? "ONLINE" : "OFFLINE"}`);

  const jarifIsOffline = await checkJarifPresenceDirectly();
  if (!jarifIsOffline) {
    console.log("Jarif is ONLINE — skipping activity notification.");
    return;
  }

  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (err) {
    console.error("Error reading Jarif settings:", err.message);
    return;
  }

  const wasOnline = previousFiOnlineState;
  const nowOnline = isActive;
  const bahrainDateTime = formatBahrainDateTime();
  const now = Date.now();

  if (wasOnline && !nowOnline) {
    // went offline
    if (jarifSettings && jarifSettings.offlineNotifications) {
      if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
        console.log("Presence cooldown active - skipping offline notification");
        return;
      }
      console.log("SENDING OFFLINE NOTIFICATION — Jarif OFFLINE");
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainDateTime}`,
        null,
        false,
        true
      );
    } else {
      console.log("Jarif has offline notifications disabled.");
    }
  } else if (!wasOnline && nowOnline) {
    // came online
    if (jarifSettings && jarifSettings.activityNotifications) {
      if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
        console.log("Presence cooldown active - skipping online notification");
        return;
      }
      console.log("SENDING ONLINE NOTIFICATION — Jarif OFFLINE");
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is now active\`\n\n**Time:** ${bahrainDateTime}`,
        null,
        true
      );
    } else {
      console.log("Jarif has activity notifications disabled.");
    }
  }

  previousFiOnlineState = nowOnline;
}

/* --------------------
   Jarif login notification
   -------------------- */
async function checkJarifLoginForNotification(loginData) {
  if (!WEBHOOKS.jarif) return;
  if (!loginData || !loginData.id) return;
  if (processedJarifLoginIds.has(loginData.id)) return;

  const deviceInfo = loginData.deviceInfo || {};
  const bahrainDateTime = formatBahrainDateTime(
    loginData.timestamp || Date.now()
  );

  let deviceDetails = `**Device Model:** ${
    deviceInfo.deviceModel || "Unknown"
  }\n`;
  deviceDetails += `**Device Type:** ${deviceInfo.deviceType || "Unknown"}\n`;
  deviceDetails += `**Platform:** ${deviceInfo.platform || "Unknown"}\n`;
  deviceDetails += `**Screen:** ${deviceInfo.screenSize || "Unknown"}\n`;
  deviceDetails += `**Window:** ${deviceInfo.windowSize || "Unknown"}\n`;
  deviceDetails += `**Device ID:** ${deviceInfo.deviceId || "Unknown"}\n`;
  deviceDetails += `**Timezone:** ${deviceInfo.timezone || "Unknown"}\n`;
  deviceDetails += `**Browser:** ${
    deviceInfo.userAgent ? deviceInfo.userAgent : "Unknown"
  }`;

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Jarif is now active\`\n\n${deviceDetails}\n\n**Login Time:** ${bahrainDateTime}`,
    WEBHOOKS.jarif,
    false,
    false,
    false,
    true
  );

  processedJarifLoginIds.add(loginData.id);
  if (processedJarifLoginIds.size > 200) {
    const arr = Array.from(processedJarifLoginIds);
    processedJarifLoginIds = new Set(arr.slice(-100));
  }
}

/* --------------------
   Login page access notifications
   -------------------- */
async function checkLoginPageAccess(loginData) {
  try {
    const userId = loginData.userId || "Unknown user";

    // skip if the opened user is Jarif (we only alert for others)
    if (
      userId === USER_JARIF ||
      (typeof userId === "string" && userId.includes(USER_JARIF))
    ) {
      return;
    }

    const timestamp = loginData.timestamp || Date.now();
    const bahrainDateTime = formatBahrainDateTime(timestamp);

    const deviceId = loginData.deviceId || "Unknown device";
    const deviceModel = loginData.deviceModel || "Unknown";
    const deviceType = loginData.deviceType || "Unknown";
    const userAgent = loginData.userAgent || "Unknown";
    const screenSize = loginData.screenSize || "Unknown";
    const windowSize = loginData.windowSize || "Unknown";
    const platform = loginData.platform || "Unknown";

    const deviceInfo = `**Device ID:** ${deviceId}\n**Model:** ${deviceModel} (${deviceType})\n**Platform:** ${platform}\n**Screen:** ${screenSize}\n**Window:** ${windowSize}`;

    console.log(`Sending login access notification for ${userId}`);

    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`🔓 Login page was opened\`\n\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${userAgent}\n**Time:** ${bahrainDateTime}`,
      null,
      false,
      false,
      true
    );
  } catch (error) {
    console.error(`Error checking login page access: ${error.message}`);
  }
}

/* --------------------
   Firebase listeners
   -------------------- */
function startFirebaseListeners() {
  console.log("Starting Firebase listeners...");

  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  let processedLoginIds = new Set();

  // Jarif login notifications
  jarifLoginRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;
      loginData.id = snapshot.key;
      await checkJarifLoginForNotification(loginData);
      // cleanup
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 60000);
    } catch (error) {
      console.error("Error processing Jarif login:", error.message);
    }
  });

  // Login page access notifications
  loginAccessRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;
      const loginId = snapshot.key;
      if (processedLoginIds.has(loginId)) {
        snapshot.ref.remove().catch(() => {});
        return;
      }

      await checkLoginPageAccess(loginData);
      processedLoginIds.add(loginId);
      if (processedLoginIds.size > 200) {
        const arr = Array.from(processedLoginIds);
        processedLoginIds = new Set(arr.slice(-100));
      }
      // cleanup after 1s
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 1000);
    } catch (error) {
      console.error("Error processing login access:", error.message);
    }
  });

  // cleanup old login records every 5 minutes
  setInterval(async () => {
    try {
      const snapshot = await loginAccessRef.once("value");
      const records = snapshot.val();
      if (!records) return;
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      Object.keys(records).forEach((key) => {
        const record = records[key];
        if (record.timestamp && record.timestamp < fiveMinutesAgo) {
          loginAccessRef
            .child(key)
            .remove()
            .catch(() => {});
        }
      });
    } catch (error) {
      console.error("Error cleaning old login records:", error.message);
    }
  }, 300000);

  // Messages listener - no startAt to avoid missing messages without timestampFull
  const messagesRef = db.ref("ephemeral/messages");
  console.log("Setting up message listener...");
  messagesRef.on("child_added", async (snapshot) => {
    try {
      const message = snapshot.val();
      if (!message) return;
      message.id = snapshot.key;

      const messageTime =
        message.timestampFull || message.timestamp || Date.now();
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      if (messageTime < fiveMinutesAgo) {
        // Skip old messages
        return;
      }

      console.log(
        `New message: sender=${
          message.sender || message.senderId || message.from || message.uid
        } text="${(message.text || "").substring(0, 60)}"`
      );
      await checkMessageForNotification(message);
    } catch (error) {
      console.error("Error processing message:", error.message);
    }
  });

  // Fidha presence listener with debounce
  let lastFiPresenceState = null;
  let fiPresenceDebounceTimer = null;

  console.log("Setting up Fidha presence listener...");
  db.ref(`ephemeral/presence/${USER_FIDHA}`).on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActiveFlag = val ? val.online === true : false;
      const heartbeat = val ? val.heartbeat || 0 : 0;
      const now = Date.now();

      // consider active if online flag true and heartbeat within 10s
      const actuallyActive = isActiveFlag && now - heartbeat < 10000;

      if (fiPresenceDebounceTimer) clearTimeout(fiPresenceDebounceTimer);
      fiPresenceDebounceTimer = setTimeout(async () => {
        if (lastFiPresenceState === actuallyActive) return;
        console.log(
          `Fidha presence change detected: ${lastFiPresenceState} -> ${actuallyActive}`
        );
        lastFiPresenceState = actuallyActive;
        await checkActivityForNotification(actuallyActive);
      }, 2000);
    } catch (error) {
      console.error("Error processing Fidha presence:", error.message);
    }
  });

  // blocked devices listener
  const blockedDevicesRef = db.ref("ephemeral/blockedDevices");
  blockedDevicesRef.on("child_added", (snapshot) => {
    try {
      const blockedDevice = snapshot.val();
      if (blockedDevice && blockedDevice.deviceId) {
        console.log(`Device blocked: ${blockedDevice.deviceId}`);
      }
    } catch (error) {
      console.error("Error processing blocked device:", error.message);
    }
  });

  console.log("Firebase listeners started successfully");
}

/* --------------------
   Express routes & startup
   -------------------- */
app.get("/", (req, res) => res.send("Notification Server is running."));
app.get("/health", (req, res) => res.send("OK"));
app.get("/webhook-status", (req, res) => {
  res.json({
    activeWebhook: activeWebhookName,
    isRateLimited,
    rateLimitedSince: rateLimitStartTime
      ? new Date(rateLimitStartTime).toISOString()
      : null,
    failedAttempts,
    webhookSwitchTime: webhookSwitchTime
      ? new Date(webhookSwitchTime).toISOString()
      : null,
    availableWebhooks: {
      primary: !!WEBHOOKS.primary,
      secondary: !!WEBHOOKS.secondary,
      tertiary: !!WEBHOOKS.tertiary,
      jarif: !!WEBHOOKS.jarif,
    },
  });
});

app.listen(PORT, () => {
  const bahrainDateTime = formatBahrainDateTime();
  console.log(`========================================`);
  console.log(`Notification Server is running on port ${PORT}`);
  console.log(`Server started at: ${bahrainDateTime} (Bahrain Time)`);
  console.log(`========================================`);
  console.log(`Webhook Configuration:`);
  console.log(`- Primary: ${WEBHOOKS.primary ? "✅ Available" : "❌ Not set"}`);
  console.log(
    `- Secondary: ${WEBHOOKS.secondary ? "✅ Available" : "❌ Not set"}`
  );
  console.log(
    `- Tertiary: ${WEBHOOKS.tertiary ? "✅ Available" : "❌ Not set"}`
  );
  console.log(`- Jarif: ${WEBHOOKS.jarif ? "✅ Available" : "❌ Not set"}`);
  console.log(`========================================`);
  console.log(`Notification Rules:`);
  console.log(`- Message notifications: When ${USER_JARIF} is OFFLINE`);
  console.log(`- Activity notifications: When ${USER_JARIF} is OFFLINE`);
  console.log(`Target IDs: Fidha=${USER_FIDHA}, Jarif=${USER_JARIF}`);
  console.log(`========================================`);

  setInterval(checkWebhookRotation, 60000);
  startFirebaseListeners();
});

/* --------------------
   Process handlers
   -------------------- */
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
