const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Keep-alive endpoint for free services that spin down
app.get("/", (req, res) => res.send("Notification Server is running."));
app.get("/health", (req, res) => res.send("OK"));

// ==================== CONFIGURATION ====================
// IMPORTANT: DO NOT HARDCODE KEYS! Use environment variables
let serviceAccount;
try {
  // Try to get from environment variable (for production)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    console.log("Using Firebase service account from environment variable");
  } else {
    // For local testing only - create a firebase-service-account.json file
    serviceAccount = require("./firebase-service-account.json");
    console.log("Using Firebase service account from local file");
  }
} catch (error) {
  console.error("ERROR: Could not load Firebase service account.");
  console.error(
    "For local testing, create firebase-service-account.json file."
  );
  console.error(
    "For production, set FIREBASE_SERVICE_ACCOUNT_KEY environment variable."
  );
  process.exit(1);
}

// Use environment variable or fallback to your hardcoded webhook
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const USER_FIDHA = "Fidha"; // Decoded from your base64
const USER_JARIF = "Jarif"; // Decoded from your base64

// ==================== FIREBASE INIT ====================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ephemeral-chat-demo-default-rtdb.firebaseio.com",
});
const db = admin.database();

console.log("✅ Firebase initialized successfully");
console.log(
  `📱 Discord webhook: ${DISCORD_WEBHOOK_URL ? "Configured" : "Missing!"}`
);

// ==================== STATE ====================
let jarifLastOnlineTime = Date.now();
let jarifIsCurrentlyOnline = false;
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
let lastPresenceNotificationTime = 0;
let lastMessageNotificationTime = 0;
let lastLoginNotificationTime = 0;
const PRESENCE_COOLDOWN = 5000; // 5 seconds
const MESSAGE_COOLDOWN = 10000; // 10 seconds
const LOGIN_COOLDOWN = 5000; // 5 seconds cooldown for login notifications
let jarifActivityStatus = "offline"; // "online" or "offline" based on visibleAndFocused

// ==================== HELPER FUNCTIONS ====================
async function sendDiscordNotification(
  mention,
  embedDescription,
  isActivity = false,
  isOffline = false,
  isLogin = false
) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("Discord webhook not configured.");
    return;
  }

  // Check cooldown for presence notifications
  if (isActivity || isOffline) {
    const now = Date.now();
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      console.log("⏭️ Skipping presence notification - cooldown active");
      return;
    }
    lastPresenceNotificationTime = now;
  }

  // Check cooldown for message notifications
  if (!isActivity && !isOffline && !isLogin) {
    const now = Date.now();
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      console.log("⏭️ Skipping message notification - cooldown active");
      return;
    }
    lastMessageNotificationTime = now;
  }

  // Check cooldown for login notifications
  if (isLogin) {
    const now = Date.now();
    if (now - lastLoginNotificationTime < LOGIN_COOLDOWN) {
      console.log("⏭️ Skipping login notification - cooldown active");
      return;
    }
    lastLoginNotificationTime = now;
  }

  // Create event key for deduplication
  const eventKey = `${
    isActivity
      ? "activity"
      : isOffline
      ? "offline"
      : isLogin
      ? "login"
      : "message"
  }_${Date.now()}`;
  if (processedPresenceEvents.has(eventKey)) {
    console.log("⏭️ Skipping duplicate event:", eventKey);
    return;
  }
  processedPresenceEvents.add(eventKey);

  // Clean up old events
  if (processedPresenceEvents.size > 100) {
    const arr = Array.from(processedPresenceEvents);
    processedPresenceEvents = new Set(arr.slice(-50));
  }

  // Get correct time (Bahrain Time - UTC+3)
  const now = new Date();
  const bahrainTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );
  const currentTime = bahrainTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const timeSuffix = bahrainTime.getHours() >= 12 ? "PM" : "AM";
  const footerText = isActivity
    ? `Came online at ${currentTime}`
    : isOffline
    ? `Went offline at ${currentTime}`
    : isLogin
    ? `Accessed at ${currentTime}`
    : `Sent at ${currentTime}`;

  let color;
  if (isActivity) {
    color = 3066993; // Green
  } else if (isOffline) {
    color = 15158332; // Red
  } else if (isLogin) {
    color = 16776960; // Yellow
  } else {
    color = 3447003; // Blue
  }

  const webhookBody = {
    content: mention,
    embeds: [
      {
        description: embedDescription,
        color: color,
        footer: { text: footerText },
      },
    ],
  };

  try {
    console.log(`📤 Sending Discord notification: ${embedDescription}`);
    console.log(`🕐 Time: ${currentTime} AST (Bahrain Time)`);
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody),
      timeout: 5000,
    });

    if (response.ok) {
      console.log(
        `✅ Discord notification sent successfully: ${embedDescription}`
      );
    } else {
      console.error(
        `❌ Failed to send Discord notification: ${response.status} ${response.statusText}`
      );
      const text = await response.text();
      console.error("Response:", text.substring(0, 200));
    }
  } catch (error) {
    console.error(
      "❌ Network error sending Discord notification:",
      error.message
    );
  }
}

