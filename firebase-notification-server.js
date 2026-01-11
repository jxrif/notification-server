const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook URLs with rotation support
const WEBHOOKS = {
  primary: process.env.DISCORD_WEBHOOK_URL,
  secondary: process.env.DISCORD_WEBHOOK_URL_2 || null,
  tertiary: process.env.DISCORD_WEBHOOK_URL_3 || null,
  jarif: process.env.JARIF_WEBHOOK_URL || null,
};

// Current active webhook
let activeWebhook = WEBHOOKS.primary;
let activeWebhookName = "primary";
let webhookSwitchTime = 0;
let isRateLimited = false;
let rateLimitStartTime = 0;
let failedAttempts = 0;
const WEBHOOK_ROTATION_DURATION = 3 * 60 * 60 * 1000; // 3 hours in milliseconds

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

// Load Firebase service account
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (error) {
  console.error("ERROR: Could not parse Firebase service account JSON.");
  process.exit(1);
}

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
    webhookSwitchTime: new Date(webhookSwitchTime).toISOString(),
    availableWebhooks: {
      primary: !!WEBHOOKS.primary,
      secondary: !!WEBHOOKS.secondary,
      tertiary: !!WEBHOOKS.tertiary,
      jarif: !!WEBHOOKS.jarif,
    },
  });
});

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://two-ephemeral-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

let jarifIsActuallyOffline = true;
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let processedJarifLoginIds = new Set();
let lastPresenceNotificationTime = 0;
let lastMessageNotificationTime = 0;
// Login cooldown tracking - ONLY to prevent duplicate notifications for same session
const LOGIN_COOLDOWN = 30000; // 30 seconds for same device/session
const PRESENCE_COOLDOWN = 5000;
const MESSAGE_COOLDOWN = 10000;

// Track last notification per device
const deviceNotificationCache = new Map();

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

