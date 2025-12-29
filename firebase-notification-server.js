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

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const JARIF_WEBHOOK_URL = process.env.JARIF_WEBHOOK_URL;

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ephemeral-chat-demo-default-rtdb.firebaseio.com",
});
const db = admin.database();

let jarifLastOnlineTime = Date.now();
let jarifIsCurrentlyOnline = false;
let jarifIsActuallyOffline = true;
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let processedJarifLoginIds = new Set();
let processedFidhaPresenceEvents = new Set();
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
  webhookUrl,
  isActivity = false,
  isOffline = false,
  isLogin = false,
  isJarifLogin = false
) {
  if (!webhookUrl) {
    console.log("Webhook URL not set, skipping notification.");
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
      console.error(`Discord webhook error: ${response.status} - ${text}`);
    }
  } catch (error) {
    console.error("Failed to send Discord notification:", error);
  }
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

    const isOnline = jarifPresence.online === true;
    const lastSeen = jarifPresence.lastSeen || 0;
    const timeSinceLastSeen = Date.now() - lastSeen;

    // Jarif is considered offline if not online OR heartbeat too old
    const isActive = isOnline && timeSinceLastSeen < 10000; // 10 seconds
    jarifIsActuallyOffline = !isActive;
  } catch (error) {
    jarifIsActuallyOffline = true;
  }
}

