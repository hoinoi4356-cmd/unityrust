/**
 * UNITY RUST — Discord бот тикетов, модерации, логов и бета-регистрации
 * Языки: русский + английский
 * Нужно: npm install discord.js ws
 * Настройка через .env (см. .env.example)
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

// --- Завантаження .env без сторонніх пакетов ---
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.warn("[env] Не вдалося прочитати .env:", e.message);
  }
})();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const TICKET_CATEGORY_NAME = process.env.TICKET_CATEGORY_NAME || "Тикеты / Tickets";
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";
const BETA_CHANNEL_ID = process.env.BETA_CHANNEL_ID || "";
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || ""; // адмін-канал для вигляду заявок бета-тесту / admin channel for beta applications
const BETA_ROLE_ID = process.env.BETA_ROLE_ID || "";

if (!TOKEN) {
  console.error("[bot] DISCORD_BOT_TOKEN не задано / not set — бот не запустится");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "data");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");
const MODERATIONS_FILE = path.join(DATA_DIR, "moderations.json");
const BETAS_FILE = path.join(DATA_DIR, "betas.json");

const TICKET_TYPES = [
  {
    value: "cheater_report",
    label: "Cheater Report",
    description: "Report a cheater or rule breaker / Жалоба на читера",
    emoji: "🕵️",
    slug: "cheater",
    color: 0xff4444,
    questions: [
      "Никнейм нарушителя в игре / In-game name of the cheater",
      "Steam ID или ссылка на профиль (если есть) / Steam ID or profile link (if any)",
      "Что случилось: время, сервер, детали / What happened: time, server, details",
      "Прикрепите видео или скриншот в этот канал / Attach a video or screenshot to this channel",
    ],
  },
  {
    value: "ban_appeal",
    label: "Ban Appeal",
    description: "Appeal a ban / Апелляция бана",
    emoji: "⚖️",
    slug: "ban-appeal",
    color: 0xffa500,
    questions: [
      "Ваш никнейм в игре / Your in-game name",
      "Steam ID или ссылка на профиль / Steam ID or profile link",
      "Когда и на каком сервере вы получили бан / When and on which server you were banned",
      "Какую причину бана вы видели (скриншот приветствуется) / Ban reason you saw (screenshot welcome)",
      "Почему вы считаете бан ошибкой / Why you think the ban is a mistake",
    ],
  },
  {
    value: "general_support",
    label: "General Support",
    description: "General support question / Общий вопрос",
    emoji: "✉️",
    slug: "support",
    color: 0x009dff,
    questions: [
      "Ваш никнейм в игре / Your in-game name",
      "Опишите вопрос или проблему / Describe your question or problem",
      "Что вы уже пробовали / What have you already tried",
      "Скриншот или видео, если это поможет объяснить / Screenshot or video if it helps",
    ],
  },
  {
    value: "abuse_report",
    label: "Abuse Report",
    description: "Report abuse / Жалоба на злоупотребление",
    emoji: "🚫",
    slug: "abuse",
    color: 0xff7a00,
    questions: [
      "Никнейм нарушителя / In-game name of the offender",
      "Что случилось / What happened",
      "Когда и где это случилось / When and where it happened",
      "Прикрепите доказательства: видео или скриншот / Attach evidence: video or screenshot",
    ],
  },
  {
    value: "mute_appeal",
    label: "Mute Appeal",
    description: "Appeal a mute / Апелляция мута",
    emoji: "🔇",
    slug: "mute-appeal",
    color: 0x9b59b6,
    questions: [
      "Ваш никнейм в игре / Your in-game name",
      "Когда и на каком сервере вы получили мут / When and on which server you were muted",
      "Какую причину мута вы видели (скриншот приветствуется) / Mute reason you saw (screenshot welcome)",
      "Ваше объяснение / Your explanation",
    ],
  },
];

function getTicketType(value) {
  return (
    TICKET_TYPES.find((t) => t.value === value) ||
    TICKET_TYPES.find((t) => t.value === "general_support")
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
});

client.tickets = new Collection();
client.moderations = new Collection();
client.betas = new Collection();

let modCounter = 0;
function nextModId() { modCounter++; return modCounter; }
function initModCounter() {
  if (client.moderations.size > 0) {
    modCounter = Math.max(...Array.from(client.moderations.keys()).map(Number));
  }
}

let betaCounter = 0;
function nextBetaId() { betaCounter++; return betaCounter; }
function initBetaCounter() {
  if (client.betas.size > 0) {
    betaCounter = Math.max(...Array.from(client.betas.values()).map((b) => b.id || 0));
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTickets() {
  try {
    const raw = fs.readFileSync(TICKETS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((t) => client.tickets.set(t.channelId, t));
  } catch {}
}
function saveTickets() {
  ensureDataDir();
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(Array.from(client.tickets.values()), null, 2));
}

function loadModerations() {
  try {
    const raw = fs.readFileSync(MODERATIONS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((m) => client.moderations.set(m.id, m));
  } catch {}
}
function saveModerations() {
  ensureDataDir();
  fs.writeFileSync(MODERATIONS_FILE, JSON.stringify(Array.from(client.moderations.values()), null, 2));
}

function loadBetas() {
  try {
    const raw = fs.readFileSync(BETAS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((b) => client.betas.set(b.steamId, b));
  } catch {}
}
function saveBetas() {
  ensureDataDir();
  fs.writeFileSync(BETAS_FILE, JSON.stringify(Array.from(client.betas.values()), null, 2));
}

function nowISO() { return new Date().toISOString(); }
function ruen(ru, en) { return `${ru}\n${en}`; }

function memberHasPerm(member, perm) {
  try { return member.permissions.has(perm); } catch { return false; }
}
function isStaff(member) {
  if (STAFF_ROLE_IDS.length) return STAFF_ROLE_IDS.some(id => member.roles.cache.has(id));
  return memberHasPerm(member, PermissionFlagsBits.ManageChannels);
}

/* ===================== События ===================== */
client.once("ready", async () => {
  console.log(`[bot] Вход как / Logged in as ${client.user.tag} (${client.user.id})`);
  loadTickets();
  loadModerations();
  initModCounter();
  loadBetas();
  initBetaCounter();

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: [
        new SlashCommandBuilder().setName("setup-tickets").setDescription("Панель тикетов / Ticket panel").toJSON(),
        new SlashCommandBuilder().setName("warn").setDescription("Видати варнінг / Warn a user").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).addStringOption(o => o.setName("причина").setDescription("Причина / Reason").setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName("mute").setDescription("Замутити / Timeout").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).addIntegerOption(o => o.setName("години").setDescription("Години / Hours").setRequired(false).setMinValue(1).setMaxValue(720)).addStringOption(o => o.setName("причина").setDescription("Причина / Reason").setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName("unmute").setDescription("Зняти мут / Unmute").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).addStringOption(o => o.setName("причина").setDescription("Причина / Reason").setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName("ban").setDescription("Забанити / Ban").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).addIntegerOption(o => o.setName("дні").setDescription("Дні (0 = назавжди) / Days (0 = permanent)").setRequired(false).setMinValue(0).setMaxValue(365)).addStringOption(o => o.setName("причина").setDescription("Причина / Reason").setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName("unban").setDescription("Розбанити / Unban").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).addStringOption(o => o.setName("причина").setDescription("Причина / Reason").setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName("kick").setDescription("Кикнути / Kick").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).addStringOption(o => o.setName("причина").setDescription("Причина / Reason").setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName("history").setDescription("Історія покарань / History").addUserOption(o => o.setName("user").setDescription("Користувач / User").setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName("modlogs").setDescription("Логи модерації / Mod logs").addIntegerOption(o => o.setName("ліміт").setDescription("Ліміт / Limit").setRequired(false).setMinValue(1).setMaxValue(50)).toJSON(),
        new SlashCommandBuilder().setName("beta").setDescription("Опублікувати панель реєстрації на бета-тест / Post beta registration panel").toJSON(),
      ],
    });
    console.log("[bot] Слаш-команди зареєстровані / Slash commands registered");
  } catch (error) {
    console.error("[bot] Помилка реєстрації команд / Error registering commands:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isCommand()) {
    const name = interaction.commandName;
    if (name === "setup-tickets") return handleSetupTickets(interaction);
    if (name === "warn") return handleWarnSlash(interaction);
    if (name === "mute") return handleMuteSlash(interaction);
    if (name === "unmute") return handleUnmuteSlash(interaction);
    if (name === "ban") return handleBanSlash(interaction);
    if (name === "unban") return handleUnbanSlash(interaction);
    if (name === "kick") return handleKickSlash(interaction);
    if (name === "history") return handleHistorySlash(interaction);
    if (name === "modlogs") return handleModlogsSlash(interaction);
    if (name === "beta") return handleBetaSlash(interaction);
    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "ticket_category") return createTicket(interaction, interaction.values[0]);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === "ticket_create") return createTicket(interaction, "general_support");
    if (interaction.customId === "claim_ticket") return claimTicket(interaction);
    if (interaction.customId === "close_ticket") return closeTicket(interaction);
    if (interaction.customId === "beta_clan") return showBetaClanModal(interaction);
    if (interaction.customId === "beta_player") return showBetaPlayerModal(interaction);
    if (interaction.customId.startsWith("rate_ticket_")) return rateTicket(interaction);
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "beta_clan_modal") return handleBetaClanModalSubmit(interaction);
    if (interaction.customId === "beta_player_modal") return handleBetaPlayerModalSubmit(interaction);
    return;
  }
});

