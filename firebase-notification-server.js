const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook URLs with specific purposes
const PRESENCE_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; // For presence/login notifications
const MESSAGE_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_2; // Primary for messages
const MESSAGE_WEBHOOK_BACKUP = process.env.DISCORD_WEBHOOK_URL_3; // Backup for messages
const JARIF_WEBHOOK_URL = process.env.JARIF_WEBHOOK_URL; // Only for Jarif logins

// Message webhook tracking
let activeMessageWebhook = MESSAGE_WEBHOOK_URL;
let activeMessageWebhookName = "primary";
let isMessageWebhookRateLimited = false;
let messageWebhookRateLimitStartTime = 0;

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

// Store last notification times per device to prevent duplicates
const lastDeviceNotificationTimes = new Map();
const DEVICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds

// Load Firebase service account
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (error) {
  console.error(
    "🚨 CRITICAL ERROR: Could not parse Firebase service account JSON."
  );
  console.error("❌ Error details:", error.message);
  process.exit(1);
}

app.get("/", (req, res) => res.send("Notification Server is running."));
app.get("/health", (req, res) => res.send("OK"));
app.get("/webhook-status", (req, res) => {
  res.json({
    presenceWebhook: !!PRESENCE_WEBHOOK_URL ? "configured" : "not configured",
    messageWebhook: {
      active: activeMessageWebhookName,
      isRateLimited: isMessageWebhookRateLimited,
      rateLimitedSince: messageWebhookRateLimitStartTime
        ? new Date(messageWebhookRateLimitStartTime).toISOString()
        : null,
      primaryConfigured: !!MESSAGE_WEBHOOK_URL,
      backupConfigured: !!MESSAGE_WEBHOOK_BACKUP,
    },
    jarifWebhook: !!JARIF_WEBHOOK_URL ? "configured" : "not configured",
    devicesTracked: lastDeviceNotificationTimes.size,
    notificationSettings: {
      messageCooldown: "3 seconds",
      deviceCooldown: "30 seconds",
    },
  });
});

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://ephemeral-chat-demo-default-rtdb.firebaseio.com",
});
const db = admin.database();

let jarifIsActuallyOffline = true;
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let processedJarifLoginIds = new Set();
let lastPresenceNotificationTime = 0;
let lastMessageNotificationTime = 0;
let lastLoginNotificationTime = 0;
const PRESENCE_COOLDOWN = 5000;
const MESSAGE_COOLDOWN = 3000; // 3 seconds as requested
const LOGIN_COOLDOWN = 0; // NO COOLDOWN FOR LOGINS - IMMEDIATE

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

function switchMessageWebhook() {
  const now = Date.now();

  if (activeMessageWebhookName === "primary" && MESSAGE_WEBHOOK_BACKUP) {
    activeMessageWebhook = MESSAGE_WEBHOOK_BACKUP;
    activeMessageWebhookName = "backup";
    console.log(
      `🔄 SWITCHED MESSAGE WEBHOOK: primary → backup (due to rate limit)`
    );
    console.log(`📊 Backup webhook configured: ${!!MESSAGE_WEBHOOK_BACKUP}`);
  } else if (activeMessageWebhookName === "backup" && MESSAGE_WEBHOOK_URL) {
    activeMessageWebhook = MESSAGE_WEBHOOK_URL;
    activeMessageWebhookName = "primary";
    console.log(
      `🔄 SWITCHED MESSAGE WEBHOOK: backup → primary (backup rate limited)`
    );
  } else {
    console.log(`⚠️  WARNING: No available message webhooks to switch to`);
  }

  isMessageWebhookRateLimited = false;
  messageWebhookRateLimitStartTime = 0;

  return true;
}

