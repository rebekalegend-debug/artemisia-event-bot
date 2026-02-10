
// index.js
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

/* ================= ENV ================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // fallback ping channel
const ICS_URL = process.env.ICS_URL;

const PING = process.env.PING_TEXT ?? "@everyone";
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? "10");
const PREFIX = process.env.PREFIX ?? "!";

// Roles
const AOO_ROLE_ID = process.env.AOO_ROLE_ID ?? "1470120925856006277";

// State
const STATE_DIR = process.env.STATE_DIR ?? "/data";
const stateFile = path.resolve(STATE_DIR, "state.json");

if (!DISCORD_TOKEN || !ICS_URL) {
  console.error("Missing env vars: DISCORD_TOKEN or ICS_URL");
  process.exit(1);
}

/* ================= STATE ================= */

ensureStateDir();
const state = loadState();

state.scheduled ??= [];
state.config ??= {
  pingChannelId: CHANNEL_ID ?? null,
  mgeChannelId: null,
  mgeRoleId: null,
};
saveState();

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/* ================= HELPERS ================= */

function hasAooRole(member) {
  return member?.roles?.cache?.has(AOO_ROLE_ID);
}

function getPingChannelId() {
  return state.config.pingChannelId || CHANNEL_ID;
}

function getMgeChannelMention() {
  return state.config.mgeChannelId
    ? `<#${state.config.mgeChannelId}>`
    : "**[MGE channel not set]**";
}

function getMgeRoleMention() {
  return state.config.mgeRoleId
    ? `<@&${state.config.mgeRoleId}>`
    : "**[MGE role not set]**";
}

function getEventType(evOrText = "") {
  const text =
    typeof evOrText === "string"
      ? evOrText
      : [evOrText?.description, evOrText?.summary, evOrText?.location]
          .filter(Boolean)
          .join("\n");

  const m = text.match(/Type:\s*([a-z0-9_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function formatUTC(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getUTCDate()).padStart(2, "0")} ${String(
    d.getUTCHours()
  ).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function addHours(date, h) {
  return new Date(date.getTime() + h * 3600000);
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

/* ================= MESSAGES ================= */

function aooOpenMsg() {
  return `AOO registration is opened, reach out to <@&${AOO_ROLE_ID}> for registration!`;
}
function aooWarnMsg() {
  return `AOO registration will close soon, be sure you are registered!`;
}
function aooClosedMsg() {
  return `AOO registration closed`;
}

function mgeOpenMsg() {
  return `MGE registration is open, register in ${getMgeChannelMention()} channel, or reach out to ${getMgeRoleMention()} !`;
}
function mgeWarnMsg() {
  return `MGE registration closes in 24 hours, don’t forget to apply!`;
}
function mgeClosedMsg() {
  return `MGE registration is closed`;
}

/* ================= ANNOUNCEMENTS ================= */

async function runCheck(client) {
  const channel = await client.channels.fetch(getPingChannelId());
  if (!channel?.isTextBased()) return;

  const now = new Date();
  const events = await fetchEvents();

  for (const ev of events) {
    const type = getEventType(ev);
    if (!type) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    if (type === "ark_registration") {
      if (!state[`aoo_open_${ev.uid}`] && now >= start) {
        await channel.send(`${PING}\n${aooOpenMsg()}`);
        state[`aoo_open_${ev.uid}`] = true;
        saveState();
      }

      if (
        !state[`aoo_warn_${ev.uid}`] &&
        now >= addHours(end, -6) &&
        now < end
      ) {
        await channel.send(`${PING}\n${aooWarnMsg()}`);
        state[`aoo_warn_${ev.uid}`] = true;
        saveState();
      }

      if (!state[`aoo_close_${ev.uid}`] && now >= end) {
        await channel.send(`${PING}\n${aooClosedMsg()}`);
        state[`aoo_close_${ev.uid}`] = true;
        saveState();
      }
    }

    if (type === "mge") {
      if (!state[`mge_open_${ev.uid}`] && now >= addHours(end, 24)) {
        await channel.send(`${PING}\n${mgeOpenMsg()}`);
        state[`mge_open_${ev.uid}`] = true;
        saveState();
      }

      if (
        !state[`mge_warn_${ev.uid}`] &&
        now >= addHours(start, -48) &&
        now < addHours(start, -24)
      ) {
        await channel.send(`${PING}\n${mgeWarnMsg()}`);
        state[`mge_warn_${ev.uid}`] = true;
        saveState();
      }

      if (
        !state[`mge_close_${ev.uid}`] &&
        now >= addHours(start, -24) &&
        now < start
      ) {
        await channel.send(`${PING}\n${mgeClosedMsg()}`);
        state[`mge_close_${ev.uid}`] = true;
        saveState();
      }
    }
  }
}

/* ================= CLIENT ================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await runCheck(client);
  setInterval(runCheck, CHECK_EVERY_MINUTES * 60 * 1000, client);
});

/* ================= COMMANDS ================= */

client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.content.startsWith(PREFIX)) return;

  if (!hasAooRole(msg.member)) {
    return msg.reply("❌ You need the **AOO role** to use this command.");
  }

  const cmd = msg.content.slice(PREFIX.length).trim().toLowerCase();

  if (cmd.startsWith("set_ping_channel")) {
    const ch = msg.mentions.channels.first();
    if (!ch) return msg.reply("Usage: `!set_ping_channel #channel`");
    state.config.pingChannelId = ch.id;
    saveState();
    return msg.reply(`✅ Ping channel set to ${ch}`);
  }

  if (cmd.startsWith("set_mge_channel")) {
    const ch = msg.mentions.channels.first();
    if (!ch) return msg.reply("Usage: `!set_mge_channel #channel`");
    state.config.mgeChannelId = ch.id;
    saveState();
    return msg.reply(`✅ MGE channel set to ${ch}`);
  }

  if (cmd.startsWith("set_mge_role")) {
    const role = msg.mentions.roles.first();
    if (!role) return msg.reply("Usage: `!set_mge_role @role`");
    state.config.mgeRoleId = role.id;
    saveState();
    return msg.reply(`✅ MGE role set to ${role}`);
  }

  if (cmd === "show_config") {
    return msg.reply(
      "```" +
        [
          `Ping channel: ${
            state.config.pingChannelId
              ? `<#${state.config.pingChannelId}>`
              : "NOT SET"
          }`,
          `MGE channel: ${
            state.config.mgeChannelId
              ? `<#${state.config.mgeChannelId}>`
              : "NOT SET"
          }`,
          `MGE role: ${
            state.config.mgeRoleId
              ? `<@&${state.config.mgeRoleId}>`
              : "NOT SET"
          }`,
        ].join("\n") +
        "```"
    );
  }
});

client.login(DISCORD_TOKEN);