/* ===================== ТИКЕТИ / Tickets ===================== */
async function handleSetupTickets(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може публікувати панель тикетів.", "Only staff can post ticket panel.") });
  const embed = new EmbedBuilder().setColor(0x009dff).setTitle("Support / Підтримка").setDescription([
    "Open a ticket and our team will help you.",
    "Откройте тикет — наша команда поможет.",
    "",
    "**How it works / Як це працює**",
    "1. Pick the category / Виберіть категорію",
    "2. Answer a few questions / Відповідайте на питання",
    "3. Our team will respond / Команда відповідатиме",
  ].join("\n")).setFooter({ text: "UNITY RUST · Support" }).setTimestamp();
  const select = new StringSelectMenuBuilder().setCustomId("ticket_category").setPlaceholder("Виберіть категорію… / Choose a category…").addOptions(TICKET_TYPES.map(t => new StringSelectMenuOptionBuilder().setLabel(t.label).setDescription(t.description).setValue(t.value).setEmoji(t.emoji)));
  await interaction.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
  await interaction.editReply({ content: ruen("Панель тикетов опублікована.", "Ticket panel posted.") });
}

async function createTicket(interaction, typeValue) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild;
  const typeDef = getTicketType(typeValue);
  const type = typeDef.value;
  const existing = Array.from(client.tickets.values()).find(t => t.guildId === guild.id && t.userId === interaction.user.id && t.status === "open");
  if (existing) {
    const ch = guild.channels.cache.get(existing.channelId);
    if (ch) return interaction.editReply({ content: ruen(`У вас уже есть открытый тикет: ${ch}`, `You already have an open ticket: ${ch}`) });
    existing.status = "stale"; saveTickets();
  }
  let category = TICKET_CATEGORY_ID ? guild.channels.cache.get(TICKET_CATEGORY_ID) : null;
  if (!category) category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === TICKET_CATEGORY_NAME);
  if (!category) category = await guild.channels.create({ name: TICKET_CATEGORY_NAME, type: ChannelType.GuildCategory, reason: "Категория тикетов" });
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  for (const roleId of STAFF_ROLE_IDS) overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] });
  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
  const channel = await guild.channels.create({ name: `ticket-${typeDef.slug}-${safeName}`.slice(0, 95), type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites, topic: `Ticket: ${typeDef.label} | Author: ${interaction.user.tag} (${interaction.user.id})`, reason: `New ticket from ${interaction.user.tag}` });
  const embed = new EmbedBuilder().setColor(typeDef.color).setTitle(`${typeDef.emoji} ${typeDef.label}`).setDescription([
    `**Автор / Author:** ${interaction.user} (\`${interaction.user.id}\`)`,
    "",
    "**Ответьте на эти вопросы / Please answer these questions:**",
    ...typeDef.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "Скриншоты и видео прикрепляйте прямо в этот канал. / Attach screenshots and videos directly to this channel.",
    "Персонал ответит как можно быстрее. / Staff will respond as soon as possible.",
  ].join("\n")).setFooter({ text: "UNITY RUST · Support" }).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("claim_ticket").setLabel(ruen("Взять на рассмотрение", "Take into consideration")).setStyle(ButtonStyle.Primary).setEmoji("✋"),
    new ButtonBuilder().setCustomId("close_ticket").setLabel(ruen("Закрити тикет", "Close ticket")).setStyle(ButtonStyle.Secondary).setEmoji("🔒")
  );
  const staffMention = STAFF_ROLE_IDS.map(id => `<@&${id}>`).join(" ");
  const sent = await channel.send({ content: `${interaction.user} ${staffMention}`, embeds: [embed], components: [row] });
  client.tickets.set(channel.id, { channelId: channel.id, messageId: sent.id, userId: interaction.user.id, type, status: "open", createdAt: nowISO(), guildId: guild.id });
  saveTickets();
  await interaction.editReply({ content: ruen(`Тикет створено: ${channel}`, `Ticket created: ${channel}`) });
}