function rotateWebhook() {
  const now = Date.now();

  // If we recently switched, don't switch again
  if (now - webhookSwitchTime < 60000) {
    return false;
  }

  console.log(`Attempting to rotate webhook from ${activeWebhookName}...`);

  if (activeWebhookName === "primary" && WEBHOOKS.secondary) {
    activeWebhook = WEBHOOKS.secondary;
    activeWebhookName = "secondary";
    console.log("Switched to secondary webhook");
  } else if (activeWebhookName === "secondary" && WEBHOOKS.tertiary) {
    activeWebhook = WEBHOOKS.tertiary;
    activeWebhookName = "tertiary";
    console.log("Switched to tertiary webhook");
  } else if (activeWebhookName === "tertiary" && WEBHOOKS.primary) {
    activeWebhook = WEBHOOKS.primary;
    activeWebhookName = "primary";
    console.log("Switched back to primary webhook");
  } else {
    activeWebhook = WEBHOOKS.primary;
    activeWebhookName = "primary";
    console.log("Falling back to primary webhook");
  }

  webhookSwitchTime = now;
  isRateLimited = false;
  rateLimitStartTime = 0;
  failedAttempts = 0;

  const rotationLog = {
    timestamp: new Date().toISOString(),
    from: activeWebhookName,
    reason: "Rate limit rotation",
    bahrainTime: formatBahrainDateTime(),
  };

  console.log("Webhook rotation:", rotationLog);

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
    console.error("No webhook URL available");
    return;
  }

  const now = Date.now();

  if (isActivity || isOffline) {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      return;
    }
    lastPresenceNotificationTime = now;
  }

  if (!isActivity && !isOffline && !isLogin && !isJarifLogin) {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      return;
    }
    lastMessageNotificationTime = now;
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
  }_${now}`;

  if (processedPresenceEvents.has(eventKey)) {
    return;
  }
  processedPresenceEvents.add(eventKey);

  if (processedPresenceEvents.size > 100) {
    const arr = Array.from(processedPresenceEvents);
    processedPresenceEvents = new Set(arr.slice(-50));
  }

  const bahrainTime = formatBahrainTime();

  let footerText;
  if (isActivity) {
    footerText = `Came online at ${bahrainTime}`;
  } else if (isOffline) {
    footerText = `Went offline at ${bahrainTime}`;
  } else if (isLogin) {
    footerText = `Accessed at ${bahrainTime}`;
  } else if (isJarifLogin) {
    footerText = `Logged in at ${bahrainTime}`;
  } else {
    footerText = `Sent at ${bahrainTime}`;
  }

  let color;
  if (isActivity) {
    color = 3066993; // Green
  } else if (isOffline) {
    color = 15158332; // Red
  } else if (isLogin) {
    color = 16776960; // Yellow
  } else if (isJarifLogin) {
    color = 3447003; // Blue
  } else {
    color = 10181046; // Purple
  }

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

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

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
      console.error(
        `Rate limited on webhook ${targetWebhookName}: ${response.status}`
      );

      if (!isJarifLogin) {
        isRateLimited = true;
        rateLimitStartTime = now;
        failedAttempts++;
        rotateWebhook();
      }

      if (!isJarifLogin && activeWebhook !== targetWebhookUrl) {
        console.log("Immediate retry with new webhook after rate limit");
        await sendDiscordNotification(
          mention,
          embedDescription,
          activeWebhook,
          isActivity,
          isOffline,
          isLogin,
          isJarifLogin
        );
      }
    } else if (response.status === 403 || response.status === 404) {
      console.error(`Webhook ${targetWebhookName} invalid: ${response.status}`);
      if (!isJarifLogin) {
        rotateWebhook();
      }
    } else if (!response.ok) {
      const text = await response.text();
      console.error(
        `Discord webhook error (${targetWebhookName}): ${
          response.status
        } - ${text.substring(0, 200)}`
      );

      if (response.status >= 500 && !isJarifLogin) {
        rotateWebhook();
      }
    } else {
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

        if (activeWebhook !== targetWebhookUrl) {
          console.log("Immediate retry with new webhook after Cloudflare ban");
          await sendDiscordNotification(
            mention,
            embedDescription,
            activeWebhook,
            isActivity,
            isOffline,
            isLogin,
            isJarifLogin
          );
        }
      }
    }

    if (error.name === "AbortError") {
      console.error(`Request timeout for webhook ${targetWebhookName}`);
    }
  }
}

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
    const lastSeen = jarifPresence.lastSeen || 0;
    const timeSinceLastSeen = Date.now() - lastSeen;
    const lastHeartbeat = jarifPresence.heartbeat || 0;
    const timeSinceHeartbeat = Date.now() - lastHeartbeat;

    // Jarif is considered offline if:
    // 1. online flag is false, OR
    // 2. no heartbeat in 60 seconds, OR
    // 3. no activity in 5 minutes
    jarifIsActuallyOffline =
      !isOnline || timeSinceHeartbeat > 60000 || timeSinceLastSeen > 300000;

    console.log(
      `Jarif presence check: online=${isOnline}, lastHeartbeat=${timeSinceHeartbeat}ms ago, lastSeen=${timeSinceLastSeen}ms ago, jarifIsActuallyOffline=${jarifIsActuallyOffline}`
    );
  } catch (error) {
    console.error(`Error checking Jarif presence: ${error.message}`);
    jarifIsActuallyOffline = true;
  }
}

async function checkMessageForNotification(message) {
  console.log(
    `[LOG] Message from ${message.sender}: ${message.text || "Attachment"}`
  );

  // Only send notifications for Fidha's messages
  if (message.sender !== USER_FIDHA) {
    return;
  }

  await checkJarifPresence();

  // Don't send notification if Jarif is online
  if (!jarifIsActuallyOffline) {
    console.log(`No notification - Jarif is online`);
    return;
  }

  const bahrainDateTime = formatBahrainDateTime(
    message.timestampFull || Date.now()
  );

  if (processedMessageIds.has(message.id)) {
    console.log(`Message ${message.id} already processed`);
    return;
  }

  // Check if Jarif has enabled notifications
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (error) {
    jarifSettings = null;
  }

  // If settings don't exist, create default with notifications ON
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

  // Don't send if message notifications are disabled
  if (!jarifSettings.messageNotifications) {
    console.log(`Message notifications disabled for Jarif`);
    return;
  }

  // Skip if message is saved by Jarif or already read
  if (message.savedBy && message.savedBy[USER_JARIF]) {
    console.log(`Message saved by Jarif, skipping notification`);
    return;
  }

  if (message.readBy && message.readBy[USER_JARIF]) {
    console.log(`Message already read by Jarif, skipping notification`);
    return;
  }

  // Prepare message content
  let messageContent;
  if (message.text) {
    messageContent = message.text;
  } else if (message.attachment) {
    if (message.attachment.isVoiceMessage) {
      messageContent = "🎤 Voice message";
    } else if (
      message.attachment.type &&
      message.attachment.type.startsWith("image/")
    ) {
      messageContent = "🖼️ Image";
    } else if (
      message.attachment.type &&
      message.attachment.type.startsWith("video/")
    ) {
      messageContent = "🎬 Video";
    } else if (
      message.attachment.type &&
      message.attachment.type.startsWith("audio/")
    ) {
      messageContent = "🔊 Audio file";
    } else {
      messageContent = `📎 File: ${message.attachment.name || "Attachment"}`;
    }
  } else {
    messageContent = "Empty message";
  }

  // Truncate long messages
  if (messageContent.length > 1000) {
    messageContent = messageContent.substring(0, 1000) + "...";
  }

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Fi✨ sent a message while you were offline\`\n\n**Message:** ${messageContent}\n**Time:** ${bahrainDateTime}`,
    null
  );

  console.log(`Notification sent for message ${message.id}`);
  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

