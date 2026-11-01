const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
/* ws потрібен лише для RCON. У публічному режимі без RCON його може не бути. */
let WebSocket = null;
try { WebSocket = require("ws"); } catch (error) { WebSocket = null; }

/* ------------------------------------------------------------------ режим */
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const PORT = Number(process.env.PORT) || 8088;
const HOST = process.env.HOST || (IS_PROD ? "0.0.0.0" : "127.0.0.1");

/* --------------------------------------------------------------- секрети
   Тільки process.env. Файл nexus-site.config.json більше не читається:
   якщо він колись потрапить у репозиторій, пароль RCON/адмінки не буде
   злито разом із кодом. */
const RCON_URL = String(process.env.RCON_URL || "").trim();
const RCON_NAME = process.env.RCON_NAME || "UNITY ADMIN";
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const OWNER_STEAM_ID = String(process.env.OWNER_STEAM_ID || "").trim();
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL || (IS_PROD ? "" : "http://127.0.0.1:8088")
).replace(/\/+$/, "");

/* Публічний режим: сайт без БД і без RCON — для безкоштовного хостингу.
   Вмикається SITE_MODE=public. */
const PUBLIC_MODE = String(process.env.SITE_MODE || "").trim().toLowerCase() === "public";
const RCON_ENABLED = !PUBLIC_MODE && Boolean(RCON_URL);

/* Онлайн без RCON: UDP A2S-запит до query-порту Rust-сервера (за замовчуванням 28017). */
const SERVER_QUERY_HOST = String(
  process.env.SERVER_QUERY_HOST || (PUBLIC_MODE ? "5.199.232.192" : "")
).trim();
const SERVER_QUERY_PORT = Number(process.env.SERVER_QUERY_PORT) || 28017;

/* Локально можна відкрити і localhost, і 127.0.0.1. Steam callback
   має повертатися на той самий origin, інакше cookie й postMessage
   потрапляють на інший host. У production — тільки PUBLIC_BASE_URL. */
function baseUrlFor(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (PUBLIC_BASE_URL) {
    if (IS_PROD) return PUBLIC_BASE_URL;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return `http://${host}`;
    return PUBLIC_BASE_URL;
  }
  /* Публічний режим без PUBLIC_BASE_URL: беремо origin із заголовків проксі. */
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (IS_PROD ? "https" : "http");
  return host ? `${proto}://${host}` : "";
}

/* Не секрети, але теж конфігурація — беремо з оточення. */
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || "");
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || "");
const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || "");
let DISCORD_ROLE_IDS = {};
try {
  if (process.env.DISCORD_ROLE_IDS) DISCORD_ROLE_IDS = JSON.parse(process.env.DISCORD_ROLE_IDS);
} catch (error) {
  console.error('DISCORD_ROLE_IDS має бути JSON-об\'єктом, наприклад {"admin":"123"}');
  process.exit(1);
}

/* --------------------------------------------------------------- дані
   DATA_DIR на Render має вказувати на persistent disk, інакше SQLite
   і заявки зникнуть після рестарту. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const PLAYERS_FILE = process.env.PLAYERS_FILE
  ? path.resolve(process.env.PLAYERS_FILE)
  : path.join(DATA_DIR, "players.json");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const BANS_FILE = path.join(DATA_DIR, "bans.json");
const OFFICES_FILE = path.join(DATA_DIR, "offices.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
const PROMOS_FILE = path.join(DATA_DIR, "promos.json");

/* ------------------------------------------------------------ перевірка
   Краще не запуститися, ніж стартувати з порожнім паролем адмінки. */
