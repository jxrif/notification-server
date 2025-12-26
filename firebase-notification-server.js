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

const USER_FIDHA = "Fidha";
const USER_JARIF = "Jarif";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ephemeral-chat-demo-default-rtdb.firebaseio.com",
});
const db = admin.database();

let jarifLastOnlineTime = Date.now();
let jarifIsCurrentlyOnline = false;
let previousFiOnlineState = false;
let processedMessageIds = new Set();
let processedPresenceEvents = new Set();
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
  isActivity = false,
  isOffline = false,
  isLogin = false
) {
  if (!DISCORD_WEBHOOK_URL) {
    return;
  }

  if (isActivity || isOffline) {
    const now = Date.now();
    if (now - lastPresenceNotificationTime < PRESENCE_COOLDOWN) {
      return;
    }
    lastPresenceNotificationTime = now;
  }

  if (!isActivity && !isOffline && !isLogin) {
    const now = Date.now();
    if (now - lastMessageNotificationTime < MESSAGE_COOLDOWN) {
      return;
    }
    lastMessageNotificationTime = now;
  }

  if (isLogin) {
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
    : `Sent at ${formattedTime} AST`;

  let color;
  if (isActivity) {
    color = 3066993;
  } else if (isOffline) {
    color = 15158332;
  } else if (isLogin) {
    color = 16776960;
  } else {
    color = 3447003;
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
    const response = await fetch(DISCORD_WEBHOOK_URL, {
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

  if (message.savedBy && message.savedBy[USER_JARIF]) {
    return;
  }

  if (message.readBy && message.readBy[USER_JARIF]) {
    return;
  }

  let jarifIsActiveAtMessageTime = false;
  try {
    const presenceSnap = await db
      .ref(`ephemeral/presence/${USER_JARIF}`)
      .once("value");
    const jarifPresence = presenceSnap.val();

    if (jarifPresence) {
      const jarifWasVisibleAndFocused =
        jarifPresence.visibleAndFocused === true;

      const messageTime = message.timestampFull || Date.now();
      const timeSinceLastSeen = Math.abs(jarifPresence.lastSeen - messageTime);

      jarifIsActiveAtMessageTime =
        jarifWasVisibleAndFocused && timeSinceLastSeen < 3000;
    }
  } catch (error) {}

  if (jarifIsActiveAtMessageTime) {
  } else {
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ sent a message\``,
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

async function checkActivityForNotification(isActive, presenceData) {
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

  if (
    wasOnline &&
    !nowOnline &&
    jarifSettings &&
    jarifSettings.offlineNotifications
  ) {
    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`Fi✨ is no longer active\``,
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
      `\`Fi✨ is now active\``,
      true,
      false,
      false
    );
  }

  previousFiOnlineState = nowOnline;
}

async function checkLoginPageAccess(loginData) {
  try {
    const userId = loginData.userId || "Unknown user";
    const timestamp = loginData.timestamp || Date.now();

    const bahrainNow = new Date(timestamp).toLocaleString("en-US", {
      timeZone: "Asia/Bahrain",
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });

    // Helper: try many places to find a physical resolution (best-first).
    function formatScreenFromPayload(payload) {
      if (!payload || typeof payload !== "object") return "Unknown";

      const s = payload.actualScreen || {};

      // 1) actualScreen.physicalWidth/height (explicit numeric)
      if (
        typeof s.physicalWidth === "number" &&
        s.physicalWidth > 0 &&
        typeof s.physicalHeight === "number" &&
        s.physicalHeight > 0
      ) {
        const physical = `${s.physicalWidth}x${s.physicalHeight}`;
        const logical =
          s.logicalWidth && s.logicalHeight
            ? `${s.logicalWidth}x${s.logicalHeight}`
            : payload.deviceScreen || "unknown";
        return `${physical} (physical px) / ${logical} (CSS px)`;
      }

      // 2) physicalResolution string (e.g. "1080x2400")
      if (
        payload.physicalResolution &&
        typeof payload.physicalResolution === "string" &&
        payload.physicalResolution.includes("x")
      ) {
        return `${payload.physicalResolution} (physical px)`;
      }

      // 3) actualScreen.width/height fallback
      if (
        typeof s.width === "number" &&
        s.width > 0 &&
        typeof s.height === "number" &&
        s.height > 0
      ) {
        const logical = `${s.width}x${s.height}`;
        // try to compute approximate physical using pixelRatio if provided
        if (typeof s.pixelRatio === "number" && s.pixelRatio > 0) {
          const physW = Math.round(s.width * s.pixelRatio);
          const physH = Math.round(s.height * s.pixelRatio);
          return `${physW}x${physH} (approx physical px) / ${logical} (CSS px)`;
        }
        return `${logical} (screen.width/height - maybe CSS px)`;
      }

      // 4) deviceScreen (logical) if present
      if (
        payload.deviceScreen &&
        typeof payload.deviceScreen === "string" &&
        payload.deviceScreen.includes("x")
      ) {
        return `${payload.deviceScreen} (CSS px)`;
      }

      // 5) viewport last resort
      if (payload.viewportSize) {
        return `${payload.viewportSize} (viewport — may change with window)`;
      }

      // 6) Nothing useful — provide a short debug snippet but don't spam entire payload
      try {
        const short = JSON.stringify({
          physicalResolution: payload.physicalResolution,
          actualScreen: payload.actualScreen && {
            physicalWidth: payload.actualScreen.physicalWidth,
            physicalHeight: payload.actualScreen.physicalHeight,
            pixelRatio: payload.actualScreen.pixelRatio,
            width: payload.actualScreen.width,
            height: payload.actualScreen.height,
          },
          deviceScreen: payload.deviceScreen,
          viewportSize: payload.viewportSize,
        });
        // if everything is null/undefined, it will be "{}" — still useful
        return `Unknown (debug: ${short})`;
      } catch (e) {
        return "Unknown";
      }
    }

    const deviceId = loginData.deviceId || "Unknown device";
    const deviceModel = loginData.deviceModel || "Unknown";
    const deviceType = loginData.deviceType || "Unknown";
    const platform = loginData.platform || "Unknown";
    const screenString = formatScreenFromPayload(loginData);

    // Log the raw (short) payload server-side for debugging (only if needed)
    console.debug("loginData (short):", {
      deviceId,
      physicalResolution: loginData.physicalResolution,
      actualScreen: loginData.actualScreen && {
        physicalWidth: loginData.actualScreen.physicalWidth,
        physicalHeight: loginData.actualScreen.physicalHeight,
        pixelRatio: loginData.actualScreen.pixelRatio,
      },
      viewportSize: loginData.viewportSize,
    });

    const deviceInfo = `**Device ID:** ${deviceId}\n**Model:** ${deviceModel} (${deviceType})\n**Platform:** ${platform}\n**Screen:** ${screenString}`;

    await sendDiscordNotification(
      `<@765280345260032030>`,
      `\`🔓 Login page was opened\`\n**User:** ${userId}\n${deviceInfo}\n**User Agent:** ${
        loginData.userAgent || "Unknown"
      }\n**Time:** ${bahrainNow} AST`,
      false,
      false,
      true
    );
  } catch (error) {
    console.error("checkLoginPageAccess error:", error);
  }
}

function startFirebaseListeners() {
  const loginAccessRef = db.ref("ephemeral/loginAccess");
  let processedLoginIds = new Set();

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

  db.ref("ephemeral/presence/Jarif").on("value", (snapshot) => {
    try {
      const val = snapshot.val();
      jarifIsCurrentlyOnline = val ? val.online : false;

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
