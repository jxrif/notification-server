const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required environment variables
const REQUIRED_ENV_VARS = [
  "DISCORD_WEBHOOK_URL",
  "FIREBASE_SERVICE_ACCOUNT_KEY",
];

for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    console.error(`ERROR: ${envVar} environment variable is required.`);
    process.exit(1);
  }
}

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

// Initialize Express routes
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

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://two-ephemeral-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

// Notification tracking variables
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

// Helper functions
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

// Webhook management
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
    // If no rotation available, try primary again
    activeWebhook = WEBHOOKS.primary;
    activeWebhookName = "primary";
    console.log("Falling back to primary webhook");
  }

  webhookSwitchTime = now;
  isRateLimited = false;
  rateLimitStartTime = 0;
  failedAttempts = 0;

  // Log the rotation
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

  // Check if we've been using a backup webhook for more than 3 hours
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

  // If rate limited for more than 30 minutes, try to rotate
  if (
    isRateLimited &&
    rateLimitStartTime > 0 &&
    now - rateLimitStartTime > 30 * 60 * 1000
  ) {
    rotateWebhook();
  }
}

// CRITICAL FIX: Direct Jarif presence checking
async function checkJarifPresenceDirectly() {
  try {
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (!jarifPresence) {
      console.log("Jarif presence not found - assuming offline");
      return true; // Offline
    }

    const isOnline = jarifPresence.online === true;
    const lastHeartbeat = jarifPresence.heartbeat || 0;
    const now = Date.now();

    // Jarif is considered OFFLINE if:
    // 1. online flag is false, OR
    // 2. no heartbeat in last 60 seconds (more conservative)
    const isOffline = !isOnline || now - lastHeartbeat > 60000;

    if (isOffline) {
      console.log(
        `Jarif is OFFLINE - online: ${isOnline}, last heartbeat: ${
          now - lastHeartbeat
        }ms ago`
      );
    } else {
      console.log(
        `Jarif is ONLINE - online: ${isOnline}, last heartbeat: ${
          now - lastHeartbeat
        }ms ago`
      );
    }

    return isOffline;
  } catch (error) {
    console.error(`Error checking Jarif presence: ${error.message}`);
    return true; // Assume offline on error
  }
}

// Send Discord notification
async function sendDiscordNotification(
  mention,
  embedDescription,
  webhookUrl = null,
  isActivity = false,
  isOffline = false,
  isLogin = false,
  isJarifLogin = false
) {
  // Use provided webhook URL or default to active webhook
  let targetWebhookUrl = webhookUrl || activeWebhook;
  let targetWebhookName = isJarifLogin ? "jarif" : activeWebhookName;

  if (!targetWebhookUrl) {
    console.error("No webhook URL available");
    return;
  }

  const now = Date.now();

  // Apply cooldowns
  if (isActivity || isOffline) {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      console.log(`Presence cooldown active - skipping notification`);
      return;
    }
  }

  if (!isActivity && !isOffline && !isLogin && !isJarifLogin) {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      console.log(`Message cooldown active - skipping notification`);
      return;
    }
  }

  if (isLogin || isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      console.log(`Login cooldown active - skipping notification`);
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

  console.log(
    `Sending notification to ${targetWebhookName}: ${embedDescription.substring(
      0,
      50
    )}...`
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
      console.error(
        `Rate limited on webhook ${targetWebhookName}: ${response.status}`
      );

      if (!isJarifLogin) {
        isRateLimited = true;
        rateLimitStartTime = now;
        failedAttempts++;
        rotateWebhook();
      }

      // Try immediate retry with new webhook
      if (!isJarifLogin && activeWebhook !== targetWebhookUrl) {
        console.log("Immediate retry with new webhook after rate limit");
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
      console.log(`Notification sent successfully to ${targetWebhookName}`);

      // Update timestamps
      if (isActivity || isOffline) {
        lastPresenceNotificationTime = now;
      } else if (isLogin || isJarifLogin) {
        lastLoginNotificationTime = now;
      } else {
        lastMessageNotificationTime = now;
      }

      // Reset rate limit tracking
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

// FIXED: Check message for notification
async function checkMessageForNotification(message) {
  // Only notify for Fidha's messages
  if (message.sender !== USER_FIDHA) {
    return;
  }

  console.log(
    `Checking message from Fidha: ${
      message.text?.substring(0, 50) || "Attachment"
    }`
  );

  // CRITICAL: Check if Jarif is actually offline
  const jarifIsOffline = await checkJarifPresenceDirectly();

  if (!jarifIsOffline) {
    console.log(`Jarif is ONLINE - NOT sending message notification`);
    return;
  }

  const bahrainDateTime = formatBahrainDateTime(
    message.timestampFull || Date.now()
  );

  if (processedMessageIds.has(message.id)) {
    return;
  }

  // Check Jarif's notification settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (error) {
    console.error(`Error getting Jarif settings: ${error.message}`);
    jarifSettings = null;
  }

  // Only send if message notifications are enabled
  if (!jarifSettings || !jarifSettings.messageNotifications) {
    console.log(`Jarif has message notifications disabled`);
    return;
  }

  // Skip saved messages or already read messages
  if (message.savedBy && message.savedBy[USER_JARIF]) {
    console.log(`Message already saved by Jarif - skipping`);
    return;
  }

  if (message.readBy && message.readBy[USER_JARIF]) {
    console.log(`Message already read by Jarif - skipping`);
    return;
  }

  // Check cooldown
  const now = Date.now();
  if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
    console.log(`Message cooldown active - skipping`);
    return;
  }

  // Create message content
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

  // Truncate if too long
  if (messageContent.length > 500) {
    messageContent = messageContent.substring(0, 497) + "...";
  }

  console.log(`SENDING MESSAGE NOTIFICATION - Jarif is OFFLINE`);

  // Send notification
  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Fi✨ sent a message\`\n\n**Message:** ${messageContent}\n**Time:** ${bahrainDateTime}`
  );

  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

// FIXED: Check activity for notification
async function checkActivityForNotification(isActive) {
  console.log(`Fidha activity changed: ${isActive ? "ONLINE" : "OFFLINE"}`);

  // CRITICAL: Check if Jarif is actually offline
  const jarifIsOffline = await checkJarifPresenceDirectly();

  if (!jarifIsOffline) {
    console.log(`Jarif is ONLINE - NOT sending activity notification`);
    return;
  }

  // Check Jarif's notification settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (error) {
    console.error(`Error getting Jarif settings: ${error.message}`);
    return;
  }

  const wasOnline = previousFiOnlineState;
  const nowOnline = isActive;
  const bahrainDateTime = formatBahrainDateTime();

  // Check cooldown
  const now = Date.now();

  if (wasOnline && !nowOnline) {
    // Fi went offline
    if (jarifSettings && jarifSettings.offlineNotifications) {
      if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
        console.log(`Presence cooldown active - skipping offline notification`);
        return;
      }

      console.log(`SENDING OFFLINE NOTIFICATION - Jarif is OFFLINE`);

      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainDateTime}`,
        null,
        false,
        true
      );
    } else {
      console.log(`Jarif has offline notifications disabled`);
    }
  } else if (!wasOnline && nowOnline) {
    // Fi came online
    if (jarifSettings && jarifSettings.activityNotifications) {
      if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
        console.log(`Presence cooldown active - skipping online notification`);
        return;
      }

      console.log(`SENDING ONLINE NOTIFICATION - Jarif is OFFLINE`);

      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is now active\`\n\n**Time:** ${bahrainDateTime}`,
        null,
        true
      );
    } else {
      console.log(`Jarif has activity notifications disabled`);
    }
  }

  previousFiOnlineState = nowOnline;
}

