const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

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

const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1306603388033040454/xv7s6tO12dfaup68kf1ZzOj-33wVRWvJxGew6YpZ9cl9arAjYufgLh2a_KxAn0Jz3L_E";

const JARIF_WEBHOOK_URL =
  process.env.JARIF_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1306603388033040454/xv7s6tO12dfaup68kf1ZzOj-33wVRWvJxGew6YpZ9cl9arAjYufgLh2a_KxAn0Jz3L_E"; // Replace with your Jarif webhook URL

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ephemeral-chat-demo-default-rtdb.firebaseio.com",
});
const db = admin.database();

let jarifLastOnlineTime = Date.now();
let jarifIsCurrentlyOnline = false;
let jarifIsActuallyOffline = true; // Track if Jarif is actually offline
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
let jarifActivityStatus = "offline";

function getBahrainTime() {
  const now = new Date();
  const bahrainTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );
  return {
    time: bahrainTime.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }),
    date: bahrainTime.toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    }),
    full: bahrainTime.toLocaleString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZone: "Asia/Bahrain",
    }),
  };
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

  if (isActivity || isOffline) {
    const now = Date.now();
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      return;
    }
    lastPresenceNotificationTime = now;
  }

  if (!isActivity && !isOffline && !isLogin && !isJarifLogin) {
    const now = Date.now();
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      return;
    }
    lastMessageNotificationTime = now;
  }

  if (isLogin || isJarifLogin) {
    const now = Date.now();
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
  }_${Date.now()}`;
  if (processedPresenceEvents.has(eventKey)) {
    return;
  }
  processedPresenceEvents.add(eventKey);

  if (processedPresenceEvents.size > 100) {
    const arr = Array.from(processedPresenceEvents);
    processedPresenceEvents = new Set(arr.slice(-50));
  }

  const now = new Date();
  const bahrainTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );
  const formattedTime = bahrainTime.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const footerText = isActivity
    ? `Came online at ${formattedTime} AST`
    : isOffline
    ? `Went offline at ${formattedTime} AST`
    : isLogin
    ? `Accessed at ${formattedTime} AST`
    : isJarifLogin
    ? `Logged in at ${formattedTime} AST`
    : `Sent at ${formattedTime} AST`;

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
    }
  } catch (error) {}
}

function formatBahrainDateTime(timestamp) {
  const date = new Date(timestamp);
  const bahrainDate = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );
  return bahrainDate.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Bahrain",
  });
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

    // Check if Jarif is actually offline (not just unfocused)
    const isOnline = jarifPresence.online === true;
    const lastSeen = jarifPresence.lastSeen || 0;
    const timeSinceLastSeen = Date.now() - lastSeen;

    // Consider Jarif offline if:
    // 1. online is false OR
    // 2. last seen was more than 30 seconds ago
    jarifIsActuallyOffline = !isOnline || timeSinceLastSeen > 30000;
  } catch (error) {
    jarifIsActuallyOffline = true;
  }
}

async function checkMessageForNotification(message) {
  if (message.sender !== USER_FIDHA) {
    return;
  }

  // Check if Jarif is actually offline
  await checkJarifPresence();
  if (!jarifIsActuallyOffline) {
    return; // Don't send notification if Jarif is online
  }

  const bahrainTime = formatBahrainDateTime(
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
    }\n**Time:** ${bahrainTime}`,
    DISCORD_WEBHOOK_URL,
    false,
    false,
    false
  );
  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 1000) {
    const arr = Array.from(processedMessageIds);
    processedMessageIds = new Set(arr.slice(-500));
  }
}

async function checkActivityForNotification(isActive, presenceData) {
  // Check if Jarif is actually offline
  await checkJarifPresence();
  if (!jarifIsActuallyOffline) {
    return; // Don't send notification if Jarif is online
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
  const bahrainTime = formatBahrainDateTime(Date.now());

  if (
    wasOnline &&
    !nowOnline &&
    jarifSettings &&
    jarifSettings.offlineNotifications
  ) {
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainTime}`,
      DISCORD_WEBHOOK_URL,
      false,
      true,
      false
    );
  } else if (
    !wasOnline &&
    nowOnline &&
    jarifSettings &&
    jarifSettings.activityNotifications
  ) {
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is now active\`\n\n**Time:** ${bahrainTime}`,
      DISCORD_WEBHOOK_URL,
      true,
      false,
      false
    );
  }

  previousFiOnlineState = nowOnline;
}