async function claimTicket(interaction) {
  const t = client.tickets.get(interaction.channelId);
  if (!t) return interaction.reply({ content: ruen("Тикет не знайдено.", "Ticket not found."), ephemeral: true });
  if (!isStaff(interaction.member)) return interaction.reply({ content: ruen("Лиш персонал може взяти тикет на розгляд.", "Only staff can take a ticket."), ephemeral: true });
  if (t.status === "claimed") return interaction.reply({ content: ruen(`Цей тикет вже взято на розгляд: <@${t.claimedBy}>`, `This ticket is already taken by: <@${t.claimedBy}>`), ephemeral: true });
  await interaction.deferReply({ flags: 64 });
  t.status = "claimed"; t.claimedBy = interaction.user.id; t.claimedAt = nowISO(); saveTickets();
  try {
    const msg = await interaction.channel.messages.fetch(t.messageId);
    const embed = msg.embeds[0];
    const newEmbed = EmbedBuilder.from(embed).addFields({ name: ruen("Взято на розгляд / Taken by", "Taken by / Взято на розгляд"), value: `<@${interaction.user.id}>`, inline: true }).setColor(0xffa500);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("claim_ticket").setLabel(ruen("Взято на рассмотрение", "Taken into consideration")).setStyle(ButtonStyle.Secondary).setEmoji("✅").setDisabled(true),
      new ButtonBuilder().setCustomId("close_ticket").setLabel(ruen("Закрити тикет", "Close ticket")).setStyle(ButtonStyle.Secondary).setEmoji("🔒")
    );
    await msg.edit({ embeds: [newEmbed], components: [row] });
  } catch (e) { console.error("[claim] edit error:", e.message); }
  await interaction.reply({ content: ruen("Ви взяли цей тикет на розгляд.", "You have taken this ticket into consideration."), ephemeral: true });
}