const problems = [];
if (!PUBLIC_MODE && !ADMIN_PASSWORD) problems.push("ADMIN_PASSWORD не задано");
if (IS_PROD && ADMIN_PASSWORD && ADMIN_PASSWORD.length < 12) {
  problems.push("ADMIN_PASSWORD має бути не коротшим за 12 символів");
}
if (!PUBLIC_MODE && !OWNER_STEAM_ID) problems.push("OWNER_STEAM_ID не задано");
if (OWNER_STEAM_ID && !/^7656\d{13}$/.test(OWNER_STEAM_ID)) {
  problems.push("OWNER_STEAM_ID має бути SteamID64 (17 цифр, починається з 7656)");
}
if (!PUBLIC_MODE && !PUBLIC_BASE_URL) problems.push("PUBLIC_BASE_URL не задано");
if (PUBLIC_BASE_URL && IS_PROD && !/^https:\/\//.test(PUBLIC_BASE_URL)) {
  problems.push("PUBLIC_BASE_URL має бути https://...");
}
if (IS_PROD && !PUBLIC_MODE && !RCON_URL) problems.push("RCON_URL не задано");
if (RCON_URL && !/^wss?:\/\//.test(RCON_URL)) {
  problems.push("RCON_URL має починатися з ws:// або wss://");
}
if (problems.length) {
  console.error("КРИТИЧНА ПОМИЛКА КОНФІГУРАЦІЇ:");
  problems.forEach((problem) => console.error("  - " + problem));
  console.error("Задайте ці змінні оточення в Render → Environment (або в .env локально).");
  process.exit(1);
}
if (IS_PROD && /(^|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/.test(RCON_URL)) {
  console.warn("УВАГА: RCON_URL вказує на localhost. На Render це інший контейнер —");
  console.warn("потрібен публічний wss:// адрес (тунель/VPN), інакше RCON не працюватиме.");
}

/* --------------------------------------------------------------- сховище
   DB_MODE=memory тримає SQLite у RAM: усі функції працюють, але після
   рестарту історія чиста. Це режим для безкоштовного хостингу без
   постійного диска. За замовчуванням — файл data/nexus.db. */
const DB_MODE = PUBLIC_MODE || String(process.env.DB_MODE || "file").trim().toLowerCase() === "memory"
  ? "memory"
  : "file";
const DB_IN_MEMORY = DB_MODE === "memory";

if (!DB_IN_MEMORY && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_IN_MEMORY ? ":memory:" : path.join(DATA_DIR, "nexus.db"));

const adminTokens = new Set();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = IS_PROD || PUBLIC_BASE_URL.startsWith("https://");

/** Порівняння пароля за сталий час, щоб не світити довжину/префікс. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sessionCookie(token, maxAgeSeconds) {
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (COOKIE_SECURE) flags.push("Secure");
  flags.push("Max-Age=" + maxAgeSeconds);
  return "nexus_session=" + token + "; " + flags.join("; ");
}

function createSteamSession(steamId) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare("INSERT INTO steam_sessions (token, steamId, expiresAt) VALUES (?, ?, ?)")
    .run(token, steamId, expiresAt);
  return token;
}

function deleteSteamSession(token) {
  db.prepare("DELETE FROM steam_sessions WHERE token = ?").run(token);
}

function getSteamSession(req) {
  const cookie = String(req.headers.cookie || "");
  const match = cookie.match(/(?:^|;\s*)nexus_session=([^;]+)/);
  if (!match) return null;
  const row = db.prepare("SELECT steamId, expiresAt FROM steam_sessions WHERE token = ?").get(match[1]);
  if (!row || Number(row.expiresAt) < Date.now()) {
    if (row) deleteSteamSession(match[1]);
    return null;
  }
  return { steamId: row.steamId, expiresAt: Number(row.expiresAt) };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}

function withTransaction(fn) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch (rollbackError) {}
    throw error;
  }
}

function ensureData() {
  if (!DB_IN_MEMORY && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      token TEXT,
      steamId TEXT,
      discord TEXT,
      message TEXT,
      role TEXT,
      status TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS bans (
      id TEXT PRIMARY KEY,
      target TEXT,
      reason TEXT,
      admin TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS offices (
      steamId TEXT PRIMARY KEY,
      discord TEXT,
      role TEXT,
      token TEXT,
      status TEXT,
      ticketId TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts (
      steamId TEXT PRIMARY KEY,
      discord TEXT,
      discordId TEXT,
      telegram TEXT,
      steamLinked INTEGER,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      role TEXT,
      completed INTEGER,
      completedBy TEXT,
      completedAt TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS promos (
      id TEXT PRIMARY KEY,
      code TEXT,
      ownerSteamId TEXT,
      ownerRole TEXT,
      activations INTEGER,
      maxActivations INTEGER,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter TEXT,
      target TEXT,
      reason TEXT,
      evidence TEXT,
      video TEXT,
      status TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      steamId TEXT,
      productId TEXT,
      productName TEXT,
      price INTEGER,
      qty INTEGER,
      total INTEGER,
      status TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_logs (
      id TEXT PRIMARY KEY,
      steamId TEXT,
      action TEXT,
      target TEXT,
      reason TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS promo_activations (
      id TEXT PRIMARY KEY,
      promoId TEXT,
      steamId TEXT,
      activatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS steam_sessions (
      token TEXT PRIMARY KEY,
      steamId TEXT,
      expiresAt INTEGER
    );
  `);

  /* Сесії переживають рестарт сервера, інакше після кожного перезапуску
     власник знову бачив би закритий кабінет. */
  db.prepare("DELETE FROM steam_sessions WHERE expiresAt < ?").run(Date.now());

  const reportColumns = db.prepare("PRAGMA table_info(reports)").all().map((column) => column.name);
  if (!reportColumns.includes("video")) db.exec("ALTER TABLE reports ADD COLUMN video TEXT");

  const isEmpty = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count === 0;

  if (isEmpty("tickets")) {
    const data = readJson(TICKETS_FILE, { tickets: [] });
    const rows = Array.isArray(data.tickets) ? data.tickets : [];
    const insert = db.prepare(`INSERT INTO tickets (id, token, steamId, discord, message, role, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    withTransaction(() => rows.forEach((ticket) => insert.run(ticket.id, ticket.token || "", ticket.steamId || "", ticket.discord || "", ticket.message || "", ticket.role || "moderator", ticket.status || "pending", ticket.createdAt || "", ticket.updatedAt || "")));
  }

  if (isEmpty("bans")) {
    const data = readJson(BANS_FILE, { bans: [] });
    const rows = Array.isArray(data.bans) ? data.bans : [];
    const insert = db.prepare(`INSERT INTO bans (id, target, reason, admin, createdAt) VALUES (?, ?, ?, ?, ?)`);
    withTransaction(() => rows.forEach((ban) => insert.run(ban.id, ban.target || "", ban.reason || "", ban.admin || "", ban.createdAt || "")));
  }

  if (isEmpty("offices")) {
    const data = readJson(OFFICES_FILE, { offices: {} });
    const offices = data.offices && typeof data.offices === "object" ? data.offices : {};
    const insert = db.prepare(`INSERT INTO offices (steamId, discord, role, token, status, ticketId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    withTransaction(() => Object.entries(offices).forEach(([steamId, office]) => insert.run(steamId, office.discord || "", office.role || "moderator", office.token || "", office.status || "pending", office.ticketId || null, office.createdAt || "")));
  }

  if (isEmpty("accounts")) {
    const data = readJson(ACCOUNTS_FILE, { accounts: {} });
    const accounts = data.accounts && typeof data.accounts === "object" ? data.accounts : {};
    const insert = db.prepare(`INSERT INTO accounts (steamId, discord, discordId, telegram, steamLinked, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    withTransaction(() => Object.entries(accounts).forEach(([steamId, account]) => insert.run(steamId, account.discord || "", account.discordId || "", account.telegram || "", account.steamLinked ? 1 : 0, account.createdAt || "", account.updatedAt || "")));
  }

  if (isEmpty("tasks")) {
    const data = readJson(TASKS_FILE, { tasks: [] });
    const rows = Array.isArray(data.tasks) ? data.tasks : [];
    const insert = db.prepare(`INSERT INTO tasks (id, title, description, role, completed, completedBy, completedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    withTransaction(() => rows.forEach((task) => insert.run(task.id, task.title || "", task.description || "", task.role || "moderator", task.completed ? 1 : 0, task.completedBy || null, task.completedAt || null, task.createdAt || "")));
  }

  if (isEmpty("promos")) {
    const data = readJson(PROMOS_FILE, { promos: [] });
    const rows = Array.isArray(data.promos) ? data.promos : [];
    const insert = db.prepare(`INSERT INTO promos (id, code, ownerSteamId, ownerRole, activations, maxActivations, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    withTransaction(() => rows.forEach((promo) => insert.run(promo.id, promo.code || "", promo.ownerSteamId || "", promo.ownerRole || "", Number(promo.activations) || 0, Number(promo.maxActivations) || 50, promo.createdAt || "")));
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { return fallback; }
}

function getTickets() {
  return db.prepare("SELECT * FROM tickets ORDER BY createdAt DESC").all();
}
function saveTickets(tickets) {
  const removeAll = db.prepare("DELETE FROM tickets");
  const insert = db.prepare(`INSERT INTO tickets (id, token, steamId, discord, message, role, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(() => {
    removeAll.run();
    tickets.forEach((ticket) => insert.run(ticket.id, ticket.token || "", ticket.steamId || "", ticket.discord || "", ticket.message || "", ticket.role || "moderator", ticket.status || "pending", ticket.createdAt || "", ticket.updatedAt || ""));
  });
}

function getBans() {
  return db.prepare("SELECT * FROM bans ORDER BY createdAt DESC").all();
}
function saveBans(bans) {
  const removeAll = db.prepare("DELETE FROM bans");
  const insert = db.prepare(`INSERT INTO bans (id, target, reason, admin, createdAt) VALUES (?, ?, ?, ?, ?)`);
  withTransaction(() => {
    removeAll.run();
    bans.forEach((ban) => insert.run(ban.id, ban.target || "", ban.reason || "", ban.admin || "", ban.createdAt || ""));
  });
}

function getOffices() {
  const offices = {};
  for (const row of db.prepare("SELECT * FROM offices").all()) {
    offices[row.steamId] = {
      steamId: row.steamId,
      discord: row.discord || "",
      role: row.role || "moderator",
      token: row.token || "",
      status: row.status || "pending",
      ticketId: row.ticketId || null,
      createdAt: row.createdAt || ""
    };
  }
  return offices;
}
function saveOffices(offices) {
  const removeAll = db.prepare("DELETE FROM offices");
  const insert = db.prepare(`INSERT OR REPLACE INTO offices (steamId, discord, role, token, status, ticketId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(() => {
    removeAll.run();
    Object.entries(offices).forEach(([steamId, office]) => insert.run(steamId, office.discord || "", office.role || "moderator", office.token || "", office.status || "pending", office.ticketId || null, office.createdAt || ""));
  });
}

function saveAdminLog(steamId, action, target, reason) {
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  db.prepare(`INSERT INTO admin_logs (id, steamId, action, target, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, steamId || "", action, target || "", reason || "", new Date().toISOString());
  return id;
}

function getAdminLogs() {
  return db.prepare("SELECT * FROM admin_logs ORDER BY createdAt DESC LIMIT 200").all();
}

/* Універсальна відправка в Discord: вебхук, а якщо його немає —
   бот-токен + канал (DISCORD_CHANNEL_ID або перший текстовий канал гільдії). */
let discordChannelCache = null;

async function resolveDiscordChannel() {
  if (process.env.DISCORD_CHANNEL_ID) return String(process.env.DISCORD_CHANNEL_ID).trim();
  if (discordChannelCache) return discordChannelCache;
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return null;
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/channels`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (!res.ok) return null;
    const channels = await res.json();
    const textChannels = channels.filter((channel) => channel.type === 0 || channel.type === 5);
    const preferred = textChannels.find((channel) =>
      /log|report|ticket|заяв|скарг|модер|admin/i.test(String(channel.name || ""))
    ) || textChannels[0];
    discordChannelCache = preferred ? preferred.id : null;
    return discordChannelCache;
  } catch (error) {
    return null;
  }
}

async function sendDiscordPayload(payload) {
  if (DISCORD_WEBHOOK_URL) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.warn("Discord webhook failed:", res.status);
      return false;
    }
    return true;
  }
  if (!DISCORD_BOT_TOKEN) return false;
  const channelId = await resolveDiscordChannel();
  if (!channelId) return false;
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    console.warn("Discord bot message failed:", res.status);
    return false;
  }
  return true;
}

async function sendDiscordReportNotification(report) {
  if (!DISCORD_WEBHOOK_URL && !DISCORD_BOT_TOKEN) return;
  try {
    const embed = {
      title: "🚨 Нова скарга на гравця",
      color: 0xff4444,
      fields: [
        { name: "Порушення", value: report.violationType || "—", inline: true },
        { name: "Ціль", value: report.target || "—", inline: true },
        { name: "Відправник", value: report.reporter || "—", inline: true },
        { name: "Опис", value: report.reason ? report.reason.slice(0, 1000) : "—" },
        { name: "Дата", value: new Date(report.createdAt).toLocaleString("uk-UA"), inline: true }
      ],
      footer: { text: "Unity Rust Anti-Cheat" }
    };
    if (report.video) embed.fields.push({ name: "Відео", value: report.video, inline: false });
    if (report.evidence) embed.fields.push({ name: "Додаткові докази", value: report.evidence.slice(0, 500), inline: false });

    await sendDiscordPayload({ embeds: [embed] });
  } catch (error) {
    console.warn("Discord report notification failed:", error);
  }
}

// ---- Discord: нова заявка в стаф ----
async function sendDiscordTicketNotification(ticket) {
  if (!DISCORD_WEBHOOK_URL && !DISCORD_BOT_TOKEN) return;
  try {
    const roleLabels = {
      owner: "Власник",
      admin: "Адмін",
      moderator: "Модератор",
      media: "Медіа",
      other: "Інше"
    };
    const embed = {
      title: "📝 Нова заявка в стаф",
      color: 0x00f0ff,
      fields: [
        { name: "Роль", value: roleLabels[ticket.role] || ticket.role || "—", inline: true },
        { name: "Steam ID", value: ticket.steamId || "—", inline: true },
        { name: "Discord", value: ticket.discord || "—", inline: true },
        { name: "Повідомлення", value: ticket.message ? ticket.message.slice(0, 1000) : "—" },
        { name: "ID заявки", value: ticket.id || "—", inline: true },
        { name: "Дата", value: new Date(ticket.createdAt).toLocaleString("uk-UA"), inline: true }
      ],
      footer: { text: "Unity Rust — заявки" }
    };
    await sendDiscordPayload({ embeds: [embed] });
  } catch (error) {
    console.warn("Discord ticket notification failed:", error?.message || error);
  }
}

// ---- Discord: щоденний звіт ----
async function sendDailyReport() {
  if (!DISCORD_WEBHOOK_URL && !DISCORD_BOT_TOKEN) return;
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    const counts = {
      tickets: count("tickets"),
      reports: count("reports"),
      bans: count("bans"),
      accounts: count("accounts")
    };
    let serverLine = "RCON вимкнено";
    if (RCON_ENABLED) {
      try {
        const stats = await getStats();
        serverLine = `${stats.online}/${stats.maxPlayers} онлайн · ${stats.map}`;
      } catch (error) {
        serverLine = "RCON недоступний";
      }
    }
    const top = getLeaderboard().players.slice(0, 5)
      .map((player, index) => `${index + 1}. ${player.name} — ${player.points} pts`)
      .join("\n") || "—";
    const embed = {
      title: "📊 Щоденний звіт UNITY RUST",
      color: 0x00f0ff,
      fields: [
        { name: "Сервер", value: serverLine },
        { name: "Сайт", value: `${counts.accounts} акаунтів · ${counts.tickets} заявок · ${counts.reports} скарг · ${counts.bans} банів` },
        { name: "Топ-5 гравців", value: top },
        { name: "Час", value: new Date().toLocaleString("uk-UA"), inline: true }
      ],
      footer: { text: DB_IN_MEMORY ? "Режим без БД: дані з моменту запуску" : "Unity Rust" }
    };
    await sendDiscordPayload({ embeds: [embed] });
  } catch (error) {
    console.warn("Discord daily report failed:", error?.message || error);
  }
}

function scheduleDailyReport() {
  if (!DISCORD_WEBHOOK_URL && !DISCORD_BOT_TOKEN) return;
  const hour = Math.min(23, Math.max(0, Number(process.env.DAILY_REPORT_HOUR ?? 18)));
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = Math.max(60 * 1000, next.getTime() - now.getTime());
  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000).unref();
  }, delay).unref();
  console.log(`daily report: ${next.toISOString()} (DAILY_REPORT_HOUR=${hour})`);
}

// ---- Discord role assignment (when ticket accepted) ----
async function assignDiscordRole(discordTag, role) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return;
  const roleId = DISCORD_ROLE_IDS[role];
  if (!roleId) return;
  const tag = String(discordTag || "").trim();
  if (!tag) return;

  try {
    // Search for member by username/tag
    const searchQuery = encodeURIComponent(tag.replace(/^@/, ""));
    const searchUrl = `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/search?query=${searchQuery}&limit=5`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (!searchRes.ok) {
      console.warn("Discord member search failed:", searchRes.status);
      return;
    }
    const members = await searchRes.json();
    if (!Array.isArray(members) || members.length === 0) {
      console.warn("Discord member not found for tag:", tag);
      return;
    }

    // Find best match
    const member = members.find((m) => {
      const username = m.user?.username || "";
      const discriminator = m.user?.discriminator || "0";
      const globalName = m.user?.global_name || "";
      const tagLower = tag.toLowerCase().replace(/^@/, "");
      return username.toLowerCase() === tagLower ||
        (discriminator !== "0" && `${username}#${discriminator}`.toLowerCase() === tagLower) ||
        globalName.toLowerCase() === tagLower;
    }) || members[0];

    const userId = member.user?.id;
    if (!userId) return;

    // Assign role
    const assignUrl = `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`;
    const assignRes = await fetch(assignUrl, {
      method: "PUT",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (assignRes.ok || assignRes.status === 204) {
      console.log(`Discord role "${role}" assigned to ${tag} (${userId})`);
    } else {
      console.warn("Discord role assignment failed:", assignRes.status, await assignRes.text());
    }
  } catch (error) {
    console.warn("Discord role assignment error:", error?.message || error);
  }
}

function getAccounts() {
  const accounts = {};
  for (const row of db.prepare("SELECT * FROM accounts").all()) {
    accounts[row.steamId] = {
      steamId: row.steamId,
      discord: row.discord || "",
      discordId: row.discordId || "",
      telegram: row.telegram || "",
      steamLinked: Boolean(row.steamLinked),
      createdAt: row.createdAt || "",
      updatedAt: row.updatedAt || ""
    };
  }
  return accounts;
}
function saveAccounts(accounts) {
  const removeAll = db.prepare("DELETE FROM accounts");
  const insert = db.prepare(`INSERT OR REPLACE INTO accounts (steamId, discord, discordId, telegram, steamLinked, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(() => {
    removeAll.run();
    Object.entries(accounts).forEach(([steamId, account]) => insert.run(steamId, account.discord || "", account.discordId || "", account.telegram || "", account.steamLinked ? 1 : 0, account.createdAt || "", account.updatedAt || ""));
  });
}

function getTasks() {
  return db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all().map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    role: row.role,
    completed: Boolean(row.completed),
    completedBy: row.completedBy,
    completedAt: row.completedAt,
    createdAt: row.createdAt
  }));
}
function saveTasks(tasks) {
  const removeAll = db.prepare("DELETE FROM tasks");
  const insert = db.prepare(`INSERT INTO tasks (id, title, description, role, completed, completedBy, completedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(() => {
    removeAll.run();
    tasks.forEach((task) => insert.run(task.id, task.title || "", task.description || "", task.role || "moderator", task.completed ? 1 : 0, task.completedBy || null, task.completedAt || null, task.createdAt || ""));
  });
}

function getPromos() {
  return db.prepare("SELECT * FROM promos ORDER BY createdAt DESC").all();
}
function savePromos(promos) {
  const removeAll = db.prepare("DELETE FROM promos");
  const insert = db.prepare(`INSERT INTO promos (id, code, ownerSteamId, ownerRole, activations, maxActivations, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  withTransaction(() => {
    removeAll.run();
    promos.forEach((promo) => insert.run(promo.id, promo.code || "", promo.ownerSteamId || "", promo.ownerRole || "", Number(promo.activations) || 0, Number(promo.maxActivations) || 50, promo.createdAt || ""));
  });
}

function isAdmin(req) {
  const header = String(req.headers["authorization"] || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : String(req.headers["x-admin-token"] || "");
  return adminTokens.has(token);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

/* Простий rate limit, щоб публічний сайт не можна було закидати
   тисячами POST-ів і роздути SQLite/диск. Для одного інстансу достатньо. */
const rateHits = new Map();
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || IS_PROD;

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, key, limit) {
  const now = Date.now();
  const id = key + "|" + clientIp(req);
  let bucket = rateHits.get(id);
  if (!bucket || now - bucket.start >= 60 * 1000) {
    bucket = { start: now, count: 0 };
    rateHits.set(id, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  rateHits.forEach((bucket, id) => {
    if (now - bucket.start >= 2 * 60 * 1000) rateHits.delete(id);
  });
}, 60 * 1000).unref();

function normalizeSteamId(value) {
  const steamId = String(value || "").trim();
  return /^7656\d{13}$/.test(steamId) ? steamId : "";
}
function normalizeDiscord(value) { return String(value || "").trim().slice(0, 120); }
function normalizeMessage(value) { return String(value || "").trim().slice(0, 1000); }

/* Посилання з форми скарги потрапляє в href. Пропускаємо лише
   https:// та власні завантаження, інакше javascript:/data: дають XSS. */
function normalizeMediaUrl(value) {
  const url = String(value || "").trim().slice(0, 500);
  if (!url) return "";
  if (/^\/(?:data\/)?uploads\/[a-z0-9-]+\.(?:mp4|webm|mov|png|jpg|gif)$/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch (error) {
    return "";
  }
}
function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "owner") return "owner";
  if (role === "admin") return "admin";
  if (role === "media") return "media";
  if (role === "other") return "other";
  return "moderator";
}
function permissionsForRole(value) {
  const role = normalizeRole(value);
  if (role === "media" || role === "other") return [];
  const base = ["players", "say", "kick"];
  if (role === "owner" || role === "admin") return [...base, "ban", "unban", "save", "bans"];
  return base;
}
function normalizeRconArg(value) {
  return String(value || "").replace(/["\r\n]/g, "'").trim().slice(0, 120);
}
function makeId() { return Date.now().toString(36) + crypto.randomBytes(3).toString("hex"); }
function makeToken() { return crypto.randomBytes(24).toString("hex"); }

function rconOnce(query) {
  if (!RCON_ENABLED) return Promise.reject(new Error("RCON disabled"));
  if (!WebSocket) return Promise.reject(new Error("ws module is not installed"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RCON_URL);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (error) {}
      reject(new Error("RCON timeout"));
    }, 6000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ Identifier: 1, Message: query, Name: RCON_NAME }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (error) { return; }
      if (Number(msg.Identifier) !== 1) return;
      clearTimeout(timer);
      const text = String(msg.Message ?? "");
      if (/^Calling '.*' on '.*' took /.test(text)) { try { ws.close(); } catch (error) {} return; }
      if (/^Unloaded plugin /.test(text)) { try { ws.close(); } catch (error) {} return; }
      if (/^Loaded plugin /.test(text)) { try { ws.close(); } catch (error) {} return; }
      ws.close();
      resolve(text);
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      try { ws.close(); } catch (error2) {}
      reject(error);
    });
  });
}

let rconQueue = Promise.resolve();
function rcon(query) {
  const run = () => rconOnce(query).catch((error) => {
    if (/ECONNRESET|ECONNREFUSED|socket hang up|timeout/i.test(String(error?.message || error))) {
      return new Promise((resolve) => setTimeout(resolve, 250)).then(() => rconOnce(query));
    }
    throw error;
  });
  const next = rconQueue.then(run, run);
  rconQueue = next.catch(() => {});
  return next;
}

function securityHeaders() {
  const headers = {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  };
  if (IS_PROD) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

/* Проста HTML-сторінка для popup'ів (Steam тощо). */
function sendInfoPage(res, status, title, text) {
  res.writeHead(status, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="uk">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#05080e;color:#eef6ff;font-family:system-ui,sans-serif">
  <div style="text-align:center;padding:24px;max-width:420px">
    <h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(title)}</h1>
    <p style="margin:0 0 18px;color:#8fa2bb;font-size:14px">${escapeHtml(text)}</p>
    <button onclick="window.close()" style="padding:10px 16px;border:0;border-radius:8px;background:#00f0ff;color:#05080e;font-weight:700;cursor:pointer">Закрити</button>
  </div>
</body>
</html>`);
}

/* A2S_INFO (Source Engine Query) — працює без RCON і без бібліотек. */
function a2sInfo(host, port, timeoutMs = 2500) {
  const dgram = require("node:dgram");
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const request = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
      Buffer.from("Source Engine Query\0", "ascii")
    ]);
    let done = false;
    const finish = (error, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (closeError) {}
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error("A2S timeout")), timeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("message", (message) => {
      if (message.length < 5) return;
      /* Challenge: сервер просить повторити запит із 4-байтовим кодом. */
      if (message[4] === 0x41 && message.length >= 9) {
        socket.send(Buffer.concat([request, message.slice(5, 9)]), port, host);
        return;
      }
      if (message[4] !== 0x49) return;
      let offset = 6;
      const readString = () => {
        const end = message.indexOf(0, offset);
        if (end < 0) return "";
        const value = message.toString("utf8", offset, end);
        offset = end + 1;
        return value;
      };
      const name = readString();
      const map = readString();
      const folder = readString();
      const game = readString();
      offset += 2;
      const players = message[offset++];
      const maxPlayers = message[offset++];
      const bots = message[offset++];
      finish(null, { name, map, folder, game, players, maxPlayers, bots });
    });
    socket.send(request, port, host, (error) => { if (error) finish(error); });
  });
}

let statsCache = { data: null, at: 0 };
const STATS_TTL_MS = 15000;

async function getStats() {
  if (statsCache.data && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.data;
  let result;
  if (RCON_ENABLED) {
    const text = await rcon("serverinfo");
    const data = JSON.parse(text);
    result = {
      online: data.Players ?? 0,
      maxPlayers: data.MaxPlayers ?? 20,
      map: data.Map ?? "Procedural Map",
      mode: "PvP",
      loot: 2,
      stacks: 2,
      uptimeSeconds: data.Uptime ?? 0,
      entityCount: data.EntityCount ?? 0,
      timestamp: Date.now()
    };
  } else if (SERVER_QUERY_HOST) {
    const info = await a2sInfo(SERVER_QUERY_HOST, SERVER_QUERY_PORT);
    result = {
      online: info.players,
      maxPlayers: info.maxPlayers,
      map: info.map || "Procedural Map",
      mode: "PvP",
      loot: 2,
      stacks: 2,
      uptimeSeconds: 0,
      entityCount: 0,
      timestamp: Date.now(),
      source: "a2s"
    };
  } else {
    throw new Error("No stats source configured");
  }
  statsCache = { data: result, at: Date.now() };
  return result;
}

function getLeaderboard() {
  try {
    const file = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
    const players = file.Players ?? {};
    const realPlayers = Object.entries(players)
      .filter(([steamId]) => steamId.length === 17 && steamId.startsWith("7656"))
      .map(([steamId, player]) => {
        const kills = player.Kills ?? 0;
        const deaths = player.Deaths ?? 0;
        const kd = kills + deaths > 0 ? kills / (kills + deaths) : kills > 0 ? 999 : 0;
        return {
          steamId,
          name: player.Name ?? "Unknown",
          kills,
          deaths,
          kd,
          points: player.Points ?? 0,
          hours: player.Hours ?? 0
        };
      })
      .sort((a, b) => b.points - a.points || b.kills - a.kills);

    return { players: realPlayers.slice(0, 20), total: realPlayers.length };
  } catch (error) {
    /* На Render файлу Rust-сервера немає — це не помилка, просто порожньо. */
    return { players: [], total: 0 };
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url ?? "/", "http://localhost");
  const pathname = parsed.pathname;
  const method = req.method || "GET";

  /* Render health check: не вимагає ні пароля, ні RCON. */
  if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  if (pathname.startsWith("/api/")) {
    const isWrite = method !== "GET" && method !== "HEAD";
    if (!rateLimit(req, isWrite ? "api-write" : "api-read", isWrite ? 60 : 300)) {
      sendJson(res, 429, { error: "Забагато запитів. Спробуй пізніше." });
      return;
    }
  }
  if (pathname === "/api/admin/login" && !rateLimit(req, "admin-login", 10)) {
    sendJson(res, 429, { error: "Забагато спроб входу. Спробуй пізніше." });
    return;
  }

  if (pathname === "/api/site-info" && method === "GET") {
    sendJson(res, 200, {
      publicMode: PUBLIC_MODE,
      rcon: RCON_ENABLED,
      steamLogin: !PUBLIC_MODE,
      store: !PUBLIC_MODE,
      tickets: !PUBLIC_MODE
    });
    return;
  }

  if (pathname === "/api/steam/login" && method === "GET") {
    if (PUBLIC_MODE) {
      sendInfoPage(res, 503, "Вхід через Steam вимкнено", "Публічна версія сайту поки що працює без входу через Steam. Спробуй пізніше.");
      return;
    }
    const baseUrl = baseUrlFor(req);
    const returnTo = `${baseUrl}/api/steam/callback`;
    const realm = `${baseUrl}/`;
    const steamUrl = new URL("https://steamcommunity.com/openid/login");
    steamUrl.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
    steamUrl.searchParams.set("openid.mode", "checkid_setup");
    steamUrl.searchParams.set("openid.return_to", returnTo);
    steamUrl.searchParams.set("openid.realm", realm);
    steamUrl.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
    steamUrl.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
    res.writeHead(302, { Location: steamUrl.toString() });
    res.end();
    return;
  }

  if (pathname === "/api/steam/callback" && method === "GET") {
    if (PUBLIC_MODE) {
      sendInfoPage(res, 503, "Вхід через Steam вимкнено", "Публічна версія сайту поки що працює без входу через Steam.");
      return;
    }
    try {
      if (parsed.searchParams.get("openid.mode") !== "id_res") {
        throw new Error("Steam не повернув дані авторизації.");
      }

      const verifyParams = new URLSearchParams(parsed.searchParams);
      verifyParams.set("openid.mode", "check_authentication");
      const verifyResponse = await fetch("https://steamcommunity.com/openid/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: verifyParams.toString()
      });
      const verifyText = await verifyResponse.text();
      if (!/is_valid\s*:\s*true/i.test(verifyText)) {
        throw new Error("Steam не підтвердив вхід.");
      }

      const claimedId = parsed.searchParams.get("openid.claimed_id") || "";
      const steamIdMatch = claimedId.match(/\/openid\/id\/(7656\d{13})$/);
      if (!steamIdMatch) throw new Error("Не вдалося отримати Steam ID.");
      const steamId = steamIdMatch[1];

      const accounts = getAccounts();
      const existing = accounts[steamId] || {};
      accounts[steamId] = {
        steamId,
        discord: existing.discord || "",
        telegram: existing.telegram || "",
        steamLinked: true,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      saveAccounts(accounts);

      const sessionToken = createSteamSession(steamId);
      const successHtml = `<!doctype html>
<html lang="uk">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Steam</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#05080e;color:#eef6ff;font-family:system-ui,sans-serif">
  <div style="text-align:center;padding:24px">
    <h1 style="font-size:20px;margin:0 0 8px">Steam прив'язано</h1>
    <p style="margin:0;color:#8fa2bb;font-size:14px">Можна закрити це вікно.</p>
  </div>
  <script>
    (function () {
      var data = { type: "nexus-steam", steamId: "${steamId}" };
      try {
        if (window.opener) window.opener.postMessage(data, window.location.origin);
      } catch (error) {}
      if (!window.opener) {
        setTimeout(function () { window.location.href = "/#/cabinet"; }, 600);
      } else {
        setTimeout(function () { window.close(); }, 900);
      }
    })();
  </script>
</body>
</html>`;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": sessionCookie(sessionToken, Math.floor(SESSION_TTL_MS / 1000))
      });
      res.end(successHtml);
    } catch (error) {
      const errorHtml = `<!doctype html>
<html lang="uk">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Steam</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#05080e;color:#eef6ff;font-family:system-ui,sans-serif">
  <div style="text-align:center;padding:24px;max-width:420px">
    <h1 style="font-size:20px;margin:0 0 8px">Не вдалося прив'язати Steam</h1>
    <p style="margin:0 0 18px;color:#8fa2bb;font-size:14px">${escapeHtml(error?.message || error)}</p>
    <button onclick="window.close()" style="padding:10px 16px;border:0;border-radius:8px;background:#00f0ff;color:#05080e;font-weight:700;cursor:pointer">Закрити</button>
  </div>
</body>
</html>`;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorHtml);
    }
    return;
  }

  if (pathname === "/api/steam/session" && method === "GET") {
    const session = getSteamSession(req);
    sendJson(res, 200, { steamId: session ? session.steamId : null });
    return;
  }

  if (pathname === "/api/steam/logout" && method === "POST") {
    const cookie = String(req.headers.cookie || "");
    const match = cookie.match(/(?:^|;\s*)nexus_session=([^;]+)/);
    if (match) deleteSteamSession(match[1]);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": sessionCookie("", 0)
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/admin/steam-login" && method === "POST") {
    try {
      const session = getSteamSession(req);
      if (!session) { sendJson(res, 401, { error: "Steam session not found" }); return; }
      if (session.steamId !== OWNER_STEAM_ID) { sendJson(res, 403, { error: "Owner only" }); return; }
      const token = crypto.randomBytes(24).toString("hex");
      adminTokens.add(token);
      sendJson(res, 200, { token, steamId: session.steamId });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/admin/login" && method === "POST") {
    try {
      if (!ADMIN_PASSWORD) {
        sendJson(res, 503, { error: "Admin login is not configured" });
        return;
      }
      const body = await readBody(req);
      if (!safeEqual(body.password || "", ADMIN_PASSWORD)) {
        sendJson(res, 401, { error: "Невірний пароль адміністратора" });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      adminTokens.add(token);
      sendJson(res, 200, { token });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  // ---- Avatar proxy (віддаємо байти, а не редірект: CSP img-src 'self') ----
  if (pathname === "/api/avatar" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    try {
      const profileRes = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
      const profileXml = await profileRes.text();
      const avatarMatch = profileXml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/);
      if (!avatarMatch || !avatarMatch[1]) { sendJson(res, 404, { error: "Avatar not found" }); return; }

      const imageRes = await fetch(avatarMatch[1]);
      if (!imageRes.ok) { sendJson(res, 502, { error: "Steam avatar unavailable" }); return; }
      const buffer = Buffer.from(await imageRes.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 3 * 1024 * 1024) {
        sendJson(res, 502, { error: "Steam avatar unavailable" });
        return;
      }
      res.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": imageRes.headers.get("content-type") || "image/jpeg",
        "Content-Length": buffer.length,
        "Cache-Control": "public, max-age=3600"
      });
      res.end(buffer);
    } catch (error) {
      sendJson(res, 500, { error: "Failed to fetch avatar" });
    }
    return;
  }

  if (pathname === "/api/stats") {
    try {
      const stats = await getStats();
      sendJson(res, 200, stats);
    } catch (error) {
      sendJson(res, 503, { error: "RCON unavailable", message: String(error?.message ?? error) });
    }
    return;
  }

  if (pathname === "/api/leaderboard") {
    try {
      const leaderboard = getLeaderboard();
      sendJson(res, 200, leaderboard);
    } catch (error) {
      sendJson(res, 503, { error: "Leaderboard unavailable", message: String(error?.message ?? error) });
    }
    return;
  }

  if (pathname === "/api/tickets" && method === "POST") {
    if (PUBLIC_MODE) {
      sendJson(res, 503, { error: "Заявки тимчасово недоступні. Наразі працюють лише скарги." });
      return;
    }
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      const discord = normalizeDiscord(body.discord);
      const message = normalizeMessage(body.message);
      if (!steamId) { sendJson(res, 400, { error: "Вкажи коректний Steam ID (17 цифр, починається з 7656)." }); return; }
      if (!discord) { sendJson(res, 400, { error: "Вкажи Discord." }); return; }
      if (!message) { sendJson(res, 400, { error: "Опиши проблему." }); return; }

      const tickets = getTickets();
      const existing = tickets.find((ticket) => ticket.steamId === steamId && ticket.status === "pending");
      if (existing) {
        sendJson(res, 200, { ticket: existing, duplicate: true });
        return;
      }

      // Block ticket submission if user already has an active office with the SAME role
      const offices = getOffices();
      const office = offices[steamId];
      if (office && office.status === "active" && normalizeRole(body.role) === normalizeRole(office.role)) {
        sendJson(res, 400, { error: "У тебе вже є активний кабінет для цієї ролі. Нова заявка не потрібна." });
        return;
      }

      const ticket = {
        id: makeId(),
        token: makeToken(),
        steamId,
        discord,
        message,
        role: normalizeRole(body.role),
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      tickets.unshift(ticket);
      saveTickets(tickets);
      /* Дублюємо заявку в Discord, щоб вона не загубилась у режимі без БД. */
      sendDiscordTicketNotification(ticket);
      sendJson(res, 201, { ticket });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/reports/upload" && method === "POST") {
    const session = getSteamSession(req);
    if (!session) { sendJson(res, 401, { error: "Увійди через Steam, щоб прикріпити докази." }); return; }
    if (!rateLimit(req, "report-upload", 3)) {
      sendJson(res, 429, { error: "Забагато завантажень. Спробуй пізніше." });
      return;
    }
    const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const allowedTypes = {
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "video/quicktime": ".mov",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif"
    };
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    let ext = allowedTypes[contentType];
    if (!ext) {
      const rawName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
      const nameExt = path.extname(rawName).toLowerCase();
      if ([".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".gif"].includes(nameExt)) {
        ext = nameExt === ".jpeg" ? ".jpg" : nameExt;
      }
    }
    if (!ext) { sendJson(res, 400, { error: "Дозволені формати: MP4, WebM, MOV, PNG, JPG, GIF." }); return; }

    const maxBytes = 60 * 1024 * 1024;
    const fileName = `report-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    const stream = fs.createWriteStream(filePath);
    let size = 0;
    let failed = false;

    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        stream.destroy();
        try { fs.unlinkSync(filePath); } catch (error) {}
        sendJson(res, 413, { error: "Файл завеликий. Максимум 60 МБ." });
        req.destroy();
        return;
      }
      stream.write(chunk);
    });
    req.on("end", () => {
      if (!failed) stream.end();
    });
    stream.on("finish", () => {
      if (!failed) sendJson(res, 201, { url: `/uploads/${fileName}`, size });
    });
    stream.on("error", () => {
      if (!failed) { failed = true; sendJson(res, 500, { error: "Не вдалося зберегти файл." }); }
    });
    return;
  }

  if (pathname === "/api/reports" && method === "POST") {
    try {
      const body = await readBody(req);
      const target = String(body.target || "").trim().slice(0, 120);
      const reason = String(body.reason || "").trim().slice(0, 2000);
      const evidence = String(body.evidence || "").trim().slice(0, 500);
      const video = String(body.video || "").trim().slice(0, 500);
      const reporter = normalizeSteamId(body.steamId) || "guest";
      if (!target) { sendJson(res, 400, { error: "Вкажи нік або Steam ID порушника." }); return; }
      if (!reason) { sendJson(res, 400, { error: "Опиши, що сталося." }); return; }
      const report = {
        id: makeId(),
        reporter,
        target,
        reason,
        evidence,
        video,
        status: "open",
        createdAt: new Date().toISOString()
      };
      db.prepare(`INSERT INTO reports (id, reporter, target, reason, evidence, video, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(report.id, report.reporter, report.target, report.reason, report.evidence, report.video, report.status, report.createdAt);
      await sendDiscordReportNotification(report);
      sendJson(res, 201, { report });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/reports" && method === "GET") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const reports = db.prepare("SELECT * FROM reports ORDER BY createdAt DESC").all();
    sendJson(res, 200, { reports });
    return;
  }

  const reportAction = pathname.match(/^\/api\/reports\/([^/]+)\/(resolve|reject)$/);
  if (reportAction && method === "POST") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportAction[1]);
    if (!report) { sendJson(res, 404, { error: "Report not found" }); return; }
    const status = reportAction[2] === "resolve" ? "resolved" : "rejected";
    db.prepare("UPDATE reports SET status = ? WHERE id = ?").run(status, report.id);
    sendJson(res, 200, { ok: true, status });
    return;
  }

  if (pathname === "/api/purchases" && method === "POST") {
    if (PUBLIC_MODE) {
      sendJson(res, 503, { error: "Магазин у розробці." });
      return;
    }
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      if (!steamId) { sendJson(res, 400, { error: "Спочатку прив'яжи Steam-акаунт." }); return; }
      const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
      if (items.length === 0) { sendJson(res, 400, { error: "Кошик порожній." }); return; }
      const insert = db.prepare(`INSERT INTO purchases (id, steamId, productId, productName, price, qty, total, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const now = new Date().toISOString();
      const saved = [];
      withTransaction(() => {
        for (const item of items) {
          const purchase = {
            id: makeId(),
            steamId,
            productId: String(item.id || "").slice(0, 60),
            productName: String(item.name || "Товар").slice(0, 120),
            price: Number(item.price) || 0,
            qty: Math.max(1, Number(item.qty) || 1),
            status: "paid",
            createdAt: now
          };
          purchase.total = purchase.price * purchase.qty;
          insert.run(purchase.id, purchase.steamId, purchase.productId, purchase.productName, purchase.price, purchase.qty, purchase.total, purchase.status, purchase.createdAt);
          saved.push(purchase);
        }
      });
      sendJson(res, 201, { purchases: saved });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/purchases" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const purchases = db.prepare("SELECT * FROM purchases WHERE steamId = ? ORDER BY createdAt DESC").all(steamId);
    sendJson(res, 200, { purchases });
    return;
  }

  if (pathname === "/api/overview" && method === "GET") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const purchases = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS sum FROM purchases").get();
    const overview = {
      purchases: { count: purchases.count, total: purchases.sum },
      tickets: {
        total: db.prepare("SELECT COUNT(*) AS count FROM tickets").get().count,
        pending: db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status = 'pending'").get().count
      },
      reports: {
        total: db.prepare("SELECT COUNT(*) AS count FROM reports").get().count,
        open: db.prepare("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'").get().count
      },
      bans: db.prepare("SELECT COUNT(*) AS count FROM bans").get().count,
      accounts: db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count,
      offices: db.prepare("SELECT COUNT(*) AS count FROM offices").get().count
    };
    sendJson(res, 200, overview);
    return;
  }

  if (pathname === "/api/admin/logs" && method === "GET") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const logs = getAdminLogs();
    sendJson(res, 200, { logs });
    return;
  }

  if (pathname === "/api/promos" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const promos = db.prepare("SELECT * FROM promos WHERE ownerSteamId = ? ORDER BY createdAt DESC").all(steamId);
    sendJson(res, 200, { promos });
    return;
  }

  if (pathname === "/api/promos" && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      /* SteamID власника беремо ТІЛЬКИ із серверної сесії. Раніше тут
         порівнювався body.steamId, тож будь-хто, знаючи публічний SteamID
         власника, міг створювати промокоди без входу. */
      const session = getSteamSession(req);
      const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
      if (!isAdmin(req) && !isOwner) { sendJson(res, 403, { error: "Admin only" }); return; }
      const ownerSteamId = isOwner ? session.steamId : steamId;
      const code = String(body.code || "").trim().toUpperCase().slice(0, 20);
      const maxActivations = Math.max(1, Number(body.maxActivations) || 50);
      const description = String(body.description || "").trim().slice(0, 200);
      if (!code) { sendJson(res, 400, { error: "Вкажи код промокоду." }); return; }
      const existing = db.prepare("SELECT * FROM promos WHERE code = ?").get(code);
      if (existing) { sendJson(res, 400, { error: "Промокод вже існує." }); return; }
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
      const ownerRole = isOwner ? "owner" : "admin";
      db.prepare(`INSERT INTO promos (id, code, ownerSteamId, ownerRole, activations, maxActivations, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, code, ownerSteamId || "", ownerRole, 0, maxActivations, description, new Date().toISOString());
      sendJson(res, 201, { promo: { id, code, maxActivations, description, activations: 0 } });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/promos/activate" && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      const code = String(body.code || "").trim().toUpperCase();
      if (!steamId) { sendJson(res, 400, { error: "Спочатку прив'яжи Steam." }); return; }
      if (!code) { sendJson(res, 400, { error: "Вкажи код промокоду." }); return; }
      const promo = db.prepare("SELECT * FROM promos WHERE code = ?").get(code);
      if (!promo) { sendJson(res, 400, { error: "Промокод не знайдено." }); return; }
      if (promo.activations >= promo.maxActivations) { sendJson(res, 400, { error: "Промокод вичерпано." }); return; }
      const already = db.prepare("SELECT * FROM promo_activations WHERE promoId = ? AND steamId = ?").get(promo.id, steamId);
      if (already) { sendJson(res, 400, { error: "Ти вже активував цей промокод." }); return; }
      const actId = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
      db.prepare(`INSERT INTO promo_activations (id, promoId, steamId, activatedAt) VALUES (?, ?, ?, ?)`)
        .run(actId, promo.id, steamId, new Date().toISOString());
      db.prepare("UPDATE promos SET activations = activations + 1 WHERE id = ?").run(promo.id);
      sendJson(res, 200, { ok: true, promo: { code: promo.code, activations: promo.activations + 1, maxActivations: promo.maxActivations } });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/promo-activations" && method === "GET") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const activations = db.prepare("SELECT * FROM promo_activations ORDER BY activatedAt DESC LIMIT 200").all();
    sendJson(res, 200, { activations });
    return;
  }

  if (pathname === "/api/tickets" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    const token = String(parsed.searchParams.get("token") || "");
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const tickets = getTickets().filter((ticket) => ticket.steamId === steamId);
    if (!isAdmin(req) && !tickets.some((ticket) => token && ticket.token === token)) {
      sendJson(res, 200, { tickets: [] });
      return;
    }
    sendJson(res, 200, { tickets });
    return;
  }

  if (pathname === "/api/tickets/all" && method === "GET") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    sendJson(res, 200, { tickets: getTickets() });
    return;
  }

  const ticketAction = pathname.match(/^\/api\/tickets\/([^/]+)\/(accept|reject)$/);
  if (ticketAction && method === "POST") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const ticketId = ticketAction[1];
    const action = ticketAction[2];
    const tickets = getTickets();
    const ticket = tickets.find((item) => item.id === ticketId);
    if (!ticket) { sendJson(res, 404, { error: "Ticket not found" }); return; }

    ticket.status = action === "accept" ? "accepted" : "rejected";
    ticket.updatedAt = new Date().toISOString();
    saveTickets(tickets);

    if (action === "accept") {
      const offices = getOffices();
      offices[ticket.steamId] = {
        steamId: ticket.steamId,
        discord: ticket.discord,
        role: normalizeRole(ticket.role),
        token: ticket.token,
        status: "active",
        ticketId: ticket.id,
        createdAt: new Date().toISOString()
      };
      saveOffices(offices);
      // Assign Discord role automatically
      assignDiscordRole(ticket.discord, normalizeRole(ticket.role)).catch((error) => {
        console.warn("Discord role assignment failed:", error?.message || error);
      });
    }

    sendJson(res, 200, { ticket });
    return;
  }

  if (pathname === "/api/office" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    const token = String(parsed.searchParams.get("token") || "");
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const admin = isAdmin(req);
    const session = getSteamSession(req);
    const sessionMatches = Boolean(session && session.steamId === steamId);
    const offices = getOffices();
    const office = offices[steamId];
    const tickets = getTickets().filter((ticket) => ticket.steamId === steamId);
    const hasPending = tickets.some((ticket) => ticket.status === "pending");
    const tokenMatches = Boolean(token) && tickets.some((ticket) => ticket.token === token) ||
      Boolean(token) && Boolean(office && office.token === token);

    /* Власник отримує кабінет автоматично, але лише зі своєї сесії.
       Інакше достатньо було передати ?steamId=<публічний ID власника>. */
    if (steamId === OWNER_STEAM_ID && sessionMatches) {
      if (!office || office.status !== "active") {
        offices[steamId] = {
          steamId,
          discord: (office && office.discord) || "",
          role: "owner",
          token: (office && office.token) || makeToken(),
          status: "active",
          ticketId: (office && office.ticketId) || null,
          createdAt: (office && office.createdAt) || new Date().toISOString()
        };
        saveOffices(offices);
      }
      const ownerOffice = offices[steamId];
      sendJson(res, 200, {
        status: "active",
        office: {
          steamId: ownerOffice.steamId,
          discord: ownerOffice.discord,
          role: "owner",
          permissions: permissionsForRole("owner"),
          status: "active",
          ticketId: ownerOffice.ticketId,
          createdAt: ownerOffice.createdAt
        }
      });
      return;
    }

    if (office && office.status === "active" && (admin || tokenMatches || sessionMatches)) {
      sendJson(res, 200, {
        status: "active",
        office: {
          steamId: office.steamId,
          discord: office.discord,
          role: normalizeRole(office.role),
          permissions: permissionsForRole(office.role),
          status: office.status,
          ticketId: office.ticketId,
          createdAt: office.createdAt
        }
      });
      return;
    }

    if (admin) {
      sendJson(res, 200, {
        status: office && office.status === "active" ? "active" : hasPending ? "processing" : "locked",
        office: office || null,
        tickets
      });
      return;
    }

    sendJson(res, 200, { status: (tokenMatches || sessionMatches) && hasPending ? "processing" : "locked", office: null });
    return;
  }

  if (pathname === "/api/office/action" && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      const token = String(body.token || "");
      const action = String(body.action || "").trim().toLowerCase();
      if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }

      const office = getOffices()[steamId];
      const session = getSteamSession(req);
      const sessionMatches = Boolean(session && session.steamId === steamId);
      const tokenMatches = Boolean(office && token && office.token === token);
      const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
      if (!office || office.status !== "active" || (!tokenMatches && !sessionMatches && !isOwner)) {
        sendJson(res, 403, { error: "Кабінет неактивний або немає доступу." });
        return;
      }

      const role = normalizeRole(office.role);
      const permissions = permissionsForRole(role);
      if (!permissions.includes(action)) {
        sendJson(res, 403, { error: `Роль ${role} не має доступу до дії ${action}.` });
        return;
      }

      let result = "";
      if (action === "players") {
        result = await rcon("playerlist");
      } else if (action === "say") {
        const message = normalizeRconArg(body.message);
        if (!message) { sendJson(res, 400, { error: "Повідомлення порожнє." }); return; }
        result = await rcon(`say "${message}"`);
        saveAdminLog(steamId, "say", "", message);
      } else if (action === "kick") {
        const target = normalizeRconArg(body.target);
        const reason = normalizeRconArg(body.reason) || "Порушення правил";
        if (!target) { sendJson(res, 400, { error: "Вкажи гравця." }); return; }
        result = await rcon(`kick "${target}" "${reason}"`);
        saveAdminLog(steamId, "kick", target, reason);
      } else if (action === "ban") {
        const target = normalizeRconArg(body.target);
        const reason = normalizeRconArg(body.reason) || "Порушення правил";
        if (!target) { sendJson(res, 400, { error: "Вкажи гравця." }); return; }
        result = normalizeSteamId(target)
          ? await rcon(`banid ${target} "${reason}"`)
          : await rcon(`ban "${target}" "${reason}"`);
        const bans = getBans();
        bans.unshift({
          id: makeId(),
          target,
          reason,
          admin: `UNITY ${role.toUpperCase()}`,
          createdAt: new Date().toISOString()
        });
        saveBans(bans);
        saveAdminLog(steamId, "ban", target, reason);
      } else if (action === "unban") {
        const target = normalizeRconArg(body.target);
        if (!target) { sendJson(res, 400, { error: "Вкажи гравця." }); return; }
        result = await rcon(`unban "${target}"`);
        saveAdminLog(steamId, "unban", target, "");
      } else if (action === "save") {
        result = await rcon("server.save");
        saveAdminLog(steamId, "save", "", "");
      } else if (action === "bans") {
        sendJson(res, 200, { ok: true, bans: getBans() });
        return;
      }

      sendJson(res, 200, { ok: true, role, action, result });
    } catch (error) {
      sendJson(res, 503, { error: `RCON: ${String(error?.message || error)}` });
    }
    return;
  }

  if (pathname === "/api/bans" && method === "GET") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    sendJson(res, 200, { bans: getBans() });
    return;
  }

  if (pathname === "/api/bans" && method === "POST") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    try {
      const body = await readBody(req);
      const target = String(body.target || "").trim();
      const reason = String(body.reason || "").trim();
      if (!target || !reason) { sendJson(res, 400, { error: "target and reason required" }); return; }
      if (normalizeSteamId(target) === OWNER_STEAM_ID) {
        sendJson(res, 403, { error: "Не можна забанувати власника сервера." });
        return;
      }

      const ban = {
        id: makeId(),
        target,
        reason,
        admin: "UNITY ADMIN",
        createdAt: new Date().toISOString()
      };
      const bans = getBans();
      bans.unshift(ban);
      saveBans(bans);

      let rconResult = null;
      try {
        const safeReason = reason.replace(/"/g, "'");
        if (normalizeSteamId(target)) {
          rconResult = await rcon(`banid ${target} "${safeReason}"`);
        } else {
          rconResult = await rcon(`ban "${target.replace(/"/g, "'")}" "${safeReason}"`);
        }
      } catch (error) {
        rconResult = `RCON: ${String(error?.message || error)}`;
      }

      sendJson(res, 201, { ban, rcon: rconResult });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  const banDelete = pathname.match(/^\/api\/bans\/([^/]+)$/);
  if (banDelete && method === "DELETE") {
    if (!isAdmin(req)) { sendJson(res, 403, { error: "Admin only" }); return; }
    const bans = getBans();
    const index = bans.findIndex((ban) => ban.id === banDelete[1]);
    if (index < 0) { sendJson(res, 404, { error: "Ban not found" }); return; }
    const removed = bans.splice(index, 1)[0];
    saveBans(bans);
    sendJson(res, 200, { removed });
    return;
  }

  if (pathname === "/api/accounts/link" && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      if (!steamId) { sendJson(res, 400, { error: "Вкажи коректний Steam ID (17 цифр, починається з 7656)." }); return; }
      const accounts = getAccounts();
      const existing = accounts[steamId] || {};
      let discord = normalizeDiscord(body.discord) || existing.discord || "";
      let discordId = existing.discordId || "";

      // Verify Discord membership if discord tag is provided
      if (discord && DISCORD_BOT_TOKEN && DISCORD_GUILD_ID) {
        try {
          const searchQuery = encodeURIComponent(discord.replace(/^@/, ""));
          const searchUrl = `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/search?query=${searchQuery}&limit=5`;
          const searchRes = await fetch(searchUrl, {
            headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
          });
          if (searchRes.ok) {
            const members = await searchRes.json();
            if (Array.isArray(members) && members.length > 0) {
              const member = members.find((m) => {
                const username = m.user?.username || "";
                const discriminator = m.user?.discriminator || "0";
                const globalName = m.user?.global_name || "";
                const tagLower = discord.toLowerCase().replace(/^@/, "");
                return username.toLowerCase() === tagLower ||
                  (discriminator !== "0" && `${username}#${discriminator}`.toLowerCase() === tagLower) ||
                  globalName.toLowerCase() === tagLower;
              }) || members[0];
              if (member?.user?.id) {
                discordId = member.user.id;
              }
            } else {
              sendJson(res, 400, { error: "Користувач не знайдений на Discord сервері. Перевір тег." });
              return;
            }
          }
        } catch (error) {
          console.warn("Discord membership check failed:", error?.message || error);
        }
      }

      const account = {
        steamId,
        discord,
        discordId,
        telegram: String(body.telegram || existing.telegram || "").trim().slice(0, 80),
        steamLinked: true,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      accounts[steamId] = account;
      saveAccounts(accounts);
      sendJson(res, 200, { account });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (pathname === "/api/accounts" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const account = getAccounts()[steamId] || null;
    sendJson(res, 200, {
      account: account ? { steamId: account.steamId, steamLinked: Boolean(account.steamLinked) } : null
    });
    return;
  }

  // ---- Tasks (admin assigns, admins/mods mark complete) ----
  if (pathname === "/api/tasks" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    const token = String(parsed.searchParams.get("token") || "");
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const offices = getOffices();
    const office = offices[steamId];
    const session = getSteamSession(req);
    const sessionMatches = Boolean(session && session.steamId === steamId);
    const tokenMatches = Boolean(token) && Boolean(office && office.token === token);
    const isAdminUser = isAdmin(req);
    const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
    if (!office || office.status !== "active" || (!isAdminUser && !tokenMatches && !sessionMatches && !isOwner)) {
      sendJson(res, 403, { error: "Кабінет неактивний або немає доступу." });
      return;
    }
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    // Clean up tasks completed more than 3 days ago
    let tasks = getTasks();
    tasks = tasks.filter((task) => {
      if (task.completed && task.completedAt) {
        const completedTime = new Date(task.completedAt).getTime();
        return (now - completedTime) < threeDaysMs;
      }
      return true;
    });
    saveTasks(tasks);
    // Return non-completed + recently completed (within 3 days)
    sendJson(res, 200, { tasks });
    return;
  }

  if (pathname === "/api/tasks" && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      const token = String(body.token || "");
      const session = getSteamSession(req);
      const sessionMatches = Boolean(session && session.steamId === steamId);
      const offices = getOffices();
      const office = steamId ? offices[steamId] : null;
      const tokenMatches = Boolean(token) && Boolean(office && office.token === token);
      const isAdminUser = isAdmin(req);
      const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
      const officeActive = Boolean(office && office.status === "active");
      const officeRole = officeActive ? normalizeRole(office.role) : "";
      const canCreate = isAdminUser || isOwner || (officeActive && (officeRole === "admin" || officeRole === "owner") && (tokenMatches || sessionMatches));
      if (!canCreate) { sendJson(res, 403, { error: "Admin only" }); return; }
      const title = String(body.title || "").trim().slice(0, 200);
      const description = String(body.description || "").trim().slice(0, 1000);
      const role = normalizeRole(body.role || "moderator");
      if (!title) { sendJson(res, 400, { error: "Назва завдання обов'язкова." }); return; }
      const task = {
        id: makeId(),
        title,
        description,
        role,
        completed: false,
        completedBy: null,
        completedAt: null,
        createdAt: new Date().toISOString()
      };
      const tasks = getTasks();
      tasks.unshift(task);
      saveTasks(tasks);
      sendJson(res, 201, { task });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  const taskComplete = pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);
  if (taskComplete && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      const token = String(body.token || "");
      if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
      const offices = getOffices();
      const office = offices[steamId];
      const session = getSteamSession(req);
      const sessionMatches = Boolean(session && session.steamId === steamId);
      const tokenMatches = Boolean(token) && Boolean(office && office.token === token);
      const isAdminUser = isAdmin(req);
      const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
      if (!office || office.status !== "active" || (!isAdminUser && !tokenMatches && !sessionMatches && !isOwner)) {
        sendJson(res, 403, { error: "Кабінет неактивний або немає доступу." }); return;
      }
      const taskId = taskComplete[1];
      const tasks = getTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) { sendJson(res, 404, { error: "Task not found" }); return; }
      task.completed = true;
      task.completedBy = steamId;
      task.completedAt = new Date().toISOString();
      saveTasks(tasks);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  // ---- Players list (admins/mods see all players) ----
  if (pathname === "/api/players" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    const token = String(parsed.searchParams.get("token") || "");
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const offices = getOffices();
    const office = offices[steamId];
    const session = getSteamSession(req);
    const sessionMatches = Boolean(session && session.steamId === steamId);
    const tokenMatches = Boolean(token) && Boolean(office && office.token === token);
    const isAdminUser = isAdmin(req);
    const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
    if (!office || office.status !== "active" || (!isAdminUser && !tokenMatches && !sessionMatches && !isOwner)) {
      sendJson(res, 403, { error: "Кабінет неактивний або немає доступу." }); return;
    }
    const role = normalizeRole(office.role);
    if (role !== "admin" && role !== "moderator") {
      sendJson(res, 403, { error: "Тільки адміни та модератори мають доступ." }); return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
      const npcNames = new Set(["scientist", "tunnel dweller", "bear", "wolf", "boar", "stag", "deer", "horse", "chicken", "snake", "shark", "cat", "dog", "rat", "bat", "pig", "cow", "sheep", "rabbit", "fox", "tiger", "lion", "leopard", "panther", "crocodile", "alligator", "eagle", "hawk", "owl", "penguin", "seagull", "gull"]);
      const players = Object.entries(data.Players || {})
        .filter(([id, p]) => {
          const name = String(p.Name || "").trim().toLowerCase();
          // Skip bots/animals: known NPC names or names that are purely numeric IDs
          if (npcNames.has(name)) return false;
          // Skip entries that look like internal bot IDs (pure numbers without a real name)
          if (!name || name === "unknown") return false;
          // Skip entries whose name is purely numeric (bots/test accounts)
          if (/^\d+$/.test(name)) return false;
          return true;
        })
        .map(([id, p]) => ({
          id,
          name: p.Name || "Unknown",
          kills: p.Kills || 0,
          deaths: p.Deaths || 0,
          points: p.Points || 0,
          hours: p.Hours || 0
        })).sort((a, b) => (b.points - a.points) || (b.kills - a.kills));
      sendJson(res, 200, { players });
    } catch (error) {
      sendJson(res, 500, { error: "Не вдалося прочитати список гравців." });
    }
    return;
  }

  // ---- Promos (create/list by media/admin) ----
  if (pathname === "/api/promos" && method === "GET") {
    const steamId = normalizeSteamId(parsed.searchParams.get("steamId"));
    const token = String(parsed.searchParams.get("token") || "");
    if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
    const offices = getOffices();
    const office = offices[steamId];
    const session = getSteamSession(req);
    const sessionMatches = Boolean(session && session.steamId === steamId);
    const tokenMatches = Boolean(token) && Boolean(office && office.token === token);
    const isAdminUser = isAdmin(req);
    const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
    if (!office || office.status !== "active" || (!isAdminUser && !tokenMatches && !sessionMatches && !isOwner)) {
      sendJson(res, 403, { error: "Кабінет неактивний або немає доступу." }); return;
    }
    const role = normalizeRole(office.role);
    if (role !== "admin" && role !== "media") {
      sendJson(res, 403, { error: "Тільки адміни та медіа мають доступ." }); return;
    }
    const promos = getPromos().filter((p) => p.ownerSteamId === steamId);
    sendJson(res, 200, { promos });
    return;
  }

  if (pathname === "/api/promos" && method === "POST") {
    try {
      const body = await readBody(req);
      const steamId = normalizeSteamId(body.steamId);
      const token = String(body.token || "");
      if (!steamId) { sendJson(res, 400, { error: "steamId required" }); return; }
      const offices = getOffices();
      const office = offices[steamId];
      const session = getSteamSession(req);
      const sessionMatches = Boolean(session && session.steamId === steamId);
      const tokenMatches = Boolean(token) && Boolean(office && office.token === token);
      const isAdminUser = isAdmin(req);
      const isOwner = Boolean(session && session.steamId === OWNER_STEAM_ID);
      if (!office || office.status !== "active" || (!isAdminUser && !tokenMatches && !sessionMatches && !isOwner)) {
        sendJson(res, 403, { error: "Кабінет неактивний або немає доступу." }); return;
      }
      const role = normalizeRole(office.role);
      if (role !== "admin" && role !== "media") {
        sendJson(res, 403, { error: "Тільки адміни та медіа можуть створювати промокоди." }); return;
      }
      const code = String(body.code || "").trim().toUpperCase().slice(0, 20);
      if (!code) { sendJson(res, 400, { error: "Вкажи код промокоду." }); return; }
      const promos = getPromos();
      if (promos.some((p) => p.code === code)) {
        sendJson(res, 400, { error: "Промокод з такою назвою вже існує." }); return;
      }
      const promo = {
        id: makeId(),
        code,
        ownerSteamId: steamId,
        ownerRole: role,
        activations: 0,
        maxActivations: Number(body.maxActivations) || 50,
        createdAt: new Date().toISOString()
      };
      promos.unshift(promo);
      savePromos(promos);
      sendJson(res, 201, { promo });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  // ---- Uploaded evidence (скарги) ----
  const uploadMatch = pathname.match(/^\/uploads\/([a-z0-9-]+\.(?:mp4|webm|mov|png|jpg|gif))$/i);
  if (uploadMatch && (method === "GET" || method === "HEAD")) {
    const UPLOAD_MIME = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".gif": "image/gif"
    };
    const uploadPath = path.join(DATA_DIR, "uploads", uploadMatch[1]);
    const uploadExt = path.extname(uploadPath).toLowerCase();
    try {
      const stat = fs.statSync(uploadPath);
      if (stat.isFile()) {
        res.writeHead(200, {
          ...securityHeaders(),
          "Content-Type": UPLOAD_MIME[uploadExt] || "application/octet-stream",
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=3600"
        });
        if (method === "HEAD") res.end();
        else fs.createReadStream(uploadPath).pipe(res);
        return;
      }
    } catch (error) {
      // немає файлу -> 404 нижче
    }
    res.writeHead(404, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    res.end(method === "HEAD" ? undefined : "Not found");
    return;
  }

  // ---- Static files (images, css, js, fonts, etc.) ----
  if (method === "GET" || method === "HEAD") {
    const MIME_TYPES = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".mp4": "video/mp4",
      ".webm": "video/webm"
    };

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch (error) {
      decodedPath = pathname;
    }
    if (decodedPath.indexOf("\0") !== -1) {
      res.writeHead(404, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    /* path.resolve + перевірка межі папки: `..`, `%2e%2e` і
       `САЙТ-evil` за межами __dirname не пройдуть. */
    const filePath = path.resolve(__dirname, "." + decodedPath);
    const within = filePath === __dirname || filePath.startsWith(__dirname + path.sep);
    const ext = path.extname(filePath).toLowerCase();

    /* Білий список: віддаємо лише те, що справді потрібно браузеру.
       Інакше `/server.js`, `/package.json` і `/data/*.db` можна було
       завантажити прямим посиланням. */
    const relativePath = path.relative(__dirname, filePath).split(path.sep).join("/");
    const hasDotSegment = relativePath.split("/").some((part) => part.startsWith("."));
    const isPublicFile =
      relativePath === "index.html" ||
      relativePath === "i18n-phrases.js" ||
      /^images\/[^/]+$/.test(relativePath) ||
      /^videos\/[^/]+$/.test(relativePath);
    const canServe = within && !hasDotSegment && isPublicFile && ext && MIME_TYPES[ext];

    if (canServe) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const type = MIME_TYPES[ext];
          res.writeHead(200, {
            ...securityHeaders(),
            "Content-Type": type,
            "Content-Length": stat.size,
            "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
          });
          if (method === "HEAD") {
            res.end();
          } else {
            fs.createReadStream(filePath).pipe(res);
          }
          return;
        }
      } catch (error) {
        // File not found -> fall through to index.html (SPA routing)
      }
    }

    /* Запит із розширенням файлу, який не пройшов білий список,
       не має повертати index.html з кодом 200. */
    if (ext) {
      res.writeHead(404, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
      res.end(method === "HEAD" ? undefined : "Not found");
      return;
    }
  }

  try {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    res.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server error");
  }
});

ensureData();
scheduleDailyReport();

server.listen(PORT, HOST, () => {
  console.log(`NEXUS site server listening on http://${HOST}:${PORT}/`);
  console.log(`mode: ${IS_PROD ? "production" : "development"}${PUBLIC_MODE ? " / public" : ""}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`database: ${DB_IN_MEMORY ? "memory (без збереження після рестарту)" : path.join(DATA_DIR, "nexus.db")}`);
  console.log(`RCON: ${RCON_ENABLED ? "configured" : "disabled"}`);
});

/* Render надсилає SIGTERM — закриваємо сервер і SQLite чемно. */
function shutdown() {
  server.close(() => {
    try { db.close(); } catch (error) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
