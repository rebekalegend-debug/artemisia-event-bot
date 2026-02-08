// index.js
import { Client, GatewayIntentBits } from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ICS_URL = process.env.ICS_URL;

const PING = process.env.PING_TEXT ?? "@everyone";
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? "10");

// Prefix commands (Option B)
const PREFIX = process.env.PREFIX ?? "!";

// Persistent state (mount Railway Volume at /data)
const STATE_DIR = process.env.STATE_DIR ?? "/data";
const stateFile = path.resolve(STATE_DIR, "state.json");

if (!DISCORD_TOKEN || !CHANNEL_ID || !ICS_URL) {
  console.error("Missing env vars: DISCORD_TOKEN, CHANNEL_ID, ICS_URL");
  process.exit(1);
}

ensureStateDir();
const state = loadState();

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (e) {
    console.error("Failed to create STATE_DIR:", STATE_DIR, e);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}
function saveState() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save state:", e);
  }
}

function getEventType(description = "") {
  const m = description.match(/Type:\s*([a-z_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function isoDateUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function hoursBetween(a, b) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

function formatUTC(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

function addMonthsUTC(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

function makeKey(prefix, ev, suffix) {
  const uid = ev.uid || "no_uid";
  const day = isoDateUTC(new Date(ev.start));
  return `${prefix}_${uid}_${day}_${suffix}`;
}

async function runCheck(client, { silent = false } = {}) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.error("Channel not found or not text-based.");
    return;
  }

  const now = new Date();
  const events = await fetchEvents();

  for (const ev of events) {
    const eventType = getEventType(ev.description || "");
    if (!eventType) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    // 1) AOO Registration: Type = ark_registration
    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO", ev, "open");
      const warnKey = makeKey("AOO", ev, "24h_before_end");

      // at start
      if (!state[openKey] && now >= start) {
        if (!silent) {
          await channel.send(
            `${PING}\nAOO registration is open! Reach out to AOO team to apply.`
          );
        }
        state[openKey] = true;
        saveState();
      }

      // 24h before end
      const hoursToEnd = hoursBetween(now, end);
      if (!state[warnKey] && hoursToEnd <= 24 && hoursToEnd > 0) {
        if (!silent) {
          await channel.send(
            `${PING}\nAOO registration ends in 1 day — don’t forget to register!`
          );
        }
        state[warnKey] = true;
        saveState();
      }
    }

    // 2) MGE: Type = mge
    if (eventType === "mge") {
      const openKey = makeKey("mge", ev, "open_after_end");
      const closeKey = makeKey("mge", ev, "closed_24h_before_start");

      // at end => registration open
      if (!state[openKey] && now >= end) {
        if (!silent) {
          await channel.send(
            `${PING}\nMGE registration is open! Reach out to <#1469846200042917918> channel for registration!`
          );
        }
        state[openKey] = true;
        saveState();
      }

      // 24h before start => registration closed
      const hoursToStart = hoursBetween(now, start);
      if (!state[closeKey] && hoursToStart <= 24 && hoursToStart > 0) {
        if (!silent) {
          await channel.send(`${PING}\nMGE registration is now closed.`);
        }
        state[closeKey] = true;
        saveState();
      }
    }

    // 3) 20 Gold Head Event: Type = goldhead
    if (eventType === "goldhead") {
      const warnKey = makeKey("goldhead", ev, "24h_before_start");
      const hoursToStart = hoursBetween(now, start);

      if (!state[warnKey] && hoursToStart <= 24 && hoursToStart > 0) {
        if (!silent) {
          await channel.send(
            `${PING}\n20 Gold Head Event starts in 1 day — get ready!`
          );
        }
        state[warnKey] = true;
        saveState();
      }
    }
  }
}

// ---------- Prefix command helpers ----------

async function getNextEventOfType(type) {
  const now = new Date();
  const events = await fetchEvents();

  const typed = events
    .filter((ev) => getEventType(ev.description || "") === type)
    .map((ev) => ({ ev, start: new Date(ev.start), end: new Date(ev.end) }))
    .filter((x) => x.start > now)
    .sort((a, b) => a.start - b.start);

  return typed[0] || null;
}

async function getNextAnnouncementTime() {
  const now = new Date();
  const events = await fetchEvents();
  const candidates = [];

  for (const ev of events) {
    const eventType = getEventType(ev.description || "");
    if (!eventType) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO", ev, "open");
      const warnKey = makeKey("AOO", ev, "24h_before_end");

      if (!state[openKey] && start > now) {
        candidates.push({ when: start, text: "AOO registration opens" });
      }

      const warnTime = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      if (!state[warnKey] && warnTime > now) {
        candidates.push({ when: warnTime, text: "AOO registration ends in 24h" });
      }
    }

    if (eventType === "mge") {
      const openKey = makeKey("mge", ev, "open_after_end");
      const closeKey = makeKey("mge", ev, "closed_24h_before_start");

      if (!state[openKey] && end > now) {
        candidates.push({ when: end, text: "MGE registration opens" });
      }

      const closeTime = new Date(start.getTime() - 24 * 60 * 60 * 1000);
      if (!state[closeKey] && closeTime > now) {
        candidates.push({ when: closeTime, text: "MGE registration closes" });
      }
    }

    if (eventType === "goldhead") {
      const warnKey = makeKey("goldhead", ev, "24h_before_start");
      const warnTime = new Date(start.getTime() - 24 * 60 * 60 * 1000);

      if (!state[warnKey] && warnTime > now) {
        candidates.push({ when: warnTime, text: "20 Gold Head starts in 24h" });
      }
    }
  }

  candidates.sort((a, b) => a.when - b.when);
  return candidates[0] || null;
}

async function getAnnouncementsInNextMonths(months = 2) {
  const now = new Date();
  const until = addMonthsUTC(now, months);
  const events = await fetchEvents();

  const out = [];

  for (const ev of events) {
    const eventType = getEventType(ev.description || "");
    if (!eventType) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    if (eventType === "ark_registration") {
      const openKey = makeKey("AOO", ev, "open");
      const warnKey = makeKey("AOO", ev, "24h_before_end");

      if (!state[openKey] && start >= now && start <= until) {
        out.push({ when: start, text: "AOO registration opens", key: openKey });
      }

      const warnTime = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      if (!state[warnKey] && warnTime >= now && warnTime <= until) {
        out.push({ when: warnTime, text: "AOO registration ends in 24h", key: warnKey });
      }
    }

    if (eventType === "mge") {
      const openKey = makeKey("mge", ev, "open_after_end");
      const closeKey = makeKey("mge", ev, "closed_24h_before_start");

      if (!state[openKey] && end >= now && end <= until) {
        out.push({ when: end, text: "MGE registration opens", key: openKey });
      }

      const closeTime = new Date(start.getTime() - 24 * 60 * 60 * 1000);
      if (!state[closeKey] && closeTime >= now && closeTime <= until) {
        out.push({ when: closeTime, text: "MGE registration closes", key: closeKey });
      }
    }

    if (eventType === "goldhead") {
      const warnKey = makeKey("goldhead", ev, "24h_before_start");
      const warnTime = new Date(start.getTime() - 24 * 60 * 60 * 1000);

      if (!state[warnKey] && warnTime >= now && warnTime <= until) {
        out.push({ when: warnTime, text: "20 Gold Head starts in 24h", key: warnKey });
      }
    }
  }

  out.sort((a, b) => a.when - b.when);

  // De-dupe by key
  const seen = new Set();
  const deduped = [];
  for (const x of out) {
    if (seen.has(x.key)) continue;
    seen.add(x.key);
    deduped.push(x);
  }

  return { items: deduped, until };
}

function helpText() {
  return [
    `Commands (prefix: ${PREFIX})`,
    `- ${PREFIX}mge_start -> shows next MGE start time (UTC)`,
    `- ${PREFIX}next_announcement -> shows next scheduled announcement time (UTC)`,
    `- ${PREFIX}announcements_2m -> lists all announcements for next 2 months (UTC)`,
    `- ${PREFIX}ping -> bot health check`,
    `- ${PREFIX}help -> this list`,
  ].join("\n");
}

// ---------- Discord client ----------

// For prefix commands you MUST add MessageContent intent:
// 1) Discord Developer Portal -> Bot -> enable "Message Content Intent"
// 2) In code: GatewayIntentBits.MessageContent
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Boot sync: mark already-due triggers as sent without posting (prevents restart spam)
  await runCheck(client, { silent: true });

  // Normal run
  await runCheck(client, { silent: false });

  setInterval(
    () => runCheck(client, { silent: false }).catch(console.error),
    CHECK_EVERY_MINUTES * 60 * 1000
  );
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!msg.guild) return;
    if (!msg.content?.startsWith(PREFIX)) return;

    const content = msg.content.slice(PREFIX.length).trim();
    const [cmdRaw] = content.split(/\s+/);
    const cmd = (cmdRaw || "").toLowerCase();

    if (cmd === "ping") {
      await msg.reply("pong");
      return;
    }

    if (cmd === "help") {
      await msg.reply("```" + helpText() + "```");
      return;
    }

    if (cmd === "mge_start") {
      const next = await getNextEventOfType("mge");
      if (!next) {
        await msg.reply("No upcoming MGE event found in the calendar.");
        return;
      }
      await msg.reply(`Next MGE starts at **${formatUTC(next.start)}**.`);
      return;
    }

    if (cmd === "next_announcement") {
      const next = await getNextAnnouncementTime();
      if (!next) {
        await msg.reply(
          "No upcoming announcements found (based on calendar + current state)."
        );
        return;
      }
      await msg.reply(
        `Next announcement: **${next.text}** at **${formatUTC(next.when)}**.`
      );
      return;
    }

    if (cmd === "announcements_2m") {
      const { items, until } = await getAnnouncementsInNextMonths(2);

      if (!items.length) {
        await msg.reply(
          "No upcoming announcements in the next 2 months (based on calendar + current state)."
        );
        return;
      }

      const header = `Upcoming announcements (UTC) until ${formatUTC(until)}:\n`;
      const lines = items.map(
        (x, i) => `${i + 1}) ${formatUTC(x.when)} — ${x.text}`
      );

      // Chunk replies to stay under Discord limits
      let chunk = header;
      for (const line of lines) {
        if ((chunk + line + "\n").length > 1800) {
          await msg.reply("```" + chunk.trimEnd() + "```");
          chunk = "";
        }
        chunk += line + "\n";
      }
      if (chunk.trim().length) {
        await msg.reply("```" + chunk.trimEnd() + "```");
      }
      return;
    }

    await msg.reply(`Unknown command. Try \`${PREFIX}help\``);
  } catch (e) {
    console.error("Command error:", e);
    try {
      await msg.reply("Error while processing command.");
    } catch {}
  }
});

client.login(DISCORD_TOKEN);