async function closeTicket(interaction) {
  const t = client.tickets.get(interaction.channelId);
  if (!t) return interaction.reply({ content: ruen("Тикет не знайдено.", "Ticket not found."), ephemeral: true });
  const isAuthor = t.userId === interaction.user.id;
  if (!isAuthor && !isStaff(interaction.member)) return interaction.reply({ content: ruen("Лиш автор або персонал може закрити тикет.", "Only author or staff can close."), ephemeral: true });
  if (t.status === "rated") { await interaction.reply(ruen("Закриваю…", "Closing…")); setTimeout(() => interaction.channel.delete("Ticket closed").catch(() => {}), 2000); return; }
  t.status = "closed"; t.closedAt = nowISO(); t.closedBy = interaction.user.id; saveTickets();
  const embed = new EmbedBuilder().setColor(0x009dff).setTitle(ruen("Оцініть підтримку / Rate support", "Rate support / Оцініть підтримку")).setDescription(ruen("Оцініть якість обслуговування з 1 до 5 зірок.", "Rate support quality from 1 to 5 stars."));
  const row = new ActionRowBuilder().addComponents([1,2,3,4,5].map(n => new ButtonBuilder().setCustomId(`rate_ticket_${n}`).setLabel(`${n} ⭐`).setStyle(ButtonStyle.Secondary)));
  await interaction.reply({ content: ruen("Тикет закрито. Оцініть якість підтримки:", "Ticket closed. Rate support quality:"), embeds: [embed], components: [row] });
  setTimeout(() => { const cur = client.tickets.get(interaction.channelId); if (cur && cur.status === "closed") interaction.channel.delete("Ticket closed - no rating").catch(() => {}); }, 120000);
}

async function rateTicket(interaction) {
  const t = client.tickets.get(interaction.channelId);
  if (!t) return interaction.reply({ content: ruen("Тикет не знайдено.", "Ticket not found."), ephemeral: true });
  if (t.userId !== interaction.user.id) return interaction.reply({ content: ruen("Лиш автор може поставити оцінку.", "Only author can rate."), ephemeral: true });
  const stars = parseInt(interaction.customId.split("_").pop(), 10);
  t.rating = stars; t.ratedAt = nowISO(); t.status = "rated"; saveTickets();
  await interaction.reply({ content: ruen(`Дякуємо за оцінку: ${stars}/5 ⭐`, `Thank you for rating: ${stars}/5 ⭐`), ephemeral: true });
  setTimeout(() => interaction.channel.delete("Ticket rated").catch(() => {}), 3000);
}

/* ===================== МОДЕРАЦИЯ / Moderation ===================== */
function addModeration(guildId, targetId, targetName, moderatorId, moderatorName, action, reason, expiresAt = null) {
  const id = nextModId();
  const rec = { id, guildId, targetId, targetName, moderatorId, moderatorName, action, reason: reason || "", timestamp: nowISO(), expiresAt };
  client.moderations.set(id, rec);
  saveModerations();
  return rec;
}
function getUserModerations(guildId, targetId) {
  return Array.from(client.moderations.values()).filter(m => m.guildId === guildId && m.targetId === targetId).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
}
function getRecentModerations(guildId, limit = 10) {
  return Array.from(client.moderations.values()).filter(m => m.guildId === guildId).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
}

async function sendModLog(guild, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] });
  } catch {}
}

function modEmoji(action) {
  switch(action) {
    case "warn": return "⚠️";
    case "mute": return "🔇";
    case "unmute": return "🔊";
    case "ban": return "🔨";
    case "unban": return "♻️";
    case "kick": return "👢";
    default: return "📋";
  }
}
function modColor(action) {
  switch(action) {
    case "warn": return 0xffa500;
    case "mute": return 0xff4444;
    case "unmute": return 0x00ff00;
    case "ban": return 0xff0000;
    case "unban": return 0x009dff;
    case "kick": return 0xff7a00;
    default: return 0x009dff;
  }
}