async function checkJarifLoginForNotification(loginData) {
  if (
    !JARIF_WEBHOOK_URL ||
    JARIF_WEBHOOK_URL === "YOUR_JARIF_WEBHOOK_URL_HERE"
  ) {
    return;
  }

  if (processedJarifLoginIds.has(loginData.id)) {
    return;
  }

  const deviceInfo = loginData.deviceInfo || {};
  const bahrainTime = formatBahrainDateTime(loginData.timestamp || Date.now());

  let deviceDetails = `**Device Model:** ${
    deviceInfo.deviceModel || "Unknown"
  }\n`;
  deviceDetails += `**Device Type:** ${deviceInfo.deviceType || "Unknown"}\n`;
  deviceDetails += `**Platform:** ${deviceInfo.platform || "Unknown"}\n`;
  deviceDetails += `**Screen:** ${deviceInfo.screenSize || "Unknown"}\n`;
  deviceDetails += `**Device ID:** ${
    deviceInfo.deviceId
      ? deviceInfo.deviceId
      : "Unknown"
  }\n`;
  deviceDetails += `**Timezone:** ${deviceInfo.timezone || "Unknown"}\n`;
  deviceDetails += `**Browser:** ${
    deviceInfo.userAgent
      ? deviceInfo.userAgent
      : "Unknown"
  }`;

  await sendDiscordNotification(
    `<@765280345260032030>`,
    `\`Jarif is now active\`\n\n${deviceDetails}\n\n**Login Time:** ${bahrainTime}`,
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

    // Only send notification for 7uvfii logins
    if (userId === USER_JARIF) {
      return;
    }

    const timestamp = loginData.timestamp || Date.now();
    const bahrainTime = formatBahrainDateTime(timestamp);

    const deviceId = loginData.deviceId || "Unknown device";
    const deviceModel = loginData.deviceModel || "Unknown";
    const deviceType = loginData.deviceType || "Unknown";
    const userAgent = loginData.userAgent || "Unknown";
    const screenSize = loginData.screenSize || "Unknown";
    const platform = loginData.platform || "Unknown";
    const timezone = loginData.timezone || "Unknown";

    const deviceInfo = `**Device ID:** ${deviceId}\n**Model:** ${deviceModel} (${deviceType})\n**Platform:** ${platform}\n**Screen:** ${screenSize}`;

    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`🔓 Login page was opened\`\n\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${userAgent}\n**Time:** ${bahrainTime} AST`,
      DISCORD_WEBHOOK_URL,
      false,
      false,
      true
    );
  } catch (error) {}
}

function startFirebaseListeners() {
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  let processedLoginIds = new Set();

  // Listen for Jarif logins
  jarifLoginRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      loginData.id = snapshot.key;
      await checkJarifLoginForNotification(loginData);

      // Remove old login records
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 60000); // Remove after 1 minute
    } catch (error) {}
  });

  // Listen for all login attempts
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
    } catch (error) {}
  });

  // Clean up old login records
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
    } catch (error) {}
  }, 300000);

  // Listen for new messages
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
      } catch (error) {}
    });

  // Listen for Fi's presence changes
  let lastFiPresenceState = null;
  db.ref("ephemeral/presence/Fidha").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online : false;

      if (lastFiPresenceState === isActive) {
        return;
      }

      lastFiPresenceState = isActive;
      checkActivityForNotification(isActive, val);
    } catch (error) {}
  });

  // Listen for Jarif's presence changes
  db.ref("ephemeral/presence/Jarif").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      jarifIsCurrentlyOnline = val ? val.online : false;

      if (val && val.visibleAndFocused === true) {
        jarifActivityStatus = "active";
        jarifIsActuallyOffline = false;
      } else if (val && val.online) {
        jarifActivityStatus = "online";
        jarifIsActuallyOffline = false;
      } else {
        jarifActivityStatus = "offline";
        jarifIsActuallyOffline = true;
      }

      if (val && val.lastSeen) {
        jarifLastOnlineTime = val.lastSeen;
      }
    } catch (error) {}
  });

  // Listen for blocked devices
  const blockedDevicesRef = db.ref("ephemeral/blockedDevices");
  blockedDevicesRef.on("child_added", (snapshot) => {
    try {
      const blockedDevice = snapshot.val();
      if (blockedDevice && blockedDevice.deviceId) {
      }
    } catch (error) {}
  });
}

startFirebaseListeners();
app.listen(PORT, () => {
  const bahrainTime = getBahrainTime();
});

process.on("SIGTERM", () => {
  process.exit(0);
});

process.on("SIGINT", () => {
  process.exit(0);
});

process.on("uncaughtException", (error) => {});

process.on("unhandledRejection", (reason, promise) => {});