// Helper to format time in Bahrain timezone
function formatBahrainTime(timestamp) {
  const date = new Date(timestamp);
  const bahrainDate = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );
  return bahrainDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
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
    hour12: true,
    timeZone: "Asia/Bahrain",
  });
}

// ==================== FIXED NOTIFICATION LOGIC ====================
async function checkMessageForNotification(message) {
  // 1. Only messages from Fi to Jarif
  if (message.sender !== USER_FIDHA) {
    return;
  }

  const bahrainTime = formatBahrainDateTime(
    message.timestampFull || Date.now()
  );
  console.log("🔍 Server checking message for notification:", {
    messageId: message.id,
    sender: message.sender,
    textPreview: message.text
      ? message.text.substring(0, 50) + (message.text.length > 50 ? "..." : "")
      : "[No text]",
    timestamp: bahrainTime,
  });

  // 2. Skip if already processed by this server
  if (processedMessageIds.has(message.id)) {
    console.log("⏭️ Skipping - already processed.");
    return;
  }

  // 3. Get Jarif's latest notification settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
    console.log("⚙️ Jarif notification settings:", jarifSettings);
  } catch (error) {
    console.error("❌ Error fetching notification settings:", error);
    jarifSettings = null;
  }

  // If settings don't exist or message notifications are off, stop.
  if (!jarifSettings || !jarifSettings.messageNotifications) {
    console.log(
      "⏭️ Skipping - Jarif has message notifications disabled or settings not found."
    );
    return;
  }

  // 4. Skip if Jarif has saved this message
  if (message.savedBy && message.savedBy[USER_JARIF]) {
    console.log("⏭️ Skipping - message is saved by Jarif.");
    return;
  }

  // 5. Skip if Jarif has already read it
  if (message.readBy && message.readBy[USER_JARIF]) {
    console.log("⏭️ Skipping - message has been read by Jarif.");
    return;
  }

  // 6. CRITICAL FIX: Check Jarif's ACTUAL ACTIVITY STATUS, not just online presence
  // We need to check if Jarif is "active" (visibleAndFocused: true) or just "online"
  let jarifIsActiveAtMessageTime = false;
  try {
    // Get Jarif's presence data at the time of message
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (jarifPresence) {
      // Check if Jarif was actually active (not just online)
      // visibleAndFocused = true means browser tab is active and focused
      // If visibleAndFocused is false or undefined, Jarif is inactive
      const jarifWasVisibleAndFocused =
        jarifPresence.visibleAndFocused === true;

      // Also check if Jarif was recently active (within last 30 seconds)
      const messageTime = message.timestampFull || Date.now();
      const timeSinceLastSeen = Math.abs(jarifPresence.lastSeen - messageTime);

      // Jarif is considered active if:
      // 1. visibleAndFocused is true AND
      // 2. lastSeen was within 30 seconds of message time
      jarifIsActiveAtMessageTime =
        jarifWasVisibleAndFocused && timeSinceLastSeen < 30000;

      console.log("👤 Jarif activity check:", {
        visibleAndFocused: jarifWasVisibleAndFocused,
        lastSeen: formatBahrainDateTime(jarifPresence.lastSeen),
        messageTime: formatBahrainDateTime(messageTime),
        timeSinceLastSeen: Math.round(timeSinceLastSeen / 1000) + "s",
        isActive: jarifIsActiveAtMessageTime,
      });
    }
  } catch (error) {
    console.error("❌ Error checking Jarif activity for message:", error);
  }

  // 7. DECISION: Send notification ONLY if Jarif was INACTIVE at message time
  if (jarifIsActiveAtMessageTime) {
    console.log(
      "⏭️ Skipping - Jarif was active (visible and focused) when the message was sent."
    );
  } else {
    console.log(
      "🚨 SENDING NOTIFICATION - Jarif was inactive when Fi sent a message."
    );
    await sendDiscordNotification(
      `<@765280345260032030>`, // Your Discord user ID
      `\`Fi✨ sent a message\``,
      false, // isActivity
      false, // isOffline
      false // isLogin
    );
    processedMessageIds.add(message.id);
    // Clean up old IDs to prevent memory growth
    if (processedMessageIds.size > 1000) {
      const arr = Array.from(processedMessageIds);
      processedMessageIds = new Set(arr.slice(-500));
    }
  }
}