async function handleWarnSlash(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може видавати варнінги.", "Only staff can warn.") });
  const target = interaction.options.getUser("user"); const reason = interaction.options.getString("причина") || "";
  addModeration(interaction.guildId, target.id, target.tag, interaction.user.id, interaction.user.tag, "warn", reason);
  const embed = new EmbedBuilder().setColor(modColor("warn")).setTitle(`${modEmoji("warn")} Варнінг / Warning`);
  embed.addFields({ name: "Користувач / User", value: `<@${target.id}> (\`${target.id}\`)`, inline: true });
  embed.addFields({ name: "Модератор / Moderator", value: `<@${interaction.user.id}>`, inline: true });
  embed.addFields({ name: "Причина / Reason", value: reason || "—", inline: false });
  embed.setTimestamp();
  await interaction.editReply({ content: ruen("Варнінг видано.", "Warning issued."), embeds: [embed] });
  await sendModLog(interaction.guild, embed);
}

async function handleMuteSlash(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може мутити.", "Only staff can mute.") });
  const target = interaction.options.getUser("user"); const hours = interaction.options.getInteger("години") || 24; const reason = interaction.options.getString("причина") || "";
  let dr = "";
  try { const gm = await interaction.guild.members.fetch(target.id).catch(() => null); if (gm) { await gm.timeout(hours * 60 * 60 * 1000, reason); dr = "Тайм-аут встановлено в Discord."; } else { dr = "Користувач не знайдений на сервері Discord."; } } catch(e) { dr = `Помилка Discord: ${e.message}`; }
  addModeration(interaction.guildId, target.id, target.tag, interaction.user.id, interaction.user.tag, "mute", reason, new Date(Date.now() + hours * 60 * 60 * 1000).toISOString());
  const embed = new EmbedBuilder().setColor(modColor("mute")).setTitle(`${modEmoji("mute")} Мут / Timeout`);
  embed.addFields({ name: "Користувач / User", value: `<@${target.id}>`, inline: true });
  embed.addFields({ name: "Модератор / Moderator", value: `<@${interaction.user.id}>`, inline: true });
  embed.addFields({ name: "Тривалість / Duration", value: `${hours} годин / hours`, inline: true });
  embed.addFields({ name: "Причина / Reason", value: reason || "—", inline: false });
  embed.addFields({ name: "Discord", value: dr, inline: false });
  embed.setTimestamp();
  await interaction.editReply({ content: ruen("Користувача замучено.", "User muted."), embeds: [embed] });
  await sendModLog(interaction.guild, embed);
}

async function handleUnmuteSlash(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може знімати мут.", "Only staff can unmute.") });
  const target = interaction.options.getUser("user"); const reason = interaction.options.getString("причина") || "";
  let dr = "";
  try { const gm = await interaction.guild.members.fetch(target.id).catch(() => null); if (gm) { await gm.timeout(null, reason); dr = "Тайм-аут знято в Discord."; } else { dr = "Користувач не знайдений на сервері Discord."; } } catch(e) { dr = `Помилка Discord: ${e.message}`; }
  addModeration(interaction.guildId, target.id, target.tag, interaction.user.id, interaction.user.tag, "unmute", reason);
  const embed = new EmbedBuilder().setColor(modColor("unmute")).setTitle(`${modEmoji("unmute")} Знято мут / Unmuted`);
  embed.addFields({ name: "Користувач / User", value: `<@${target.id}>`, inline: true });
  embed.addFields({ name: "Модератор / Moderator", value: `<@${interaction.user.id}>`, inline: true });
  embed.addFields({ name: "Причина / Reason", value: reason || "—", inline: false });
  embed.addFields({ name: "Discord", value: dr, inline: false });
  embed.setTimestamp();
  await interaction.editReply({ content: ruen("Мут знято.", "Unmuted."), embeds: [embed] });
  await sendModLog(interaction.guild, embed);
}

async function handleBanSlash(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може банити.", "Only staff can ban.") });
  const target = interaction.options.getUser("user"); const days = interaction.options.getInteger("дні") || 7; const reason = interaction.options.getString("причина") || "";
  let dr = "";
  try { await interaction.guild.members.ban(target.id, { days: days > 0 ? days : 0, reason }); dr = days > 0 ? `Бан на ${days} днів.` : "Перманентний бан."; } catch(e) { dr = `Помилка Discord: ${e.message}`; }
  addModeration(interaction.guildId, target.id, target.tag, interaction.user.id, interaction.user.tag, "ban", reason, days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null);
  const embed = new EmbedBuilder().setColor(modColor("ban")).setTitle(`${modEmoji("ban")} Бан / Ban`);
  embed.addFields({ name: "Користувач / User", value: `<@${target.id}>`, inline: true });
  embed.addFields({ name: "Модератор / Moderator", value: `<@${interaction.user.id}>`, inline: true });
  embed.addFields({ name: "Тривалість / Duration", value: days > 0 ? `${days} днів / days` : "Назавжди / Permanent", inline: true });
  embed.addFields({ name: "Причина / Reason", value: reason || "—", inline: false });
  embed.addFields({ name: "Discord", value: dr, inline: false });
  embed.setTimestamp();
  await interaction.editReply({ content: ruen("Користувача забанено.", "User banned."), embeds: [embed] });
  await sendModLog(interaction.guild, embed);
}

