// firebase-notification-server.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV: Only webhook URLs are required via env as requested ---
const WEBHOOKS = {
  primary: process.env.DISCORD_WEBHOOK_URL || null,
  secondary: process.env.DISCORD_WEBHOOK_URL_2 || null,
  tertiary: process.env.DISCORD_WEBHOOK_URL_3 || null,
  jarif: process.env.DISCORD_WEBHOOK_URL_JARIF || null,
};

if (!WEBHOOKS.primary) {
  console.error(
    "ERROR: DISCORD_WEBHOOK_URL (primary) environment variable is required."
  );
  process.exit(1);
}

// --- Constants (left in code) ---
const USER_FIDHA = "7uvfii"; // monitor this ID for activity/messages
const USER_JARIF = "7uvjx"; // check this ID's presence to decide whether to notify

const WEBHOOK_ROTATION_DURATION = 3 * 60 * 60 * 1000; // 3 hours
const PRESENCE_COOLDOWN = 5000;
const MESSAGE_COOLDOWN = 10000;
const LOGIN_COOLDOWN = 5000;

// Firebase service account: prefer env, else try local file
let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } catch (err) {
    console.warn(
      "WARN: FIREBASE_SERVICE_ACCOUNT_KEY exists but failed to parse. Will try local file."
    );
  }
}

if (!serviceAccount) {
  const localPath = path.join(__dirname, "firebase-service-account.json");
  if (fs.existsSync(localPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(localPath, "utf8"));
      console.log("Loaded Firebase service account from local file.");
    } catch (err) {
      console.error(
        "ERROR: Failed to parse local firebase-service-account.json:",
        err.message
      );
      process.exit(1);
    }
  } else {
    console.error(
      "ERROR: No Firebase service account found. Set FIREBASE_SERVICE_ACCOUNT_KEY env or place firebase-service-account.json in the server directory."
    );
    process.exit(1);
  }
}

// --- Express endpoints ---
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

// --- Initialize Firebase ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://two-ephemeral-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const db = admin.database();

// --- Notification tracking ---
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let processedJarifLoginIds = new Set();
let lastPresenceNotificationTime = 0;
let lastMessageNotificationTime = 0;
let lastLoginNotificationTime = 0;
let webhookSwitchTime = 0;
let isRateLimited = false;
let rateLimitStartTime = 0;
let failedAttempts = 0;
let activeWebhook = WEBHOOKS.primary;
let activeWebhookName = "primary";

// --- Helpers ---
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

// --- Webhook rotation ---
function rotateWebhook() {
  const now = Date.now();
  if (now - webhookSwitchTime < 60000) return false;

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
  } else {
    activeWebhook = WEBHOOKS.primary;
    activeWebhookName = "primary";
  }

  webhookSwitchTime = now;
  isRateLimited = false;
  rateLimitStartTime = 0;
  failedAttempts = 0;

  console.log(`Switched to webhook: ${activeWebhookName}`);
  return true;
}