async function checkActivityForNotification(isActive) {
  await checkJarifPresence();

  // Only send presence notifications if Jarif is offline
  if (!jarifIsActuallyOffline) {
    return;
  }

  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (error) {
    jarifSettings = {
      activityNotifications: true,
      offlineNotifications: true,
    };
  }

  const wasOnline = previousFiOnlineState;
  const nowOnline = isActive;
  const bahrainDateTime = formatBahrainDateTime();

  console.log(`Fidha activity: wasOnline=${wasOnline}, nowOnline=${nowOnline}`);

  // Fidha went OFFLINE
  if (wasOnline && !nowOnline) {
    if (jarifSettings && jarifSettings.offlineNotifications) {
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainDateTime}`,
        null,
        false,
        true
      );
      console.log(`Sent offline notification for Fidha`);
    }
  }
  // Fidha came ONLINE
  else if (!wasOnline && nowOnline) {
    if (jarifSettings && jarifSettings.activityNotifications) {
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is now active\`\n\n**Time:** ${bahrainDateTime}`,
        null,
        true
      );
      console.log(`Sent online notification for Fidha`);
    }
  }

  previousFiOnlineState = nowOnline;
}

async function checkJarifLoginForNotification(loginData) {
  if (!WEBHOOKS.jarif) {
    return;
  }

  const now = Date.now();
  const deviceId =
    loginData.deviceInfo?.deviceId || loginData.deviceId || "unknown";

  // Check if we recently notified for this device
  const lastNotificationTime = deviceNotificationCache.get(deviceId);

  // If we notified for this device in the last 30 seconds, skip
  if (lastNotificationTime && now - lastNotificationTime < LOGIN_COOLDOWN) {
    console.log(
      `Skipping login notification for device ${deviceId} - recently notified`
    );
    return;
  }

  const bahrainDateTime = formatBahrainDateTime(
    loginData.timestamp || Date.now()
  );

  let deviceDetails = `**Device Model:** ${
    loginData.deviceInfo?.deviceModel || "Unknown"
  }\n`;
  deviceDetails += `**Device Type:** ${
    loginData.deviceInfo?.deviceType || "Unknown"
  }\n`;
  deviceDetails += `**Platform:** ${
    loginData.deviceInfo?.platform || "Unknown"
  }\n`;
  deviceDetails += `**Screen:** ${
    loginData.deviceInfo?.screenSize || "Unknown"
  }\n`;
  deviceDetails += `**Window:** ${
    loginData.deviceInfo?.windowSize || "Unknown"
  }\n`;
  deviceDetails += `**Device ID:** ${deviceId}\n`;
  deviceDetails += `**Timezone:** ${
    loginData.deviceInfo?.timezone || "Unknown"
  }\n`;
  deviceDetails += `**Browser:** ${
    loginData.deviceInfo?.userAgent
      ? loginData.deviceInfo.userAgent.substring(0, 100)
      : "Unknown"
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

  console.log(`Sent Jarif login notification for device: ${deviceId}`);

  // Update cache
  deviceNotificationCache.set(deviceId, now);

  // Clean old entries from cache
  for (const [key, value] of deviceNotificationCache.entries()) {
    if (now - value > 5 * 60 * 1000) {
      // 5 minutes
      deviceNotificationCache.delete(key);
    }
  }

  // Track as processed to avoid duplicates from same data
  processedJarifLoginIds.add(loginData.id);

  if (processedJarifLoginIds.size > 1000) {
    const arr = Array.from(processedJarifLoginIds);
    processedJarifLoginIds = new Set(arr.slice(-500));
  }
}

async function checkLoginPageAccess(loginData) {
  try {
    const userId = loginData.userId || "Unknown user";

    if (userId === USER_JARIF || userId.includes(USER_JARIF)) {
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
    const timezone = loginData.timezone || "Unknown";

    const deviceInfo = `**Device ID:** ${deviceId}\n**Model:** ${deviceModel} (${deviceType})\n**Platform:** ${platform}\n**Screen:** ${screenSize}\n**Window:** ${windowSize}`;

    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`🔓 Login page was opened\`\n\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${userAgent.substring(
        0,
        200
      )}\n**Time:** ${bahrainDateTime}`,
      null,
      false,
      false,
      true
    );
  } catch (error) {
    console.error(`Error checking login page access: ${error.message}`);
  }
}