async function handleUnbanSlash(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може розбанити.", "Only staff can unban.") });
  const target = interaction.options.getUser("user"); const reason = interaction.options.getString("причина") || "";
  let dr = "";
  try { await interaction.guild.members.removeBan(target.id, reason); dr = "Бан знято в Discord."; } catch(e) { dr = `Помилка Discord: ${e.message}`; }
  addModeration(interaction.guildId, target.id, target.tag, interaction.user.id, interaction.user.tag, "unban", reason);
  const embed = new EmbedBuilder().setColor(modColor("unban")).setTitle(`${modEmoji("unban")} Розбан / Unban`);
  embed.addFields({ name: "Користувач / User", value: `<@${target.id}>`, inline: true });
  embed.addFields({ name: "Модератор / Moderator", value: `<@${interaction.user.id}>`, inline: true });
  embed.addFields({ name: "Причина / Reason", value: reason || "—", inline: false });
  embed.addFields({ name: "Discord", value: dr, inline: false });
  embed.setTimestamp();
  await interaction.editReply({ content: ruen("Користувача розбанено.", "User unbanned."), embeds: [embed] });
  await sendModLog(interaction.guild, embed);
}

async function handleKickSlash(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!isStaff(interaction.member)) return interaction.editReply({ content: ruen("Лиш персонал може кикнути.", "Only staff can kick.") });
  const target = interaction.options.getUser("user"); const reason = interaction.options.getString("причина") || "";
  let dr = "";
  try { await interaction.guild.members.kick(target.id, reason); dr = "Користувача кикнуто з сервера Discord."; } catch(e) { dr = `Помилка Discord: ${e.message}`; }
  addModeration(interaction.guildId, target.id, target.tag, interaction.user.id, interaction.user.tag, "kick", reason);
  const embed = new EmbedBuilder().setColor(modColor("kick")).setTitle(`${modEmoji("kick")} Кик / Kick`);
  embed.addFields({ name: "Користувач / User", value: `<@${target.id}>`, inline: true });
  embed.addFields({ name: "Модератор / Moderator", value: `<@${interaction.user.id}>`, inline: true });
  embed.addFields({ name: "Причина / Reason", value: reason || "—", inline: false });
  embed.addFields({ name: "Discord", value: dr, inline: false });
  embed.setTimestamp();
  await interaction.editReply({ content: ruen("Користувача кикнуто.", "User kicked."), embeds: [embed] });
  await sendModLog(interaction.guild, embed);
}

async function handleHistorySlash(interaction) {
  const target = interaction.options.getUser("user"); const records = getUserModerations(interaction.guildId, target.id);
  if (records.length === 0) return interaction.reply({ content: ruen(`У <@${target.id}> немає записів покарань.`, `No moderation records for <@${target.id}>.`), ephemeral: true });
  const embed = new EmbedBuilder().setColor(0x009dff).setTitle(`${modEmoji("warn")} Історія покарань / Moderation History`);
  embed.setDescription(`Користувач: <@${target.id}> (\`${target.id}\`)`);
  for (const r of records) {
    embed.addFields({ name: `${modEmoji(r.action)} ${r.action.toUpperCase()} • #${r.id}`, value: `Модератор: <@${r.moderatorId}>\nПричина: ${r.reason || "—"}\n${new Date(r.timestamp).toLocaleString()}`, inline: false });
  }
  embed.setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleModlogsSlash(interaction) {
  const limit = interaction.options.getInteger("ліміт") || 10; const records = getRecentModerations(interaction.guildId, limit);
  if (records.length === 0) return interaction.reply({ content: ruen("Немає записів модерації.", "No moderation records."), ephemeral: true });
  const embed = new EmbedBuilder().setColor(0x009dff).setTitle(`Останні дії адміністрації / Recent Moderation Logs (${records.length})`);
  for (const r of records) {
    embed.addFields({ name: `${modEmoji(r.action)} ${r.action.toUpperCase()} • #${r.id}`, value: `Ціль: <@${r.targetId}>\nМодератор: <@${r.moderatorId}>\nПричина: ${r.reason || "—"}\n${new Date(r.timestamp).toLocaleString()}`, inline: false });
  }
  embed.setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/* ===================== БЕТА-ТЕСТ / Beta Test ===================== */
async function handleBetaSlash(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply({ content: ruen("Лиш персонал може публікувати панель бета-тесту.", "Only staff can post beta panel."), ephemeral: true });

  const embed = new EmbedBuilder().setColor(0x009dff).setTitle("🧪 Бета-тест UNITY RUST / UNITY RUST Beta Test");
  embed.setDescription(
    "🇷🇺 Бета-тест UNITY RUST\n" +
    "Вайп сервера запланирован на 12-е число (12.11.2026).\n\n" +
    "Выберите кнопку ниже, чтобы зарегистрировать свой клан или себя в качестве игрока на бета-тест.\n" +
    "Поторопитесь — количество мест ограничено!\n\n" +
    "🇬🇧 UNITY RUST Beta Test\n" +
    "Server wipe is planned for November 12 (12.11.2026).\n\n" +
    "Click the button below to register your clan or yourself as a player for the beta test. Hurry up — slots are limited!"
  );
  embed.setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("beta_clan").setLabel(ruen("Зарегистрировать клан", "Register Clan")).setStyle(ButtonStyle.Primary).setEmoji("🏰"),
    new ButtonBuilder().setCustomId("beta_player").setLabel(ruen("Зарегистрировать игрока", "Register Player")).setStyle(ButtonStyle.Secondary).setEmoji("👤")
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: ruen("Панель бета-тесту опублікована.", "Beta panel posted."), ephemeral: true });
}