async function sendDiscordNotification(
  mention,
  embedDescription,
  isActivity = false,
  isOffline = false,
  isLogin = false,
  isJarifLogin = false
) {
  // SPECIAL HANDLING FOR JARIF LOGINS - ALWAYS SEND IMMEDIATELY TO JARIF WEBHOOK
  if (isJarifLogin) {
    if (!JARIF_WEBHOOK_URL) {
      console.error(`🚨 JARIF LOGIN ERROR: No Jarif webhook configured`);
      return;
    }

    // Reset cooldown to force immediate notification
    lastLoginNotificationTime = 0;

    console.log(
      `🚨 JARIF LOGIN DETECTED - Sending notification via Jarif webhook`
    );
    console.log(`🔗 Webhook URL: ${JARIF_WEBHOOK_URL.substring(0, 50)}...`);

    // Skip all cooldowns for Jarif logins
    await sendToWebhook(
      JARIF_WEBHOOK_URL,
      "jarif",
      mention,
      embedDescription,
      isActivity,
      isOffline,
      isLogin,
      isJarifLogin,
      true // Force immediate send
    );
    return;
  }

  // Determine which webhook to use based on notification type
  let targetWebhookUrl;
  let targetWebhookName;

  if (isActivity || isOffline || isLogin) {
    // Presence/login notifications use the presence webhook
    targetWebhookUrl = PRESENCE_WEBHOOK_URL;
    targetWebhookName = "presence";
  } else {
    // Message notifications use the message webhook (with backup)
    targetWebhookUrl = activeMessageWebhook;
    targetWebhookName = `message_${activeMessageWebhookName}`;
  }

  if (!targetWebhookUrl) {
    console.error(`❌ ERROR: No ${targetWebhookName} webhook URL configured`);
    return;
  }

  const now = Date.now();

  // Apply cooldowns based on notification type
  if (isActivity || isOffline) {
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      console.log(
        `⏸️  Presence notification cooldown active (${PRESENCE_COOLDOWN}ms)`
      );
      return;
    }
    lastPresenceNotificationTime = now;
  }

  if (!isActivity && !isOffline && !isLogin && !isJarifLogin) {
    // MESSAGE NOTIFICATIONS - 3 second cooldown as requested
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      console.log(
        `⏸️  Message notification cooldown active (${MESSAGE_COOLDOWN}ms)`
      );
      return;
    }
    lastMessageNotificationTime = now;
  }

  if (isLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      console.log(
        `⏸️  Login notification cooldown active (${LOGIN_COOLDOWN}ms)`
      );
      return;
    }
    lastLoginNotificationTime = now;
  }

  console.log(`📤 SENDING ${targetWebhookName.toUpperCase()} NOTIFICATION`);
  console.log(`📝 Description: ${embedDescription.substring(0, 100)}...`);

  await sendToWebhook(
    targetWebhookUrl,
    targetWebhookName,
    mention,
    embedDescription,
    isActivity,
    isOffline,
    isLogin,
    isJarifLogin
  );
}

