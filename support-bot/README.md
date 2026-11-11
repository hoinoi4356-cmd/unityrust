# UNITY RUST — support ticket bot

Discord bot for support tickets, cheater/abuse reports, moderation commands,
logs and beta applications.

## Standalone run

```powershell
cd support-bot
npm install
node --env-file-if-exists=.env ticket-bot.js
```

Create `.env` from `.env.example`. Never commit `.env`.

## Run together with the website

The main `server.js` starts this bot automatically when `SUPPORT_BOT_TOKEN`
is present in the environment. It passes that token to the bot as
`DISCORD_BOT_TOKEN`, so the support bot can use a different Discord
application than the website bot.

Required on the website service:

- `SUPPORT_BOT_TOKEN` — token of the support bot (`Unity rust support`)
- `DISCORD_GUILD_ID` — the Discord server ID
- `STAFF_ROLE_ID` — one or more staff role IDs, comma-separated
- optionally `TICKET_CATEGORY_ID`, `LOG_CHANNEL_ID`, `BETA_CHANNEL_ID`,
  `ADMIN_CHANNEL_ID`, `BETA_ROLE_ID`

The web service keeps the bot process alive, restarts it after a crash and
pings its own `/healthz` on Render (`RENDER_EXTERNAL_URL`) so a free web
service does not sleep.

Ticket/moderations/beta JSON files live in `support-bot/data` by default
(gitignored). On a host with a persistent disk set
`SUPPORT_BOT_DATA_DIR=/var/data/support-bot`.

## Health

`GET /healthz` on the website reports `siteBot` and `supportBot` booleans.