async function showBetaClanModal(interaction) {
  try {
    const clanTag = new TextInputBuilder().setCustomId("clan_tag").setLabel("Тег клана").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(20);
    const clanName = new TextInputBuilder().setCustomId("clan_name").setLabel("Название клана").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(50);
    const allSteam = new TextInputBuilder().setCustomId("all_steamid").setLabel("SteamID64 всех игроков клана").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(17).setMaxLength(1000);
    const modal = new ModalBuilder().setCustomId("beta_clan_modal").setTitle("Регистрация клана").addComponents(
      new ActionRowBuilder().addComponents(clanTag),
      new ActionRowBuilder().addComponents(clanName),
      new ActionRowBuilder().addComponents(allSteam)
    );
    await interaction.showModal(modal);
  } catch (e) {
    console.error("[beta_clan_modal] error:", e.message);
    await interaction.reply({ content: ruen("Ошибка открытия формы. Попробуйте ещё раз.", "Error opening form. Try again."), ephemeral: true });
  }
}

async function showBetaPlayerModal(interaction) {
  try {
    const steam = new TextInputBuilder().setCustomId("player_steamid").setLabel("Ваш SteamID64").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(17).setMaxLength(17);
    const nickname = new TextInputBuilder().setCustomId("player_nickname").setLabel("Никнейм в игре").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(32);
    const modal = new ModalBuilder().setCustomId("beta_player_modal").setTitle("Регистрация игрока").addComponents(
      new ActionRowBuilder().addComponents(steam),
      new ActionRowBuilder().addComponents(nickname)
    );
    await interaction.showModal(modal);
  } catch (e) {
    console.error("[beta_player_modal] error:", e.message);
    await interaction.reply({ content: ruen("Ошибка открытия формы. Попробуйте ещё раз.", "Error opening form. Try again."), ephemeral: true });
  }
}

async function sendBetaToChannels(interactionObj, embed) {
  const guild = interactionObj.guild ?? client.guilds.cache.get(interactionObj.guildId);
  if (!guild) {
    console.error("[beta] Cannot resolve guild for interaction", interactionObj.guildId);
    return;
  }
  const targets = [];
  if (BETA_CHANNEL_ID) targets.push(BETA_CHANNEL_ID);
  if (ADMIN_CHANNEL_ID) targets.push(ADMIN_CHANNEL_ID);
  if (targets.length === 0) {
    console.error("[beta] No BETA_CHANNEL_ID or ADMIN_CHANNEL_ID configured in .env");
    return;
  }
  for (const chId of targets) {
    try {
      const ch = await guild.channels.fetch(chId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const mention = STAFF_ROLE_IDS[0] ? `<@&${STAFF_ROLE_IDS[0]}>` : "";
        await ch.send({ content: mention, embeds: [embed] });
        console.log("[beta] Sent notification to channel " + chId);
      } else {
        console.error("[beta] Channel " + chId + " not found or not text-based");
      }
    } catch (e) { console.error("[beta] notify error to " + chId + ":", e.message); }
  }
}

