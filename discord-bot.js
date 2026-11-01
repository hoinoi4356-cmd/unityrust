/* ============================================================================
   Discord gateway: тримає бота онлайн у Discord.
   ----------------------------------------------------------------------------
   Для надсилання тікетів хостинг бота НЕ потрібен — server.js використовує
   REST API Discord із токеном. Цей модуль потрібен лише для того, щоб бот
   світився онлайн (зелений статус) і міг у майбутньому обробляти взаємодії
   (кнопки/команди).

   Запускається автоматично, якщо заданий DISCORD_BOT_TOKEN.
   ========================================================================== */
"use strict";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

function startDiscordBot(options = {}) {
  const token = String(options.token || "");
  if (!token) return null;

  let WebSocket;
  try {
    WebSocket = require("ws");
  } catch (error) {
    console.warn("Discord bot: пакет ws не встановлено — gateway вимкнено.");
    return null;
  }

  const logger = options.logger || console;
  const activity = options.activity || { name: "Unity Rust", type: 3 }; // 3 = Watching
  const status = options.status || "online";

  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let sequence = null;
  let acked = true;
  let attempts = 0;
  let stopped = false;

  function clearTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function send(op, d) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op, d }));
    }
  }

  function heartbeat() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!acked) {
      // Попередній heartbeat не підтверджено — з'єднання «зомбі».
      try { socket.terminate(); } catch (error) {}
      return;
    }
    acked = false;
    send(1, sequence);
  }

  function identify() {
    send(2, {
      token,
      intents: 1, // GUILDS — достатньо, щоб бути онлайн і бачити сервер
      properties: { os: "linux", browser: "unity-rust-site", device: "unity-rust-site" },
      presence: { status, since: null, activities: [activity], afk: false }
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(30000, 5000 + attempts * 5000);
    attempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    clearTimers();
    attempts = Math.max(attempts, 0);

    try {
      socket = new WebSocket(GATEWAY_URL);
    } catch (error) {
      logger.warn("Discord bot: не вдалося відкрити gateway —", error?.message || error);
      scheduleReconnect();
      return;
    }

    socket.on("open", () => {
      attempts = 0;
    });

    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (error) { return; }
      if (message.s != null) sequence = message.s;

      switch (message.op) {
        case 10: { // HELLO
          const interval = Number(message.d?.heartbeat_interval) || 41250;
          heartbeatTimer = setInterval(heartbeat, interval);
          heartbeat();
          identify();
          break;
        }
        case 11: // HEARTBEAT_ACK
          acked = true;
          break;
        case 1: // запит heartbeat
          heartbeat();
          break;
        case 7: // RECONNECT
          try { socket.close(); } catch (error) {}
          break;
        case 9: // INVALID_SESSION
          sequence = null;
          reconnectTimer = setTimeout(connect, 3000);
          break;
        case 0: // DISPATCH
          if (message.t === "READY") {
            const user = message.d?.user;
            logger.log(`Discord bot online: ${user?.username || "bot"}${user?.id ? " (" + user.id + ")" : ""}`);
          }
          break;
      }
    });

    socket.on("close", (code, reason) => {
      clearTimers();
      if (stopped) return;
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        logger.warn(`Discord bot: gateway закрито (${code}). Перевір DISCORD_BOT_TOKEN.`);
        return;
      }
      scheduleReconnect();
    });

    socket.on("error", (error) => {
      logger.warn("Discord bot: gateway error —", error?.message || error);
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimers();
      try { socket && socket.close(1000); } catch (error) {}
    }
  };
}

module.exports = { startDiscordBot };
