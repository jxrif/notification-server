const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!process.env.DISCORD_WEBHOOK_URL) {
  console.error("ERROR: DISCORD_WEBHOOK_URL environment variable is required.");
  process.exit(1);
}

app.get("/", (req, res) => res.send("Notification Server is running."));
app.get("/health", (req, res) => res.send("OK"));

let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  } else {
    serviceAccount = require("./firebase-service-account.json");
  }
} catch (error) {
  console.error("ERROR: Could not load Firebase service account.");
  process.exit(1);
}

// Webhook URLs from environment variables only
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const JARIF_WEBHOOK_URL = process.env.JARIF_WEBHOOK_URL; // Optional: only for Jarif login notifications

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://two-ephemeral-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
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
const MESSAGE_COOLDOWN = 10000;
const LOGIN_COOLDOWN = 5000;

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

async function sendDiscordNotification(
  mention,
  embedDescription,
  webhookUrl = DISCORD_WEBHOOK_URL,
  isActivity = false,
  isOffline = false,
  isLogin = false,
  isJarifLogin = false
) {
  if (!webhookUrl) {
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

  if (isLogin || isJarifLogin) {
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      return;
    }
    lastLoginNotificationTime = now;
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
    color = 3066993;
  } else if (isOffline) {
    color = 15158332;
  } else if (isLogin) {
    color = 16776960;
  } else if (isJarifLogin) {
    color = 3447003;
  } else {
    color = 10181046;
  }

  const webhookBody = {
    content: mention,
    embeds: [
      {
        description: embedDescription,
        color: color,
        footer: footerText ? { text: footerText } : undefined,
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody),
      timeout: 5000,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Discord webhook error: ${response.status} - ${text}`);
    }
  } catch (error) {
    console.error(`Failed to send Discord notification: ${error.message}`);
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

    jarifIsActuallyOffline = !isOnline || timeSinceLastSeen > 30000;
  } catch (error) {
    jarifIsActuallyOffline = true;
  }
}

async function checkMessageForNotification(message) {
  if (message.sender !== USER_FIDHA) {
    return;
  }

  await checkJarifPresence();
  if (!jarifIsActuallyOffline) {
    return;
  }

  const bahrainDateTime = formatBahrainDateTime(
    message.timestampFull || Date.now()
  );

  if (processedMessageIds.has(message.id)) {
    return;
  }

  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (error) {
    jarifSettings = null;
  }

  if (!jarifSettings || !jarifSettings.messageNotifications) {
    return;
  }

  if (message.savedBy && message.savedBy[USER_JARIF]) {
    return;
  }

  if (message.readBy && message.readBy[USER_JARIF]) {
    return;
  }

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Fi✨ sent a message\`\n\n**Message:** ${
      message.text || "Attachment"
    }\n**Time:** ${bahrainDateTime}`,
    DISCORD_WEBHOOK_URL
  );
  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

async function checkActivityForNotification(isActive) {
  await checkJarifPresence();
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
    return;
  }

  const wasOnline = previousFiOnlineState;
  const nowOnline = isActive;
  const bahrainDateTime = formatBahrainDateTime();

  if (
    wasOnline &&
    !nowOnline &&
    jarifSettings &&
    jarifSettings.offlineNotifications
  ) {
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainDateTime}`,
      DISCORD_WEBHOOK_URL,
      false,
      true
    );
  } else if (
    !wasOnline &&
    nowOnline &&
    jarifSettings &&
    jarifSettings.activityNotifications
  ) {
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is now active\`\n\n**Time:** ${bahrainDateTime}`,
      DISCORD_WEBHOOK_URL,
      true
    );
  }

  previousFiOnlineState = nowOnline;
}

async function checkJarifLoginForNotification(loginData) {
  if (!JARIF_WEBHOOK_URL) {
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
    deviceInfo.userAgent ? deviceInfo.userAgent.substring(0, 100) : "Unknown"
  }`;

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Jarif is now active\`\n\n${deviceDetails}\n\n**Login Time:** ${bahrainDateTime}`,
    JARIF_WEBHOOK_URL,
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
      `\`🔓 Login page was opened\`\n\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${userAgent}\n**Time:** ${bahrainDateTime}`,
      DISCORD_WEBHOOK_URL,
      false,
      false,
      true
    );
  } catch (error) {
    console.error(`Error checking login page access: ${error.message}`);
  }
}

function startFirebaseListeners() {
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

  const messagesRef = db.ref("ephemeral/messages");
  messagesRef
    .orderByChild("timestampFull")
    .startAt(Date.now() - 60000)
    .on("child_added", async (snapshot) => {
      try {
        const message = snapshot.val();
        if (!message) return;

        message.id = snapshot.key;

        const messageTime = message.timestampFull || Date.now();
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

        if (messageTime < fiveMinutesAgo) {
          return;
        }

        await checkMessageForNotification(message);
      } catch (error) {
        console.error(`Error processing message: ${error.message}`);
      }
    });

  let lastFiPresenceState = null;
  db.ref("ephemeral/presence/Fidha").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online : false;

      if (lastFiPresenceState === isActive) {
        return;
      }

      lastFiPresenceState = isActive;
      checkActivityForNotification(isActive);
    } catch (error) {
      console.error(`Error processing Fi presence: ${error.message}`);
    }
  });

  db.ref("ephemeral/presence/Jarif").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isOnline = val ? val.online : false;

      if (val && val.visibleAndFocused === true) {
        jarifIsActuallyOffline = false;
      } else if (val && isOnline) {
        jarifIsActuallyOffline = false;
      } else {
        jarifIsActuallyOffline = true;
      }
    } catch (error) {
      console.error(`Error processing Jarif presence: ${error.message}`);
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

startFirebaseListeners();
app.listen(PORT, () => {
  const bahrainDateTime = formatBahrainDateTime();
  console.log(`Notification Server is running on port ${PORT}`);
  console.log(`Server started at: ${bahrainDateTime} (Bahrain Time)`);
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
