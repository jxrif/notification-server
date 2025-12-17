const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const requestIp = require("request-ip"); // npm install request-ip
const useragent = require("express-useragent"); // npm install express-useragent
const geoip = require("geoip-lite"); // npm install geoip-lite
const UAParser = require("ua-parser-js"); // npm install ua-parser-js

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for IP detection
app.use(requestIp.mw());
app.use(useragent.express());

// ==================== EXTENDED CONFIGURATION ====================
const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1306603388033040454/xv7s6tO12dfaup68kf1ZzOj-33wVRWvJxGew6YpZ9cl9arAjYufgLh2a_KxAn0Jz3L_E";

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

// Keep-alive endpoints
app.get("/", (req, res) => res.send("Advanced Tracking Server is running."));
app.get("/health", (req, res) => res.send("OK"));

// ==================== FIREBASE INIT ====================
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    console.log("Using Firebase service account from environment variable");
  } else {
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

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ephemeral-chat-demo-default-rtdb.firebaseio.com",
});
const db = admin.database();

console.log("✅ Firebase initialized successfully");
console.log(
  `📱 Discord webhook: ${DISCORD_WEBHOOK_URL ? "Configured" : "Missing!"}`
);

// ==================== GLOBAL STATE ====================
let activeSessions = new Map(); // sessionId -> {startTime, lastPing, data}
const trackedUsers = new Map(); // IP -> user history

// Original notification state
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

// ==================== EXTENDED DATA COLLECTION FUNCTIONS ====================

async function collectUserData(req, sessionData = {}) {
  const clientIp = req.clientIp;
  const userAgent = req.useragent;
  const parser = new UAParser(req.headers["user-agent"]);
  const uaResult = parser.getResult();

  // Get geolocation from IP
  const geo = geoip.lookup(clientIp);

  // Collect browser fingerprint data
  const browserFingerprint = {
    userAgent: req.headers["user-agent"],
    accept: req.headers["accept"],
    encoding: req.headers["accept-encoding"],
    language: req.headers["accept-language"],
    connection: req.headers["connection"],
    dnt: req.headers["dnt"], // Do Not Track header
    upgradeInsecureRequests: req.headers["upgrade-insecure-requests"],
  };

  // Enhanced data collection
  const comprehensiveData = {
    // Connection Information
    connection: {
      ip: clientIp,
      isIPv4: clientIp.includes("."),
      isIPv6: clientIp.includes(":"),
      localIp: req.connection.remoteAddress,
      forwardedFor: req.headers["x-forwarded-for"] || null,
      realIp: req.headers["x-real-ip"] || null,
    },

    // Geolocation (if available)
    geolocation: geo
      ? {
          country: geo.country,
          region: geo.region,
          city: geo.city,
          timezone: geo.timezone,
          ll: geo.ll, // latitude/longitude
          metro: geo.metro || null,
          area: geo.area || null,
        }
      : null,

    // Device Information
    device: {
      type: userAgent.isMobile
        ? "mobile"
        : userAgent.isDesktop
        ? "desktop"
        : userAgent.isTablet
        ? "tablet"
        : "unknown",
      mobile: userAgent.isMobile,
      tablet: userAgent.isTablet,
      desktop: userAgent.isDesktop,
      bot: userAgent.isBot,
      source: userAgent.source,
    },

    // Browser Details
    browser: {
      name: uaResult.browser.name,
      version: uaResult.browser.version,
      major: uaResult.browser.major,
      engine: uaResult.engine.name,
      engineVersion: uaResult.engine.version,
    },

    // Operating System
    os: {
      name: uaResult.os.name,
      version: uaResult.os.version,
    },

    // Hardware/CPU
    cpu: {
      architecture: uaResult.cpu.architecture,
    },

    // Network Information
    network: {
      hostname: req.hostname,
      referer: req.headers.referer || "direct",
      origin: req.headers.origin || null,
      secFetch: {
        mode: req.headers["sec-fetch-mode"],
        site: req.headers["sec-fetch-site"],
        user: req.headers["sec-fetch-user"],
        dest: req.headers["sec-fetch-dest"],
      },
    },

    // Timing Information
    timing: {
      serverTime: Date.now(),
      timezoneOffset: new Date().getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },

    // Headers (careful with sensitive data)
    headers: {
      userAgent: browserFingerprint.userAgent,
      acceptLanguages: browserFingerprint.language,
      acceptedEncodings: browserFingerprint.encoding,
      acceptedTypes: browserFingerprint.accept,
      doNotTrack: browserFingerprint.dnt === "1",
    },

    // Additional metadata
    metadata: {
      sessionId: sessionData.sessionId || null,
      userId: sessionData.userId || null,
      pageUrl: req.originalUrl,
      method: req.method,
      protocol: req.protocol,
      secure: req.secure,
    },
  };

  return comprehensiveData;
}