async function checkActivityForNotification(isActive, presenceData) {
  // 1. Get Jarif's notification settings
  let jarifSettings;
  try {
    const settingsSnap = await db
      .ref(`ephemeral/notificationSettings/${USER_JARIF}`)
      .once("value");
    jarifSettings = settingsSnap.val();
  } catch (error) {
    console.error(
      "❌ Error fetching notification settings for activity:",
      error
    );
    return;
  }

  const wasOnline = previousFiOnlineState;
  const nowOnline = isActive;

  console.log("👁️ Fi Activity Check:", {
    wasOnline,
    nowOnline,
    lastSeen: presenceData?.lastSeen
      ? formatBahrainDateTime(presenceData.lastSeen)
      : "null",
    activityNotificationsEnabled: jarifSettings
      ? jarifSettings.activityNotifications
      : false,
    offlineNotificationsEnabled: jarifSettings
      ? jarifSettings.offlineNotifications
      : false,
  });

  // 2. Check for "went offline" notification
  if (
    wasOnline &&
    !nowOnline &&
    jarifSettings &&
    jarifSettings.offlineNotifications
  ) {
    console.log("📤 Fi went offline - sending notification.");
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is no longer active\``,
      false, // isActivity
      true, // isOffline
      false // isLogin
    );
  }
  // 3. Check for "came online" notification
  else if (
    !wasOnline &&
    nowOnline &&
    jarifSettings &&
    jarifSettings.activityNotifications
  ) {
    console.log("📤 Fi came online - sending notification.");
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is now active\``,
      true, // isActivity
      false, // isOffline
      false // isLogin
    );
  }

  previousFiOnlineState = nowOnline;
}

// ==================== LOGIN PAGE ACCESS NOTIFICATION ====================
async function checkLoginPageAccess(loginData) {
  try {
    const userId = loginData.userId || "Unknown user";
    const timestamp = loginData.timestamp || Date.now();
    const bahrainTime = formatBahrainDateTime(timestamp);

    console.log(`🔓 Login page accessed by: ${userId} at ${bahrainTime}`);

    // Send Discord notification for login access
    await sendDiscordNotification(
      `<@765280345260032030>`, // Your Discord user ID
      `\`🔓 Login page was opened\`\n**User:** ${userId}\n**Time:** ${bahrainTime}\n**Device:** ${
        loginData.userAgent || "Unknown"
      }`,
      false, // isActivity
      false, // isOffline
      true // isLogin
    );

    console.log(`✅ Login notification sent for user: ${userId}`);
  } catch (error) {
    console.error("❌ Error processing login access:", error);
  }
}