async function sendToWebhook(
  webhookUrl,
  webhookName,
  mention,
  embedDescription,
  isActivity,
  isOffline,
  isLogin,
  isJarifLogin,
  forceImmediate = false
) {
  const now = Date.now();
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

  if (!forceImmediate && processedPresenceEvents.has(eventKey)) {
    console.log(`⏭️  Duplicate event ${eventKey} - skipping`);
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
    console.log(`🌐 Sending to ${webhookName} webhook...`);
    console.log(`📦 Payload size: ${JSON.stringify(webhookBody).length} bytes`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; NotificationBot/2.0; WebhookSystem)",
      },
      body: JSON.stringify(webhookBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      console.error(`🚫 RATE LIMIT HIT on ${webhookName} webhook`);
      console.error(`📊 Response status: ${response.status}`);

      // Handle rate limit for message webhook specifically
      if (webhookName.startsWith("message_")) {
        isMessageWebhookRateLimited = true;
        messageWebhookRateLimitStartTime = now;
        console.log(`⚠️  Message webhook rate limited - switching to backup`);
        switchMessageWebhook();
      }

      // Don't retry - just log the failure
      console.log(`⏭️  Skipping notification due to rate limit`);
    } else if (response.status === 403 || response.status === 404) {
      console.error(`❌ WEBHOOK INVALID: ${webhookName} (${response.status})`);
      console.error(`🔗 Webhook might be deleted or invalid`);

      if (webhookName.startsWith("message_")) {
        console.log(`🔄 Switching message webhook due to invalid URL`);
        switchMessageWebhook();
      }
    } else if (!response.ok) {
      const text = await response.text();
      console.error(`❌ WEBHOOK ERROR (${webhookName}): ${response.status}`);
      console.error(`📝 Response: ${text.substring(0, 200)}`);
    } else {
      console.log(`✅ SUCCESS: Notification sent via ${webhookName} webhook`);
      console.log(`📊 Response: ${response.status} ${response.statusText}`);

      if (webhookName.startsWith("message_")) {
        isMessageWebhookRateLimited = false;
      }
    }
  } catch (error) {
    console.error(`🔥 NETWORK ERROR (${webhookName}): ${error.message}`);
    console.error(`🔍 Error type: ${error.name}`);

    if (error.name === "AbortError") {
      console.error(`⏱️  Request timeout after 8 seconds`);
    }

    if (
      error.message.includes("Cloudflare") ||
      error.message.includes("banned")
    ) {
      console.error(`🛡️  Cloudflare protection detected`);

      if (webhookName.startsWith("message_")) {
        isMessageWebhookRateLimited = true;
        messageWebhookRateLimitStartTime = now;
        console.log(`🔄 Switching message webhook due to Cloudflare ban`);
        switchMessageWebhook();
      }
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
      console.log(`👤 Jarif presence: No data found (considered offline)`);
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

    console.log(`👤 Jarif presence check:`);
    console.log(`   ├─ Online flag: ${isOnline}`);
    console.log(
      `   ├─ Last heartbeat: ${Math.round(timeSinceHeartbeat / 1000)}s ago`
    );
    console.log(
      `   ├─ Last seen: ${Math.round(timeSinceLastSeen / 1000)}s ago`
    );
    console.log(`   └─ Considered offline: ${jarifIsActuallyOffline}`);
  } catch (error) {
    console.error(`❌ ERROR checking Jarif presence: ${error.message}`);
    jarifIsActuallyOffline = true;
  }
}

async function checkMessageForNotification(message) {
  console.log(`📨 MESSAGE RECEIVED:`);
  console.log(`   ├─ Sender: ${message.sender}`);
  console.log(`   ├─ Content: ${message.text || "Attachment"}`);
  console.log(`   ├─ ID: ${message.id}`);
  console.log(`   └─ Time: ${formatBahrainDateTime(message.timestampFull)}`);

  // Only send notifications for Fidha's messages
  if (message.sender !== USER_FIDHA) {
    console.log(`⏭️  Skipping: Not from Fidha`);
    return;
  }

  await checkJarifPresence();

  // Don't send notification if Jarif is online
  if (!jarifIsActuallyOffline) {
    console.log(`⏭️  Skipping: Jarif is online`);
    return;
  }

  const bahrainDateTime = formatBahrainDateTime(
    message.timestampFull || Date.now()
  );

  if (processedMessageIds.has(message.id)) {
    console.log(`⏭️  Skipping: Message ${message.id} already processed`);
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
    console.log(`⚙️  Created default notification settings for Jarif`);
  }

  // Don't send if message notifications are disabled
  if (!jarifSettings.messageNotifications) {
    console.log(`⏭️  Skipping: Message notifications disabled for Jarif`);
    return;
  }

  // Skip if message is saved by Jarif or already read
  if (message.savedBy && message.savedBy[USER_JARIF]) {
    console.log(`⏭️  Skipping: Message saved by Jarif`);
    return;
  }

  if (message.readBy && message.readBy[USER_JARIF]) {
    console.log(`⏭️  Skipping: Message already read by Jarif`);
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

  console.log(`📨 PROCESSING MESSAGE NOTIFICATION:`);
  console.log(`   ├─ Content: ${messageContent.substring(0, 100)}...`);
  console.log(`   ├─ Time: ${bahrainDateTime}`);
  console.log(`   └─ Using webhook: message_${activeMessageWebhookName}`);

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Fi✨ sent a message while you were offline\`\n\n**Message:** ${messageContent}\n**Time:** ${bahrainDateTime}`
  );

  console.log(`✅ Message notification processed for ID: ${message.id}`);
  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

async function checkActivityForNotification(isActive) {
  console.log(`👤 FIDHA PRESENCE UPDATE:`);
  console.log(`   ├─ Current state: ${isActive ? "online" : "offline"}`);
  console.log(
    `   ├─ Previous state: ${previousFiOnlineState ? "online" : "offline"}`
  );
  console.log(`   └─ Checking Jarif presence...`);

  await checkJarifPresence();

  // Only send presence notifications if Jarif is offline
  if (!jarifIsActuallyOffline) {
    console.log(`⏭️  Skipping presence notification: Jarif is online`);
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

  // Fidha went OFFLINE
  if (wasOnline && !nowOnline) {
    console.log(`🔴 FIDHA WENT OFFLINE`);
    if (jarifSettings && jarifSettings.offlineNotifications) {
      console.log(`📤 Sending offline notification via presence webhook`);
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainDateTime}`,
        false,
        true
      );
    }
  }
  // Fidha came ONLINE
  else if (!wasOnline && nowOnline) {
    console.log(`🟢 FIDHA CAME ONLINE`);
    if (jarifSettings && jarifSettings.activityNotifications) {
      console.log(`📤 Sending online notification via presence webhook`);
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is now active\`\n\n**Time:** ${bahrainDateTime}`,
        true
      );
    }
  } else {
    console.log(`⏭️  No state change detected`);
  }

  previousFiOnlineState = nowOnline;
}