// Track login state to detect when Jarif goes from offline to online
let jarifLoginState = {
  wasOffline: true,
  lastOfflineToOnlineTime: 0,
  lastOnlineCheck: 0,
};

async function detectJarifLogin() {
  try {
    const now = Date.now();

    // Only check every 10 seconds
    if (now - jarifLoginState.lastOnlineCheck < 10000) {
      return;
    }

    jarifLoginState.lastOnlineCheck = now;

    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (!jarifPresence) {
      jarifLoginState.wasOffline = true;
      return;
    }

    const isCurrentlyOnline = jarifPresence.online === true;
    const lastHeartbeat = jarifPresence.heartbeat || 0;
    const timeSinceHeartbeat = now - lastHeartbeat;
    const isActuallyOnline = isCurrentlyOnline && timeSinceHeartbeat < 30000; // 30 seconds threshold

    console.log(
      `Jarif login detection: isActuallyOnline=${isActuallyOnline}, wasOffline=${jarifLoginState.wasOffline}`
    );

    // Detect transition from offline to online
    if (jarifLoginState.wasOffline && isActuallyOnline) {
      // Check if we recently sent a login notification
      if (now - jarifLoginState.lastOfflineToOnlineTime > 2 * 60 * 1000) {
        // 2 minutes cooldown for same device
        console.log(`Detected Jarif login transition from offline to online`);

        // Get device info from user sessions
        try {
          const sessionsSnap = await db
            .ref("ephemeral/userSessions")
            .once("value");
          const sessions = sessionsSnap.val();

          let jarifDevice = null;
          if (sessions) {
            for (const [sessionId, session] of Object.entries(sessions)) {
              if (session && session.user === USER_JARIF) {
                const sessionDeviceId =
                  session.deviceInfo?.deviceId || session.deviceId;
                if (sessionDeviceId) {
                  // Check if this session is recently active
                  const lastActive =
                    session.lastActive || session.lastUpdated || 0;
                  if (now - lastActive < 60000) {
                    // Active in last minute
                    jarifDevice = session;
                    break;
                  }
                }
              }
            }
          }

          if (jarifDevice) {
            const loginData = {
              id: `login_${now}`,
              user: USER_JARIF,
              timestamp: now,
              deviceInfo: jarifDevice.deviceInfo || {},
              deviceId:
                jarifDevice.deviceInfo?.deviceId || jarifDevice.deviceId,
              notification: "7uvjx logged in (presence detection)",
              forceNotification: true,
            };

            await checkJarifLoginForNotification(loginData);
            jarifLoginState.lastOfflineToOnlineTime = now;
          }
        } catch (error) {
          console.error(`Error getting Jarif device info: ${error.message}`);
        }
      }
    }

    // Update state
    jarifLoginState.wasOffline = !isActuallyOnline;
  } catch (error) {
    console.error(`Error detecting Jarif login: ${error.message}`);
    jarifLoginState.wasOffline = true;
  }
}