// ==================== START LISTENERS ====================
function startFirebaseListeners() {
  console.log("🚀 Starting Firebase listeners...");

  // NEW LISTENER 1: Login Page Access Tracking
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  let processedLoginIds = new Set();

  loginAccessRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      const loginId = snapshot.key;

      // Skip if already processed
      if (processedLoginIds.has(loginId)) {
        snapshot.ref.remove().catch(() => {});
        return;
      }

      // Process the login notification
      await checkLoginPageAccess(loginData);

      // Mark as processed
      processedLoginIds.add(loginId);

      // Clean up old processed IDs
      if (processedLoginIds.size > 100) {
        const arr = Array.from(processedLoginIds);
        processedLoginIds = new Set(arr.slice(-50));
      }

      // Remove the record after processing (with delay to ensure it's processed)
      setTimeout(() => {
        snapshot.ref.remove().catch(() => {
          console.log("✅ Cleaned up login access record:", loginId);
        });
      }, 1000);
    } catch (error) {
      console.error("❌ Error in login access listener:", error);
    }
  });

  // Clean up orphaned login records periodically
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
      console.error("❌ Error cleaning up old login records:", error);
    }
  }, 300000); // Every 5 minutes

  // LISTENER 2: New Messages
  const messagesRef = db.ref("ephemeral/messages");
  messagesRef
    .orderByChild("timestampFull")
    .startAt(Date.now() - 60000)
    .on("child_added", async (snapshot) => {
      try {
        const message = snapshot.val();
        if (!message) return;

        message.id = snapshot.key;

        // Only process recent messages (last 5 minutes)
        const messageTime = message.timestampFull || Date.now();
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

        if (messageTime < fiveMinutesAgo) {
          console.log(
            "⏭️ Skipping old message:",
            formatBahrainDateTime(messageTime)
          );
          return;
        }

        await checkMessageForNotification(message);
      } catch (error) {
        console.error("❌ Error in message listener:", error);
      }
    });

  // LISTENER 3: Fi's Presence (Online/Offline)
  let lastFiPresenceState = null;
  db.ref("ephemeral/presence/Fidha").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online : false;

      // Skip if state hasn't changed
      if (lastFiPresenceState === isActive) {
        return;
      }

      lastFiPresenceState = isActive;
      checkActivityForNotification(isActive, val);
    } catch (error) {
      console.error("❌ Error in presence listener:", error);
    }
  });

  // LISTENER 4: Jarif's Presence (to track his activity status)
  db.ref("ephemeral/presence/Jarif").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      jarifIsCurrentlyOnline = val ? val.online : false;

      // Update activity status based on visibleAndFocused
      if (val && val.visibleAndFocused === true) {
        jarifActivityStatus = "active";
      } else if (val && val.online) {
        jarifActivityStatus = "online";
      } else {
        jarifActivityStatus = "offline";
      }

      if (val && val.lastSeen) {
        jarifLastOnlineTime = val.lastSeen;
      }

      console.log("👤 Jarif presence updated:", {
        online: jarifIsCurrentlyOnline,
        activityStatus: jarifActivityStatus,
        visibleAndFocused: val?.visibleAndFocused || false,
        lastSeen: jarifLastOnlineTime
          ? formatBahrainDateTime(jarifLastOnlineTime)
          : "null",
      });
    } catch (error) {
      console.error("❌ Error updating Jarif presence state:", error);
    }
  });

  console.log(
    "✅ All Firebase listeners are active (including login tracking)."
  );
}

// ==================== START SERVER ====================
startFirebaseListeners();
app.listen(PORT, () => {
  console.log(`✅ Notification server running on port ${PORT}`);
  const now = new Date();
  const bahrainTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );
  const serverTime = bahrainTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Bahrain",
  });
  console.log(`⏰ Server time (Bahrain): ${serverTime} AST`);
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received. Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received. Shutting down gracefully...");
  process.exit(0);
});

// ==================== ERROR HANDLING ====================
process.on("uncaughtException", (error) => {
  console.error("🔥 Uncaught Exception:", error);
  // Don't exit, let the server try to recover
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Unhandled Rejection at:", promise, "reason:", reason);
});