async function reverseGeocode(lat, lon) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`
    );
    const data = await response.json();
    return {
      address: data.display_name,
      type: data.type,
      importance: data.importance,
      boundingbox: data.boundingbox,
    };
  } catch (error) {
    return null;
  }
}

async function getISPInfo(ip) {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}`);
    const data = await response.json();
    return {
      isp: data.isp,
      org: data.org,
      as: data.as,
      mobile: data.mobile,
      proxy: data.proxy,
      hosting: data.hosting,
    };
  } catch (error) {
    return null;
  }
}

// ==================== COMPREHENSIVE DISCORD NOTIFICATION ====================

async function sendComprehensiveDiscordNotification(type, data) {
  if (!DISCORD_WEBHOOK_URL) return;

  const now = new Date();
  const bahrainTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bahrain" })
  );

  let embed = {};
  let color = 0;

  switch (type) {
    case "login_page_opened":
      embed = {
        title: "🔓 LOGIN PAGE ACCESSED",
        description: "Someone has accessed the login page",
        color: 16776960, // Yellow
        fields: [
          {
            name: "🌐 Connection Info",
            value: `**IP:** \`${data.connection?.ip || data.ip}\`\n**ISP:** ${
              data.ispInfo?.isp || "Unknown"
            }\n**Proxy:** ${data.ispInfo?.proxy ? "Yes" : "No"}`,
            inline: true,
          },
          {
            name: "📍 Location",
            value: `**Country:** ${
              data.geolocation?.country || "Unknown"
            }\n**City:** ${data.geolocation?.city || "Unknown"}\n**Region:** ${
              data.geolocation?.region || "Unknown"
            }`,
            inline: true,
          },
          {
            name: "💻 Device",
            value: `**Type:** ${data.device?.type || "Unknown"}\n**OS:** ${
              data.os?.name || "Unknown"
            } ${data.os?.version || ""}\n**Browser:** ${
              data.browser?.name || "Unknown"
            } ${data.browser?.version || ""}`,
            inline: true,
          },
          {
            name: "🕐 Time",
            value: `**Access Time:** ${bahrainTime.toLocaleString("en-US", {
              timeZone: "Asia/Bahrain",
            })}\n**Server Time:** ${now.toLocaleString()}`,
            inline: false,
          },
          {
            name: "📊 User Agent",
            value: `\`\`\`${(
              data.headers?.userAgent ||
              data.userAgent ||
              ""
            ).substring(0, 100)}...\`\`\``,
            inline: false,
          },
        ],
        footer: {
          text: `Session ID: ${
            data.metadata?.sessionId || data.sessionId || "N/A"
          }`,
        },
        timestamp: new Date().toISOString(),
      };
      break;

    case "login_page_closed":
      const duration = Math.round(
        (Date.now() - (data.startTime || data.timestamp || Date.now())) / 1000
      );
      embed = {
        title: "🔒 LOGIN PAGE CLOSED",
        description: "User has left the login page",
        color: 15158332, // Red
        fields: [
          {
            name: "📈 Session Duration",
            value: `**Time Spent:** ${duration} seconds\n**Page Visits:** ${
              data.visitCount || 1
            }\n**Last Active:** ${new Date(
              data.lastPing || Date.now()
            ).toLocaleTimeString()}`,
            inline: true,
          },
          {
            name: "👤 User Info",
            value: `**IP:** \`${
              data.connection?.ip || data.ip || "Unknown"
            }\`\n**Device:** ${data.device?.type || "Unknown"}\n**Browser:** ${
              data.browser?.name || "Unknown"
            }`,
            inline: true,
          },
          {
            name: "📍 Location",
            value: `${data.geolocation?.city || data.geo?.city || "Unknown"}, ${
              data.geolocation?.country || data.geo?.country || "Unknown"
            }`,
            inline: true,
          },
          {
            name: "📊 Behavioral Data",
            value: `**Referrer:** ${
              data.network?.referer || data.referer || "Direct"
            }\n**Language:** ${
              data.headers?.acceptLanguages || data.language || "Unknown"
            }\n**DNT:** ${data.headers?.doNotTrack ? "Enabled" : "Disabled"}`,
            inline: false,
          },
        ],
        footer: {
          text: `Session ID: ${
            data.metadata?.sessionId || data.sessionId || "N/A"
          } | Total time: ${duration}s`,
        },
        timestamp: new Date().toISOString(),
      };
      break;

    case "user_activity":
      embed = {
        title: "👁️ USER ACTIVITY DETECTED",
        description: "Additional user activity detected",
        color: 3447003, // Blue
        fields: [
          {
            name: "📱 Activity Type",
            value: data.activityType || "Page interaction",
            inline: true,
          },
          {
            name: "📍 Location",
            value: `${data.geolocation?.city || data.geo?.city || "Unknown"}, ${
              data.geolocation?.country || data.geo?.country || "Unknown"
            }`,
            inline: true,
          },
          {
            name: "🕐 Timestamp",
            value: new Date().toLocaleString("en-US", {
              timeZone: "Asia/Bahrain",
            }),
            inline: true,
          },
          {
            name: "📊 Details",
            value: data.details || "No additional details",
            inline: false,
          },
        ],
        footer: { text: `IP: ${data.connection?.ip || data.ip || "Unknown"}` },
        timestamp: new Date().toISOString(),
      };
      break;

    case "original_notification":
      // For backward compatibility with original notifications
      embed = {
        description: data.message,
        color: data.isActivity ? 3066993 : data.isOffline ? 15158332 : 3447003,
        footer: {
          text:
            data.footerText ||
            `Sent at ${bahrainTime.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              hour12: true,
            })}`,
        },
      };
      break;
  }

  const webhookBody = {
    content: `<@765280345260032030>`, // Your Discord ID
    embeds: [embed],
  };

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody),
    });
  } catch (error) {
    console.error("Discord notification failed:", error.message);
  }
}