// Check Jarif login for notification
async function checkJarifLoginForNotification(loginData) {
  if (!WEBHOOKS.jarif) {
    return;
  }

  if (processedJarifLoginIds.has(loginData.id)) {
    return;
  }

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
  deviceDetails += `**Device ID:** ${
    deviceInfo.deviceId ? deviceInfo.deviceId : "Unknown"
  }\n`;
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

  if (processedJarifLoginIds.size > 100) {
    const arr = Array.from(processedJarifLoginIds);
    processedJarifLoginIds = new Set(arr.slice(-50));
  }
}

// Check login page access
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

// FIXED: Start Firebase listeners
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

      // Clean up after 1 minute
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 60000);
    } catch (error) {
      console.error(`Error processing Jarif login: ${error.message}`);
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

      if (processedLoginIds.size > 100) {
        const arr = Array.from(processedLoginIds);
        processedLoginIds = new Set(arr.slice(-50));
      }

      // Clean up after 1 second
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 1000);
    } catch (error) {
      console.error(`Error processing login access: ${error.message}`);
    }
  });

  // Clean up old login records every 5 minutes
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

  // FIXED: Messages listener - Only send notifications when Jarif is offline
  const messagesRef = db.ref("ephemeral/messages");
  console.log("Setting up message listener...");

  messagesRef
    .orderByChild("timestampFull")
    .startAt(Date.now() - 60000) // Only check recent messages (last minute)
    .on("child_added", async (snapshot) => {
      try {
        const message = snapshot.val();
        if (!message) return;

        message.id = snapshot.key;

        // Skip messages older than 5 minutes
        const messageTime = message.timestampFull || Date.now();
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

        if (messageTime < fiveMinutesAgo) {
          return;
        }

        console.log(
          `New message detected: ${message.sender} - ${
            message.text?.substring(0, 30) || "Attachment"
          }`
        );
        await checkMessageForNotification(message);
      } catch (error) {
        console.error(`Error processing message: ${error.message}`);
      }
    });

  // FIXED: Fidha presence listener with debouncing
  let lastFiPresenceState = null;
  let lastFiPresenceCheck = 0;
  let fiPresenceDebounceTimer = null;

  console.log("Setting up Fidha presence listener...");

  db.ref("ephemeral/presence/Fidha").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online === true : false;
      const heartbeat = val ? val.heartbeat || 0 : 0;
      const now = Date.now();

      // More accurate online check using heartbeat
      const actuallyActive = isActive && now - heartbeat < 10000;

      // Debounce presence changes (2 seconds)
      if (fiPresenceDebounceTimer) {
        clearTimeout(fiPresenceDebounceTimer);
      }

      fiPresenceDebounceTimer = setTimeout(async () => {
        if (lastFiPresenceState === actuallyActive) {
          return;
        }

        console.log(
          `Fidha presence changed: ${lastFiPresenceState} -> ${actuallyActive}`
        );
        lastFiPresenceState = actuallyActive;
        await checkActivityForNotification(actuallyActive);
      }, 2000);
    } catch (error) {
      console.error(`Error processing Fi presence: ${error.message}`);
    }
  });

  // Blocked devices listener
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

  console.log("Firebase listeners started successfully");
}

// Start the server
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
  console.log(`- Message notifications: When Jarif is OFFLINE`);
  console.log(`- Activity notifications: When Jarif is OFFLINE`);
  console.log(`========================================`);

  // Start webhook rotation checker
  setInterval(checkWebhookRotation, 60000);

  // Start Firebase listeners
  startFirebaseListeners();
});

// Process cleanup handlers
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