async function checkJarifLoginForNotification(loginData) {
  if (!JARIF_WEBHOOK_URL) {
    console.error(`🚨 CRITICAL: No Jarif webhook configured`);
    return;
  }

  const deviceInfo = loginData.deviceInfo || {};
  const deviceId = deviceInfo.deviceId || "unknown";

  // Check device cooldown to prevent double notifications
  const now = Date.now();
  const lastNotificationTime = lastDeviceNotificationTimes.get(deviceId) || 0;

  if (now - lastNotificationTime < DEVICE_NOTIFICATION_COOLDOWN) {
    console.log(`⏭️  Skipping duplicate notification for device ${deviceId}`);
    console.log(
      `   └─ Within ${DEVICE_NOTIFICATION_COOLDOWN / 1000}s cooldown period`
    );
    return;
  }

  // Also check processed IDs with time-based key
  const timeWindow = Math.floor(now / 60000); // 1-minute window
  const uniqueKey = `${deviceId}_${timeWindow}`;

  if (processedJarifLoginIds.has(uniqueKey)) {
    console.log(`⏭️  Jarif login already processed in this time window`);
    return;
  }

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
  deviceDetails += `**Device ID:** ${deviceId}\n`;
  deviceDetails += `**Timezone:** ${deviceInfo.timezone || "Unknown"}\n`;

  // Use 1000 characters for user agent to stay within Discord limits
  const userAgent = deviceInfo.userAgent || "Unknown";
  const safeUserAgent =
    userAgent.length > 1000 ? userAgent.substring(0, 1000) + "..." : userAgent;
  deviceDetails += `**Browser:** ${safeUserAgent}`;

  console.log(`🚨 JARIF LOGIN DETECTED:`);
  console.log(`   ├─ Device: ${deviceId}`);
  console.log(`   ├─ Model: ${deviceInfo.deviceModel || "Unknown"}`);
  console.log(`   ├─ Time: ${bahrainDateTime}`);
  console.log(`   └─ Using Jarif-specific webhook`);

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Jarif is now active\`\n\n${deviceDetails}\n\n**Login Time:** ${bahrainDateTime}`,
    false,
    false,
    false,
    true
  );

  console.log(`✅ Jarif login notification sent for device: ${deviceId}`);

  // Update tracking
  lastDeviceNotificationTimes.set(deviceId, now);
  processedJarifLoginIds.add(uniqueKey);

  // Clean up old tracking data
  if (lastDeviceNotificationTimes.size > 100) {
    const entries = Array.from(lastDeviceNotificationTimes.entries());
    entries.sort((a, b) => b[1] - a[1]); // Sort by timestamp
    const recentEntries = entries.slice(0, 50); // Keep 50 most recent
    lastDeviceNotificationTimes.clear();
    recentEntries.forEach(([key, value]) =>
      lastDeviceNotificationTimes.set(key, value)
    );
  }

  if (processedJarifLoginIds.size > 100) {
    const arr = Array.from(processedJarifLoginIds);
    const recentIds = arr.filter((id) => {
      const [, timestamp] = id.split("_");
      const idTime = parseInt(timestamp) * 60000; // Convert back to milliseconds
      return now - idTime < 3600000; // Keep only from last hour
    });
    processedJarifLoginIds = new Set(recentIds);
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

    // Truncate user agent to 1000 characters
    const safeUserAgent =
      userAgent.length > 1000
        ? userAgent.substring(0, 1000) + "..."
        : userAgent;

    const deviceInfo = `**Device ID:** ${deviceId}\n**Model:** ${deviceModel} (${deviceType})\n**Platform:** ${platform}\n**Screen:** ${screenSize}\n**Window:** ${windowSize}`;

    console.log(`🔓 LOGIN PAGE ACCESS:`);
    console.log(`   ├─ User: ${userId}`);
    console.log(`   ├─ Device: ${deviceId}`);
    console.log(`   ├─ Time: ${bahrainDateTime}`);
    console.log(`   └─ Using presence webhook`);

    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`🔓 Login page was opened\`\n\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${safeUserAgent}\n**Time:** ${bahrainDateTime}`,
      false,
      false,
      true
    );
  } catch (error) {
    console.error(`❌ ERROR checking login page access: ${error.message}`);
  }
}