// ==================== ORIGINAL NOTIFICATION FUNCTIONS (Preserved) ====================

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

  // Use the comprehensive notification function
  await sendComprehensiveDiscordNotification("original_notification", {
    message: embedDescription,
    isActivity: isActivity,
    isOffline: isOffline,
    isLogin: isLogin,
    footerText: footerText,
  });
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

// ==================== ORIGINAL NOTIFICATION LOGIC ====================

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

// ==================== COMPREHENSIVE TRACKING LISTENERS ====================

function startComprehensiveTrackingListeners() {
  console.log("🚀 Starting comprehensive user tracking...");

  // Track login page access
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  const userSessionsRef = db.ref("ephemeral/userSessions");

  // Clean up old sessions periodically
  setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.lastPing < oneHourAgo) {
        // Session expired
        sendComprehensiveDiscordNotification("login_page_closed", {
          ...session.data,
          sessionId,
          startTime: session.startTime,
          lastPing: session.lastPing,
        });
        activeSessions.delete(sessionId);
      }
    }
  }, 300000); // Check every 5 minutes

  // Listen for new login page access
  loginAccessRef.on("child_added", async (snapshot) => {
    try {
      const loginData = snapshot.val();
      if (!loginData) return;

      const sessionId =
        loginData.sessionId ||
        `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create mock request object for data collection
      const mockReq = {
        clientIp: loginData.ip || "0.0.0.0",
        headers: {
          "user-agent": loginData.userAgent || "Unknown",
          "accept-language": loginData.language || "en-US",
          referer: loginData.referer || null,
          dnt: loginData.doNotTrack ? "1" : "0",
        },
        connection: { remoteAddress: loginData.ip || "0.0.0.0" },
        hostname: "client",
        originalUrl: "/",
        method: "GET",
        protocol: "https",
        secure: true,
        useragent: {
          isMobile: loginData.isMobile || false,
          isDesktop: !loginData.isMobile || true,
          isTablet: false,
          isBot: false,
          source: "client",
        },
      };

      // Collect comprehensive data
      const userData = await collectUserData(mockReq, {
        sessionId,
        userId: loginData.userId,
      });

      // Get ISP information
      const ispInfo = await getISPInfo(userData.connection.ip);

      // Store session
      activeSessions.set(sessionId, {
        startTime: Date.now(),
        lastPing: Date.now(),
        data: {
          ...userData,
          ispInfo,
          visitCount: 1,
          sessionId,
        },
      });

      // Send comprehensive notification
      await sendComprehensiveDiscordNotification("login_page_opened", {
        ...userData,
        ispInfo,
        sessionId,
      });

      // Store in Firebase for persistence
      userSessionsRef.child(sessionId).set({
        startTime: Date.now(),
        ip: userData.connection.ip,
        device: userData.device,
        browser: userData.browser,
        os: userData.os,
        geo: userData.geolocation,
        ispInfo: ispInfo,
        lastActivity: Date.now(),
        status: "active",
      });

      // Remove the trigger record
      snapshot.ref.remove();
    } catch (error) {
      console.error("❌ Error processing login access:", error);
    }
  });

  // Listen for heartbeat pings
  const heartbeatRef = db.ref("ephemeral/heartbeat");
  heartbeatRef.on("child_added", (snapshot) => {
    try {
      const heartbeatData = snapshot.val();
      const sessionId = heartbeatData.sessionId;

      if (activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        session.lastPing = Date.now();
        session.data.lastActivity = new Date().toISOString();

        // Update activity count
        if (!session.data.activityCount) session.data.activityCount = 0;
        session.data.activityCount++;

        // Update in Firebase
        userSessionsRef.child(sessionId).update({
          lastActivity: Date.now(),
          activityCount: session.data.activityCount,
          "metadata.lastInteraction": heartbeatData.interactionType || "ping",
        });

        // Send activity notification for significant interactions
        if (
          heartbeatData.interactionType &&
          heartbeatData.interactionType !== "ping"
        ) {
          sendComprehensiveDiscordNotification("user_activity", {
            ...session.data,
            activityType: heartbeatData.interactionType,
            details: heartbeatData.details,
          });
        }
      }

      snapshot.ref.remove();
    } catch (error) {
      console.error("❌ Error processing heartbeat:", error);
    }
  });

  // Listen for session end events
  const sessionEndRef = db.ref("ephemeral/sessionEnd");
  sessionEndRef.on("child_added", async (snapshot) => {
    try {
      const endData = snapshot.val();
      const sessionId = endData.sessionId;

      if (activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);

        // Calculate duration
        const duration = Math.round((Date.now() - session.startTime) / 1000);

        // Send closing notification
        await sendComprehensiveDiscordNotification("login_page_closed", {
          ...session.data,
          sessionId,
          startTime: session.startTime,
          lastPing: session.lastPing,
          visitCount: session.data.visitCount || 1,
          duration: duration,
        });

        // Update in Firebase
        userSessionsRef.child(sessionId).update({
          endTime: Date.now(),
          duration: duration,
          status: "closed",
          closeReason: endData.reason || "user_action",
        });

        // Remove from active sessions
        activeSessions.delete(sessionId);
      }

      snapshot.ref.remove();
    } catch (error) {
      console.error("❌ Error processing session end:", error);
    }
  });

  console.log("✅ Comprehensive tracking system active");
}

// ==================== ORIGINAL NOTIFICATION LISTENERS ====================

function startOriginalNotificationListeners() {
  console.log("🔔 Starting original notification listeners...");

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

  console.log("✅ Original notification listeners active");
}

// ==================== START ALL LISTENERS ====================

function startAllListeners() {
  startComprehensiveTrackingListeners();
  startOriginalNotificationListeners();
}

// ==================== API ENDPOINT ====================

// API endpoint to get user's IP (for frontend)
app.get("/api/get-ip", (req, res) => {
  const clientIp = req.clientIp;
  const userAgent = req.headers["user-agent"];

  // Get geolocation
  const geo = geoip.lookup(clientIp);

  res.json({
    ip: clientIp,
    userAgent: userAgent,
    geolocation: geo,
    timestamp: Date.now(),
    headers: {
      referer: req.headers.referer,
      acceptLanguage: req.headers["accept-language"],
    },
  });
});

// ==================== START SERVER ====================
startAllListeners();

app.listen(PORT, () => {
  console.log(`✅ Advanced tracking server running on port ${PORT}`);
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
  console.log(`📊 Tracking endpoints active:`);
  console.log(`   • /api/get-ip - Get user IP and info`);
  console.log(`   • /health - Health check`);
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received. Shutting down gracefully...");
  // Save all active sessions
  for (const [sessionId, session] of activeSessions.entries()) {
    console.log(
      `Session ${sessionId} was active for ${Math.round(
        (Date.now() - session.startTime) / 1000
      )}s`
    );
  }
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