function checkWebhookRotation() {
  const now = Date.now();
  if (
    webhookSwitchTime > 0 &&
    now - webhookSwitchTime >= WEBHOOK_ROTATION_DURATION
  ) {
    if (activeWebhookName !== "primary" && WEBHOOKS.primary) {
      activeWebhook = WEBHOOKS.primary;
      activeWebhookName = "primary";
      webhookSwitchTime = now;
      isRateLimited = false;
      rateLimitStartTime = 0;
      console.log("3 hours elapsed, rotating back to primary webhook");
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

// --- Check Jarif presence directly ---
async function checkJarifPresenceDirectly() {
  try {
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (!jarifPresence) {
      console.log("Jarif presence not found - assuming offline");
      return true;
    }

    const isOnline = jarifPresence.online === true;
    const lastHeartbeat =
      jarifPresence.heartbeat || jarifPresence.lastSeen || 0;
    const now = Date.now();

    const isOffline = !isOnline || now - lastHeartbeat > 60000;

    if (isOffline) {
      console.log(
        `Jarif considered OFFLINE - online:${isOnline}, last heartbeat ${
          now - lastHeartbeat
        }ms ago`
      );
    } else {
      console.log(
        `Jarif considered ONLINE - online:${isOnline}, last heartbeat ${
          now - lastHeartbeat
        }ms ago`
      );
    }

    return isOffline;
  } catch (error) {
    console.error(`Error checking Jarif presence: ${error.message}`);
    // conservative: assume offline so notifications can go out
    return true;
  }
}

// --- Send Discord notification ---
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
    console.error("No webhook URL available for notification.");
    return;
  }

  const now = Date.now();

  // cooldowns
  if (isActivity || isOffline) {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      console.log("Presence cooldown active - skipping");
      return;
    }
  }

  if (!isActivity && !isOffline && !isLogin && !isJarifLogin) {
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      console.log("Message cooldown active - skipping");
      return;
    }
  }

  if (isLogin || isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      console.log("Login cooldown active - skipping");
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
  if (processedPresenceEvents.has(eventKey)) return;
  processedPresenceEvents.add(eventKey);
  if (processedPresenceEvents.size > 100) {
    const arr = Array.from(processedPresenceEvents);
    processedPresenceEvents = new Set(arr.slice(-50));
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
  else if (isOffline) color = 15158332;
  else if (isLogin) color = 16776960;
  else if (isJarifLogin) color = 3447003;

  const webhookBody = {
    content: mention,
    embeds: [
      {
        description: embedDescription,
        color,
        footer: footerText ? { text: footerText } : undefined,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  console.log(
    `Sending notification to ${targetWebhookName}: ${embedDescription.substring(
      0,
      80
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

      if (!isJarifLogin && activeWebhook !== targetWebhookUrl) {
        console.log("Retrying immediate notification on rotated webhook...");
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
      console.log(`Notification sent successfully to ${targetWebhookName}`);
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
    if (!isJarifLogin) {
      if (
        error.message.includes("Cloudflare") ||
        error.message.includes("rate limit") ||
        error.message.includes("banned")
      ) {
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

// --- Check message for notification ---
async function checkMessageForNotification(message) {
  // support multiple possible sender fields and formats
  const senderIdentifiers = new Set(
    [
      message.sender,
      message.senderId,
      message.from,
      message.userId,
      message.uid,
    ].filter(Boolean)
  );

  if (
    ![...senderIdentifiers].some(
      (s) => String(s).includes(USER_FIDHA) || String(s) === USER_FIDHA
    )
  ) {
    return;
  }

  console.log(
    `Checking message from ${[...senderIdentifiers].join("|")}: ${
      message.text?.substring(0, 50) || "Attachment"
    }`
  );

  // CRITICAL: Check Jarif presence directly
  const jarifIsOffline = await checkJarifPresenceDirectly();
  if (!jarifIsOffline) {
    console.log("Jarif is ONLINE - not sending message notification.");
    return;
  }

  const messageTime = message.timestampFull || message.timestamp || Date.now();
  const bahrainDateTime = formatBahrainDateTime(messageTime);

  if (!message.id && message.key) message.id = message.key;
  if (!message.id) {
    // fallback to timestamp + random if no id
    message.id = `msg_${messageTime}_${Math.random().toString(36).slice(2, 8)}`;
  }

  if (processedMessageIds.has(message.id)) return;

  // load jarif settings; if missing, treat notifications as enabled
  let jarifSettings = null;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (err) {
    console.warn("Error reading jarif settings:", err.message);
  }

  if (jarifSettings && jarifSettings.messageNotifications === false) {
    console.log(
      "Jarif has message notifications disabled (explicit). Skipping."
    );
    return;
  }

  // skip if message saved/read by Jarif
  if (message.savedBy && message.savedBy[USER_JARIF]) {
    console.log("Message saved by Jarif - skipping");
    return;
  }
  if (message.readBy && message.readBy[USER_JARIF]) {
    console.log("Message already read by Jarif - skipping");
    return;
  }

  // cooldown check
  const now = Date.now();
  if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
    console.log("Message cooldown active - skipping");
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

  console.log("SENDING MESSAGE NOTIFICATION - Jarif is OFFLINE");
  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`7uvfii sent a message\`\n\n**Message:** ${messageContent}\n**Time:** ${bahrainDateTime}`
  );

  processedMessageIds.add(message.id);
  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

// --- Check activity for notification ---
async function checkActivityForNotification(isActive) {
  console.log(`7uvfii activity changed: ${isActive ? "ONLINE" : "OFFLINE"}`);

  // CRITICAL: Check Jarif presence directly
  const jarifIsOffline = await checkJarifPresenceDirectly();
  if (!jarifIsOffline) {
    console.log("Jarif is ONLINE - not sending presence notification.");
    previousFiOnlineState = isActive;
    return;
  }

  // load jarif settings; missing = enabled
  let jarifSettings = null;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (err) {
    console.warn("Error reading jarif settings:", err.message);
  }

  const now = Date.now();

  // If was online and now offline -> send offline notification (if enabled)
  if (previousFiOnlineState && !isActive) {
    if (jarifSettings && jarifSettings.offlineNotifications === false) {
      console.log(
        "Jarif has offline notifications disabled. Skipping offline notice."
      );
    } else {
      if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
        console.log("Presence cooldown active - skipping offline notification");
      } else {
        console.log("SENDING OFFLINE NOTIFICATION - Jarif is OFFLINE");
        await sendDiscordNotification(
          `<@765280345260032030>`,
          `\`7uvfii is no longer active\`\n\n**Time:** ${formatBahrainDateTime()}`,
          null,
          false,
          true
        );
      }
    }
  } else if (!previousFiOnlineState && isActive) {
    // came online
    if (jarifSettings && jarifSettings.activityNotifications === false) {
      console.log(
        "Jarif has activity notifications disabled. Skipping online notice."
      );
    } else {
      if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
        console.log("Presence cooldown active - skipping online notification");
      } else {
        console.log("SENDING ONLINE NOTIFICATION - Jarif is OFFLINE");
        await sendDiscordNotification(
          `<@765280345260032030>`,
          `\`7uvfii is now active\`\n\n**Time:** ${formatBahrainDateTime()}`,
          null,
          true
        );
      }
    }
  }

  previousFiOnlineState = isActive;
}

// --- Jarif login notification (to jarif webhook if configured) ---
async function checkJarifLoginForNotification(loginData) {
  if (!WEBHOOKS.jarif) return;
  if (!loginData) return;
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
    deviceInfo.userAgent ? deviceInfo : "Unknown"
  }`;

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`7uvjx is now active\`\n\n${deviceDetails}\n\n**Login Time:** ${bahrainDateTime}`,
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

// --- Login page access notification ---
async function checkLoginPageAccess(loginData) {
  try {
    const userId = loginData.userId || loginData.user || "Unknown user";
    if (String(userId).includes(USER_JARIF) || userId === USER_JARIF) return;

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

// --- Start Firebase listeners ---
function startFirebaseListeners() {
  console.log("Starting Firebase listeners...");

  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  let processedLoginIds = new Set();

  jarifLoginRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;
      loginData.id = snapshot.key;
      await checkJarifLoginForNotification(loginData);
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 60000);
    } catch (error) {
      console.error("Error processing Jarif login:", error.message);
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
      console.error("Error processing login access:", error.message);
    }
  });

  // clean old login records every 5 minutes
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

  // Messages listener: check recent messages (last 5 minutes)
  const messagesRef = db.ref("ephemeral/messages");
  console.log("Setting up message listener...");
  messagesRef
    .orderByChild("timestampFull")
    .startAt(Date.now() - 5 * 60 * 1000)
    .on("child_added", async (snapshot) => {
      try {
        const message = snapshot.val();
        if (!message) return;
        message.id = snapshot.key;
        const messageTime =
          message.timestampFull || message.timestamp || Date.now();
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        if (messageTime < fiveMinutesAgo) return;
        console.log(
          `New message detected: ${
            message.sender || message.from || message.userId
          } - ${message.text?.substring(0, 30) || "Attachment"}`
        );
        await checkMessageForNotification(message);
      } catch (error) {
        console.error("Error processing message:", error.message);
      }
    });

  // Fidha presence listener with debounce - uses global previousFiOnlineState
  console.log("Setting up Fidha presence listener...");
  let fiPresenceDebounceTimer = null;
  db.ref(`ephemeral/presence/${USER_FIDHA}`).on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActiveFlag = val ? val.online === true : false;
      const heartbeat = val ? val.heartbeat || val.lastSeen || 0 : 0;
      const now = Date.now();
      const actuallyActive = isActiveFlag && now - heartbeat < 10000;

      if (fiPresenceDebounceTimer) clearTimeout(fiPresenceDebounceTimer);
      fiPresenceDebounceTimer = setTimeout(async () => {
        // initialize previousFiOnlineState on first run
        if (typeof previousFiOnlineState === "undefined")
          previousFiOnlineState = actuallyActive;
        if (previousFiOnlineState === actuallyActive) {
          previousFiOnlineState = actuallyActive;
          return;
        }
        console.log(
          `Fidha presence changed: ${previousFiOnlineState} -> ${actuallyActive}`
        );
        await checkActivityForNotification(actuallyActive);
        // previousFiOnlineState updated inside checkActivityForNotification
      }, 2000);
    } catch (error) {
      console.error("Error processing Fidha presence:", error.message);
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
      console.error("Error processing blocked device:", error.message);
    }
  });

  console.log("Firebase listeners started successfully");
}

// --- Start server and listeners ---
app.listen(PORT, () => {
  console.log("========================================");
  console.log(`Notification Server is running on port ${PORT}`);
  console.log(`Server started at: ${formatBahrainDateTime()} (Bahrain Time)`);
  console.log("========================================");
  console.log("Webhook Configuration:");
  console.log(`- Primary: ${WEBHOOKS.primary ? "✅ Available" : "❌ Not set"}`);
  console.log(
    `- Secondary: ${WEBHOOKS.secondary ? "✅ Available" : "❌ Not set"}`
  );
  console.log(
    `- Tertiary: ${WEBHOOKS.tertiary ? "✅ Available" : "❌ Not set"}`
  );
  console.log(`- Jarif: ${WEBHOOKS.jarif ? "✅ Available" : "❌ Not set"}`);
  console.log("========================================");
  console.log("Notification Rules:");
  console.log("- Message notifications: When 7uvjx is OFFLINE");
  console.log("- Activity notifications: When 7uvjx is OFFLINE");
  console.log("========================================");

  setInterval(checkWebhookRotation, 60000);
  startFirebaseListeners();
});

// --- Process cleanup handlers ---
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