function startFirebaseListeners() {
  console.log(`🔥 INITIALIZING FIREBASE LISTENERS...`);

  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  let processedLoginIds = new Set();

  jarifLoginRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      loginData.id = snapshot.key;
      const deviceId =
        loginData.deviceInfo?.deviceId || loginData.deviceId || "unknown";

      console.log(`=========================================`);
      console.log(`🚨 JARIF LOGIN EVENT DETECTED`);
      console.log(`=========================================`);
      console.log(`   ID: ${loginData.id}`);
      console.log(`   Device: ${deviceId}`);
      console.log(`   Time: ${formatBahrainDateTime(loginData.timestamp)}`);
      console.log(`=========================================`);

      // Immediate notification - don't wait for anything
      await checkJarifLoginForNotification(loginData);

      // Remove after processing to prevent duplicate processing
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
        console.log(`🧹 Cleaned up Jarif login record: ${loginData.id}`);
      }, 30000); // 30 seconds
    } catch (error) {
      console.error(`=========================================`);
      console.error(`❌ JARIF LOGIN PROCESSING ERROR`);
      console.error(`=========================================`);
      console.error(`   Message: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      console.error(`=========================================`);

      // Even on error, try to send a basic notification
      try {
        await sendDiscordNotification(
          `<@765280345260032030>`,
          `\`⚠️ Jarif login detected but processing failed\`\n\n**Error:** ${
            error.message
          }\n**Time:** ${formatBahrainDateTime()}`,
          false,
          false,
          false,
          true
        );
      } catch (e) {
        console.error(`❌ Failed to send error notification: ${e.message}`);
      }
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

      console.log(`🔓 LOGIN ACCESS DETECTED: ${JSON.stringify(loginData)}`);
      await checkLoginPageAccess(loginData);

      processedLoginIds.add(loginId);

      if (processedLoginIds.size > 100) {
        const arr = Array.from(processedLoginIds);
        processedLoginIds = new Set(arr.slice(-50));
      }

      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
        console.log(`🧹 Cleaned up login access record: ${loginId}`);
      }, 1000);
    } catch (error) {
      console.error(`❌ ERROR processing login access: ${error.message}`);
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
      console.error(`❌ ERROR cleaning old login records: ${error.message}`);
    }
  }, 300000);

  // Listen to ALL messages
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

      console.log(`📨 [MESSAGE LOG] ${messageTime} - ${sender}: ${content}`);

      // Check for notification only for recent messages (last 5 minutes)
      const messageTimestamp = message.timestampFull || Date.now();
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      if (messageTimestamp >= fiveMinutesAgo) {
        await checkMessageForNotification(message);
      }
    } catch (error) {
      console.error(`❌ ERROR processing message: ${error.message}`);
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

      console.log(`✏️  [MESSAGE EDIT] ${messageTime} - ${sender}: ${content}`);
    } catch (error) {
      console.error(`❌ ERROR processing message edit: ${error.message}`);
    }
  });

  let lastFiPresenceState = null;
  db.ref("ephemeral/presence/Fidha").on("value", async (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online === true : false;

      console.log(`👤 FIDHA PRESENCE RAW DATA: ${JSON.stringify(val)}`);

      if (lastFiPresenceState === isActive) {
        console.log(`⏭️  No change in Fidha presence state`);
        return;
      }

      lastFiPresenceState = isActive;
      await checkActivityForNotification(isActive);
    } catch (error) {
      console.error(`❌ ERROR processing Fi presence: ${error.message}`);
    }
  });

  db.ref("ephemeral/presence/Jarif").on("value", async (snapshot) => {
    try {
      const val = snapshot.val();
      const isOnline = val ? val.online === true : false;

      console.log(`👤 JARIF PRESENCE RAW DATA: ${JSON.stringify(val)}`);

      // Update Jarif's offline status
      if (val) {
        const lastHeartbeat = val.heartbeat || 0;
        const timeSinceHeartbeat = Date.now() - lastHeartbeat;

        // Jarif is offline if no heartbeat in 60 seconds
        jarifIsActuallyOffline = !isOnline || timeSinceHeartbeat > 60000;

        console.log(`👤 Jarif presence updated:`);
        console.log(`   ├─ Online flag: ${isOnline}`);
        console.log(
          `   ├─ Heartbeat: ${Math.round(timeSinceHeartbeat / 1000)}s ago`
        );
        console.log(`   └─ Considered offline: ${jarifIsActuallyOffline}`);
      } else {
        jarifIsActuallyOffline = true;
        console.log(`👤 Jarif: No presence data (considered offline)`);
      }
    } catch (error) {
      console.error(`❌ ERROR processing Jarif presence: ${error.message}`);
      jarifIsActuallyOffline = true;
    }
  });

  const blockedDevicesRef = db.ref("ephemeral/blockedDevices");
  blockedDevicesRef.on("child_added", (snapshot) => {
    try {
      const blockedDevice = snapshot.val();
      if (blockedDevice && blockedDevice.deviceId) {
        console.log(`🚫 DEVICE BLOCKED: ${blockedDevice.deviceId}`);
      }
    } catch (error) {
      console.error(`❌ ERROR processing blocked device: ${error.message}`);
    }
  });

  console.log(`✅ FIREBASE LISTENERS INITIALIZED`);
}

