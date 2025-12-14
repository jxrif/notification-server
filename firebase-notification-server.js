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
const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1306603388033040454/xv7s6tO12dfaup68kf1ZzOj-33wVRWvJxGew6YpZ9cl9arAjYufgLh2a_KxAn0Jz3L_E";

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

// ==================== HELPER FUNCTIONS ====================
async function sendDiscordNotification(
  mention,
  embedDescription,
  isActivity = false,
  isOffline = false
) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("Discord webhook not configured.");
    return;
  }

  // Check for activity notification cooldown (1 second)
  if (isActivity || isOffline) {
    const eventKey = `${isActivity ? "activity" : "offline"}_${Date.now()}`;
    if (processedPresenceEvents.has(eventKey)) return;
    processedPresenceEvents.add(eventKey);

    // Clean up old events
    if (processedPresenceEvents.size > 100) {
      const arr = Array.from(processedPresenceEvents);
      processedPresenceEvents = new Set(arr.slice(-50));
    }
  }

  const currentTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const footerText = isActivity
    ? `Came online at ${currentTime}`
    : isOffline
    ? `Went offline at ${currentTime}`
    : `Sent at ${currentTime}`;

  const webhookBody = {
    content: mention,
    embeds: [
      {
        description: embedDescription,
        color: isActivity ? 3066993 : isOffline ? 15158332 : 3447003,
        footer: { text: footerText },
      },
    ],
  };

  try {
    console.log(`📤 Sending Discord notification: ${embedDescription}`);
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody),
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

// ==================== NOTIFICATION LOGIC ====================
async function checkMessageForNotification(message) {
  // 1. Only messages from Fi to Jarif
  if (message.sender !== USER_FIDHA) {
    return;
  }

  console.log("🔍 Server checking message for notification:", {
    messageId: message.id,
    sender: message.sender,
    textPreview: message.text
      ? message.text.substring(0, 50) + (message.text.length > 50 ? "..." : "")
      : "[No text]",
    timestamp: new Date(message.timestampFull).toISOString(),
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

  // 6. Check Jarif's online status at the time of the message
  let jarifWasOnlineAtMessageTime = false;
  try {
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();
    if (jarifPresence && jarifPresence.lastSeen) {
      const messageTime = message.timestampFull || Date.now();
      const timeDifference = Math.abs(jarifPresence.lastSeen - messageTime);
      jarifWasOnlineAtMessageTime = timeDifference < 30000; // 30 seconds
      console.log("👤 Jarif presence check:", {
        lastSeen: new Date(jarifPresence.lastSeen).toISOString(),
        messageTime: new Date(messageTime).toISOString(),
        difference: Math.round(timeDifference / 1000) + "s",
        wasOnline: jarifWasOnlineAtMessageTime,
      });
    }
  } catch (error) {
    console.error("❌ Error checking Jarif presence for message:", error);
  }

  // 7. DECISION: Send notification only if Jarif was OFFLINE at message time
  if (jarifWasOnlineAtMessageTime) {
    console.log(
      "⏭️ Skipping - Jarif was online around the time the message was sent."
    );
  } else {
    console.log(
      "🚨 SENDING NOTIFICATION - Jarif was offline when Fi sent a message."
    );
    await sendDiscordNotification(
      `<@765280345260032030>`, // Your Discord user ID
      `\`Fi✨ sent a message\``,
      false, // isActivity
      false // isOffline
    );
    processedMessageIds.add(message.id);
    // Optional: Clean up old IDs to prevent memory growth
    if (processedMessageIds.size > 1000) {
      const arr = Array.from(processedMessageIds);
      processedMessageIds = new Set(arr.slice(-500));
    }
  }
}

async function checkActivityForNotification(isActive, lastSeen) {
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
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : "null",
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
      true // isOffline
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
      false // isOffline
    );
  }

  previousFiOnlineState = nowOnline;
}

// ==================== START LISTENERS ====================
function startFirebaseListeners() {
  console.log("🚀 Starting Firebase listeners...");

  // LISTENER 1: New Messages
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
            new Date(messageTime).toISOString()
          );
          return;
        }

        await checkMessageForNotification(message);
      } catch (error) {
        console.error("❌ Error in message listener:", error);
      }
    });

  // LISTENER 2: Fi's Presence (Online/Offline)
  db.ref("ephemeral/presence/Fidha").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      const isActive = val ? val.online : false;
      const lastSeen = val ? val.lastSeen : null;
      checkActivityForNotification(isActive, lastSeen);
    } catch (error) {
      console.error("❌ Error in presence listener:", error);
    }
  });

  // LISTENER 3: Jarif's Presence (to track his online state for message logic)
  db.ref("ephemeral/presence/Jarif").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      jarifIsCurrentlyOnline = val ? val.online : false;
      if (val && val.lastSeen) {
        jarifLastOnlineTime = val.lastSeen;
      }
      console.log("👤 Jarif presence updated:", {
        online: jarifIsCurrentlyOnline,
        lastSeen: jarifLastOnlineTime
          ? new Date(jarifLastOnlineTime).toISOString()
          : "null",
      });
    } catch (error) {
      console.error("❌ Error updating Jarif presence state:", error);
    }
  });

  console.log("✅ All Firebase listeners are active.");
}

// ==================== START SERVER ====================
startFirebaseListeners();
app.listen(PORT, () => {
  console.log(`✅ Notification server running on port ${PORT}`);
  console.log(`⏰ Server time: ${new Date().toISOString()}`);
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