async function handleBetaClanModalSubmit(interaction) {
  await interaction.deferReply({ flags: 64 });
  const clanTag = interaction.fields.getTextInputValue("clan_tag").trim();
  const clanName = interaction.fields.getTextInputValue("clan_name").trim();
  const allSteamRaw = interaction.fields.getTextInputValue("all_steamid").trim();

  // Parse multiple SteamIDs separated by comma, space, or newline
  const steamIds = allSteamRaw.split(/[\s,]+/).filter(s => s.length > 0);

  // Validate all are 17 digits
  for (const sid of steamIds) {
    if (!/^\d{17}$/.test(sid)) return interaction.editReply({ content: ruen("Некоректный SteamID64: " + sid + ". Каждый должен быть из 17 цифр.", "Invalid SteamID64: " + sid + ". Each must be 17 digits.") });
  }

  // Check if any already registered
  for (const sid of steamIds) {
    if (client.betas.has(sid)) return interaction.editReply({ content: ruen("Игрок с SteamID64 " + sid + " уже зарегистрирован на бета-тест.", "Player with SteamID64 " + sid + " is already registered for the beta test.") });
  }

  const id = nextBetaId();
  for (const sid of steamIds) {
    client.betas.set(sid, { id, type: "clan", steamId: sid, clanTag, clanName, discordId: interaction.user.id, discordTag: interaction.user.tag, guildId: interaction.guildId, timestamp: nowISO(), status: "pending" });
  }
  saveBetas();

  if (BETA_ROLE_ID) {
    try { const m = await interaction.guild.members.fetch(interaction.user.id).catch(() => null); if (m) await m.roles.add(BETA_ROLE_ID); } catch (e) { console.error("[beta] role error:", e.message); }
  }

  await interaction.editReply({ content: ruen("Клан зарегистровано на бета-тест! Очікуйте доступу.", "Clan registered for beta test! Wait for access.") });

  await sendBetaToChannels(interaction, new EmbedBuilder().setColor(0x009dff).setTitle("🏰 Новая заявка клана на бета / New clan beta application")
    .addFields({ name: "Тег клана / Clan Tag", value: clanTag, inline: true })
    .addFields({ name: "Название клана / Clan Name", value: clanName, inline: true })
    .addFields({ name: "Игроков / Members", value: steamIds.length.toString(), inline: true })
    .addFields({ name: "SteamID64", value: steamIds.join(", "), inline: false })
    .addFields({ name: "Заявитель / Applicant", value: `<@${interaction.user.id}> (\`${interaction.user.tag}\`)`, inline: true })
    .addFields({ name: "Заявка # / Application #", value: `#${id}`, inline: true })
    .addFields({ name: "Статус / Status", value: "pending", inline: true })
    .setTimestamp()
  );
}

async function handleBetaPlayerModalSubmit(interaction) {
  await interaction.deferReply({ flags: 64 });
  const steam = interaction.fields.getTextInputValue("player_steamid").trim();
  const nickname = interaction.fields.getTextInputValue("player_nickname").trim();

  if (!/^\d{17}$/.test(steam)) return interaction.editReply({ content: ruen("Некоректний SteamID64. Має бути 17 цифр.", "Invalid SteamID64. Must be 17 digits.") });

  if (client.betas.has(steam)) return interaction.editReply({ content: ruen("Ви вже зареєстровані на бета-тест.", "You are already registered for the beta test.") });

  const id = nextBetaId();
  client.betas.set(steam, { id, type: "player", steamId: steam, nickname, discordId: interaction.user.id, discordTag: interaction.user.tag, guildId: interaction.guildId, timestamp: nowISO(), status: "pending" });
  saveBetas();

  if (BETA_ROLE_ID) {
    try { const m = await interaction.guild.members.fetch(interaction.user.id).catch(() => null); if (m) await m.roles.add(BETA_ROLE_ID); } catch (e) { console.error("[beta] role error:", e.message); }
  }

  await interaction.editReply({ content: ruen("Ви зареєстровані на бета-тест! Очікуйте доступу.", "You are registered for beta test! Wait for access.") });

  await sendBetaToChannels(interaction, new EmbedBuilder().setColor(0x009dff).setTitle("👤 Новая заявка гравца на бета / New player beta application")
    .addFields({ name: "Ник / Nickname", value: nickname, inline: true })
    .addFields({ name: "Игрок / Player", value: `<@${interaction.user.id}> (\`${interaction.user.tag}\`)`, inline: true })
    .addFields({ name: "SteamID64", value: steam, inline: true })
    .addFields({ name: "Заявка # / Application #", value: `#${id}`, inline: true })
    .addFields({ name: "Статус / Status", value: "pending", inline: true })
    .setTimestamp()
  );
}

/* ===================== Shutdown ===================== */
function shutdown() {
  console.log("[bot] Shutdown signal received, disconnecting…");
  client.destroy().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

client.login(TOKEN).catch((err) => {
  console.error("[bot] Не вдалося увійти з токеном / Failed to login with token:", err.message);
  process.exit(1);
});