// Add a periodic check for missed Jarif logins
setInterval(async () => {
  try {
    const jarifLoginRef = db.ref("ephemeral/jarifLogins");
    const snapshot = await jarifLoginRef.once("value");
    const records = snapshot.val();
    if (!records) return;

    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;

    Object.keys(records).forEach(async (key) => {
      const record = records[key];
      if (record.timestamp && record.timestamp >= twoMinutesAgo) {
        // Check if notification was sent
        const deviceId =
          record.deviceInfo?.deviceId || record.deviceId || "unknown";
        const lastNotificationTime =
          lastDeviceNotificationTimes.get(deviceId) || 0;

        if (now - lastNotificationTime > DEVICE_NOTIFICATION_COOLDOWN) {
          console.log(`🔄 Checking possibly missed Jarif login: ${deviceId}`);
          record.id = key;
          await checkJarifLoginForNotification(record);
        }
      }
    });
  } catch (error) {
    console.error(
      `❌ ERROR checking for missed Jarif logins: ${error.message}`
    );
  }
}, 60000); // Check every 60 seconds

// Check Jarif presence every 30 seconds
setInterval(async () => {
  console.log(`⏰ Scheduled Jarif presence check`);
  await checkJarifPresence();
}, 30000);

// Clean up old device notification times periodically
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  let cleanedCount = 0;

  for (const [deviceId, timestamp] of lastDeviceNotificationTimes.entries()) {
    if (timestamp < oneHourAgo) {
      lastDeviceNotificationTimes.delete(deviceId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} old device entries`);
  }
}, 300000); // Every 5 minutes

// Reset message webhook rate limit after 30 minutes
setInterval(() => {
  if (isMessageWebhookRateLimited) {
    const now = Date.now();
    if (now - messageWebhookRateLimitStartTime > 30 * 60 * 1000) {
      if (activeMessageWebhookName === "backup" && MESSAGE_WEBHOOK_URL) {
        activeMessageWebhook = MESSAGE_WEBHOOK_URL;
        activeMessageWebhookName = "primary";
        isMessageWebhookRateLimited = false;
        messageWebhookRateLimitStartTime = 0;
        console.log(`🔄 Reset message webhook to primary after 30 minutes`);
      }
    }
  }
}, 60000); // Check every minute

startFirebaseListeners();
app.listen(PORT, () => {
  const bahrainDateTime = formatBahrainDateTime();
  console.log(`=========================================`);
  console.log(`🚀 NOTIFICATION SERVER STARTED`);
  console.log(`=========================================`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Start Time: ${bahrainDateTime}`);
  console.log(`   Bahrain Timezone: Asia/Bahrain`);
  console.log(``);
  console.log(`🔗 WEBHOOK CONFIGURATION:`);
  console.log(`   ├─ Presence/Login: ${PRESENCE_WEBHOOK_URL ? "✓" : "✗"}`);
  console.log(`   ├─ Messages (Primary): ${MESSAGE_WEBHOOK_URL ? "✓" : "✗"}`);
  console.log(`   ├─ Messages (Backup): ${MESSAGE_WEBHOOK_BACKUP ? "✓" : "✗"}`);
  console.log(`   └─ Jarif Logins: ${JARIF_WEBHOOK_URL ? "✓" : "✗"}`);
  console.log(``);
  console.log(`⚙️  NOTIFICATION SETTINGS:`);
  console.log(`   ├─ Message Cooldown: ${MESSAGE_COOLDOWN}ms`);
  console.log(`   ├─ Presence Cooldown: ${PRESENCE_COOLDOWN}ms`);
  console.log(`   ├─ Login Cooldown: ${LOGIN_COOLDOWN}ms (IMMEDIATE)`);
  console.log(`   └─ Device Cooldown: ${DEVICE_NOTIFICATION_COOLDOWN}ms`);
  console.log(``);
  console.log(`👤 USER CONFIGURATION:`);
  console.log(`   ├─ Fidha (7uvfii): ${USER_FIDHA}`);
  console.log(`   ├─ Jarif (7uvjx): ${USER_JARIF}`);
  console.log(`   └─ Discord ID: 765280345260032030`);
  console.log(`=========================================`);
});

process.on("SIGTERM", () => {
  console.log(`=========================================`);
  console.log(`🛑 SIGTERM RECEIVED - SHUTTING DOWN`);
  console.log(`=========================================`);
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(`=========================================`);
  console.log(`🛑 SIGINT RECEIVED - SHUTTING DOWN`);
  console.log(`=========================================`);
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error(`=========================================`);
  console.error(`💥 UNCAUGHT EXCEPTION`);
  console.error(`=========================================`);
  console.error(`   Error: ${error.message}`);
  console.error(`   Stack: ${error.stack}`);
  console.error(`=========================================`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`=========================================`);
  console.error(`⚠️  UNHANDLED REJECTION`);
  console.error(`=========================================`);
  console.error(`   Reason: ${reason}`);
  console.error(`=========================================`);
});