function startFirebaseListeners() {
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  let processedLoginIds = new Set();

  // Listen to jarifLogins - these are pushed when Jarif logs in
  jarifLoginRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      loginData.id = snapshot.key;
      console.log(
        `Jarif login detected via jarifLogins: ${JSON.stringify(loginData)}`
      );

      // Send notification for this login
      await checkJarifLoginForNotification(loginData);

      // Clean up old login data after sending notification
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 30000); // 30 seconds
    } catch (error) {
      console.error(`Error processing Jarif login: ${error.message}`);
    }
  });

  loginAccessRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      const loginId = snapshot.key;

      if (processedLoginIds.has(loginId)) {
        snapshot.ref.remove().catch(() => {});
        return;
      }

      console.log(`Login access: ${JSON.stringify(loginData)}`);
      await checkLoginPageAccess(loginData);

      processedLoginIds.add(loginId);

      if (processedLoginIds.size > 100) {
        const arr = Array.from(processedLoginIds);
        processedLoginIds = new Set(arr.slice(-50));
      }

      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 1000);
    } catch (error) {
      console.error(`Error processing login access: ${error.message}`);
    }
  });

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
      console.error(`Error cleaning old login records: ${error.message}`);
    }
  }, 300000);

  // Listen to ALL messages, not just recent ones
  const messagesRef = db.ref("ephemeral/messages");

  messagesRef.on("child_added", async (snapshot) => {
    try {
      const message = snapshot.val();
      if (!message) return;

      message.id = snapshot.key;

      // Log EVERY message (both Fidha and Jarif) to console
      const messageTime = new Date(
        message.timestampFull || Date.now()
      ).toISOString();
      const sender = message.sender === USER_FIDHA ? "Fi✨" : "7uvjx";
      const content =
        message.text || (message.attachment ? "Attachment" : "Empty");

      console.log(`[MESSAGE LOG] ${messageTime} - ${sender}: ${content}`);

      // Check for notification only for recent messages (last 5 minutes)
      const messageTimestamp = message.timestampFull || Date.now();
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      if (messageTimestamp >= fiveMinutesAgo) {
        await checkMessageForNotification(message);
      }
    } catch (error) {
      console.error(`Error processing message: ${error.message}`);
    }
  });

  // Also listen to child_changed for edits
  messagesRef.on("child_changed", async (snapshot) => {
    try {
      const message = snapshot.val();
      if (!message) return;

      message.id = snapshot.key;

      // Log edited messages too
      const messageTime = new Date(
        message.timestampFull || Date.now()
      ).toISOString();
      const sender = message.sender === USER_FIDHA ? "Fi✨" : "7uvjx";
      const content =
        message.text || (message.attachment ? "Attachment" : "Empty");

      console.log(`[MESSAGE EDIT] ${messageTime} - ${sender}: ${content}`);
    } catch (error) {
      console.error(`Error processing message edit: ${error.message}`);
    }
  });

  let lastFiPresenceState = null;
  db.ref("ephemeral/presence/Fidha").on("value", async (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online === true : false;

      console.log(
        `Fidha presence update: online=${isActive}, value=${JSON.stringify(
          val
        )}`
      );

      if (lastFiPresenceState === isActive) {
        return;
      }

      lastFiPresenceState = isActive;
      await checkActivityForNotification(isActive);
    } catch (error) {
      console.error(`Error processing Fi presence: ${error.message}`);
    }
  });

  db.ref("ephemeral/presence/Jarif").on("value", async (snapshot) => {
    try {
      const val = snapshot.val();
      const isOnline = val ? val.online === true : false;

      console.log(
        `Jarif presence update: online=${isOnline}, value=${JSON.stringify(
          val
        )}`
      );

      // Update Jarif's offline status
      if (val) {
        const lastHeartbeat = val.heartbeat || 0;
        const timeSinceHeartbeat = Date.now() - lastHeartbeat;

        // Jarif is offline if no heartbeat in 60 seconds
        jarifIsActuallyOffline = !isOnline || timeSinceHeartbeat > 60000;

        console.log(
          `Jarif offline status updated: ${jarifIsActuallyOffline} (heartbeat ${timeSinceHeartbeat}ms ago)`
        );
      } else {
        jarifIsActuallyOffline = true;
      }
    } catch (error) {
      console.error(`Error processing Jarif presence: ${error.message}`);
      jarifIsActuallyOffline = true;
    }
  });

  const blockedDevicesRef = db.ref("ephemeral/blockedDevices");
  blockedDevicesRef.on("child_added", (snapshot) => {
    try {
      const blockedDevice = snapshot.val();
      if (blockedDevice && blockedDevice.deviceId) {
        console.log(`Device blocked: ${blockedDevice.deviceId}`);
      }
    } catch (error) {
      console.error(`Error processing blocked device: ${error.message}`);
    }
  });
}

// Start webhook rotation checker
setInterval(checkWebhookRotation, 60000);

// Check Jarif presence every 30 seconds
setInterval(async () => {
  await checkJarifPresence();
}, 30000);

// Detect Jarif logins periodically
setInterval(async () => {
  await detectJarifLogin();
}, 15000); // Check every 15 seconds

startFirebaseListeners();
app.listen(PORT, () => {
  const bahrainDateTime = formatBahrainDateTime();
  console.log(`Notification Server is running on port ${PORT}`);
  console.log(`Server started at: ${bahrainDateTime} (Bahrain Time)`);
  console.log(
    `Available webhooks: Primary=${!!WEBHOOKS.primary}, Secondary=${!!WEBHOOKS.secondary}, Tertiary=${!!WEBHOOKS.tertiary}, Jarif=${!!WEBHOOKS.jarif}`
  );
  console.log(`Jarif's Discord ID: 765280345260032030`);
  console.log(
    `IMPORTANT: Jarif login notifications will be sent for EVERY login (with 2-minute cooldown for presence detection)`
  );
});

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