async function checkMessageForNotification(message) {
  if (message.sender !== USER_FIDHA) {
    return;
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

  // Check if Jarif is offline before sending message notification
  await checkJarifPresence();

  // Only send message notification if Jarif is offline AND message notifications are enabled
  if (jarifIsActuallyOffline && jarifSettings.messageNotifications) {
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
}

async function checkFidhaActivityForNotification(isActive, presenceData) {
  const eventKey = `fidha_${isActive ? "online" : "offline"}_${Date.now()}`;
  if (processedFidhaPresenceEvents.has(eventKey)) {
    return;
  }
  processedFidhaPresenceEvents.add(eventKey);

  if (processedFidhaPresenceEvents.size > 50) {
    const arr = Array.from(processedFidhaPresenceEvents);
    processedFidhaPresenceEvents = new Set(arr.slice(-25));
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

  // Always check Jarif's presence before sending Fidha activity notifications
  await checkJarifPresence();

  if (wasOnline && !nowOnline) {
    // Fidha went offline - send notification regardless of Jarif's status if offline notifications are enabled
    if (jarifSettings && jarifSettings.offlineNotifications) {
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is no longer active\`\n\n**Time:** ${bahrainTime}`,
        DISCORD_WEBHOOK_URL,
        false,
        true,
        false
      );
    }
  } else if (!wasOnline && nowOnline) {
    // Fidha came online - send notification regardless of Jarif's status if activity notifications are enabled
    if (jarifSettings && jarifSettings.activityNotifications) {
      await sendDiscordNotification(
        `<@765280345260032030>`,
        `\`Fi✨ is now active\`\n\n**Time:** ${bahrainTime}`,
        DISCORD_WEBHOOK_URL,
        true,
        false,
        false
      );
    }
  }

  previousFiOnlineState = nowOnline;
}

async function checkJarifLoginForNotification(loginData) {
  if (!JARIF_WEBHOOK_URL) {
    console.log("Jarif webhook URL not set, skipping notification.");
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
    deviceInfo.deviceId ? deviceInfo.deviceId : "Unknown"
  }\n`;
  deviceDetails += `**Timezone:** ${deviceInfo.timezone || "Unknown"}\n`;
  deviceDetails += `**Browser:** ${
    deviceInfo.userAgent ? deviceInfo.userAgent : "Unknown"
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

async function checkFidhaLoginForNotification(loginData) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("Discord webhook URL not set, skipping notification.");
    return;
  }

  try {
    const userId = loginData.userId || "Unknown user";

    // Only send notification for Fidha
    if (userId !== USER_FIDHA) {
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
      `\`🔓 Fi✨ logged in\`\n\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${userAgent}\n**Time:** ${bahrainTime} AST`,
      DISCORD_WEBHOOK_URL,
      false,
      false,
      true
    );
  } catch (error) {
    console.error("Error in checkFidhaLoginForNotification:", error);
  }
}

function startFirebaseListeners() {
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const jarifLoginRef = db.ref("ephemeral/jarifLogins");
  let processedLoginIds = new Set();

  // Listen for Jarif logins - Send EVERY TIME
  jarifLoginRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      loginData.id = snapshot.key;

      // Send notification for EVERY Jarif login
      await checkJarifLoginForNotification(loginData);

      // Keep the record for 5 minutes for debugging
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 300000);
    } catch (error) {
      console.error("Error processing jarif login:", error);
    }
  });

  // Listen for Fidha logins
  loginAccessRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      const loginId = snapshot.key;

      if (processedLoginIds.has(loginId)) {
        snapshot.ref.remove().catch(() => {});
        return;
      }

      // Send notification for Fidha login
      await checkFidhaLoginForNotification(loginData);

      processedLoginIds.add(loginId);

      if (processedLoginIds.size > 100) {
        const arr = Array.from(processedLoginIds);
        processedLoginIds = new Set(arr.slice(-50));
      }

      // Remove after 1 second
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {});
      }, 1000);
    } catch (error) {
      console.error("Error processing login access:", error);
    }
  });

  // Listen for new messages
  const messagesRef = db.ref("ephemeral/messages");
  messagesRef.on("child_added", async (snapshot) => {
    try {
      const message = snapshot.val();
      if (!message) return;

      message.id = snapshot.key;

      // Only process recent messages (last 5 minutes)
      const messageTime = message.timestampFull || Date.now();
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      if (messageTime < fiveMinutesAgo) {
        return;
      }

      await checkMessageForNotification(message);
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  // Listen for Fi's presence changes with better detection
  let lastFiPresenceState = null;
  let lastFiHeartbeat = 0;
  let fiPresenceCheckInterval = null;

  function checkFidhaPresence() {
    db.ref("ephemeral/presence/Fidha").once("value", (snapshot) => {
      try {
        const val = snapshot.val();
        if (!val) {
          if (lastFiPresenceState !== false) {
            checkFidhaActivityForNotification(false, null);
            lastFiPresenceState = false;
          }
          return;
        }

        const now = Date.now();
        const lastHeartbeat = val.heartbeat || 0;
        const isActuallyOnline =
          val.online === true && now - lastHeartbeat < 10000;

        if (lastFiPresenceState !== isActuallyOnline) {
          checkFidhaActivityForNotification(isActuallyOnline, val);
          lastFiPresenceState = isActuallyOnline;
        }
      } catch (error) {
        console.error("Error checking Fidha presence:", error);
      }
    });
  }

  // Check Fidha presence every 3 seconds
  if (!fiPresenceCheckInterval) {
    fiPresenceCheckInterval = setInterval(checkFidhaPresence, 3000);
  }

  // Also listen for real-time changes
  db.ref("ephemeral/presence/Fidha").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      if (!val) {
        if (lastFiPresenceState !== false) {
          checkFidhaActivityForNotification(false, null);
          lastFiPresenceState = false;
        }
        return;
      }

      const now = Date.now();
      const lastHeartbeat = val.heartbeat || 0;
      const isActuallyOnline =
        val.online === true && now - lastHeartbeat < 10000;

      if (lastFiPresenceState !== isActuallyOnline) {
        checkFidhaActivityForNotification(isActuallyOnline, val);
        lastFiPresenceState = isActuallyOnline;
      }
    } catch (error) {
      console.error("Error processing Fidha presence:", error);
    }
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

  // Clean up old data periodically
  setInterval(async () => {
    try {
      // Clean old login records
      const snapshot = await loginAccessRef.once("value");
      const records = snapshot.val();
      if (!records) return;

      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      Object.keys(records).forEach((key) => {
        const record = records[key];
        if (record.timestamp && record.timestamp < oneHourAgo) {
          loginAccessRef
            .child(key)
            .remove()
            .catch(() => {});
        }
      });

      // Clean old jarif login records
      const jarifSnapshot = await jarifLoginRef.once("value");
      const jarifRecords = jarifSnapshot.val();
      if (jarifRecords) {
        Object.keys(jarifRecords).forEach((key) => {
          const record = jarifRecords[key];
          if (record.timestamp && record.timestamp < oneHourAgo) {
            jarifLoginRef
              .child(key)
              .remove()
              .catch(() => {});
          }
        });
      }
    } catch (error) {
      console.error("Error cleaning up old records:", error);
    }
  }, 300000); // Every 5 minutes
}

startFirebaseListeners();
app.listen(PORT, () => {
  const bahrainTime = getBahrainTime();
  console.log(`Notification server running on port ${PORT}`);
  console.log(`Bahrain Time: ${bahrainTime.full}`);
  console.log(
    `Discord Webhook URL: ${DISCORD_WEBHOOK_URL ? "Set" : "Not set"}`
  );
  console.log(`Jarif Webhook URL: ${JARIF_WEBHOOK_URL ? "Set" : "Not set"}`);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

process.on("SIGINT", () => {
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
