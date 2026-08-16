#!/usr/bin/env node
/**
 * Sidebrain — zero-dependency personal server.
 * Run: node server.js  (then open http://localhost:4780)
 *
 * Data lives in ./data/db.json, attachments in ./data/uploads/.
 * Optional: set OPENAI_API_KEY to clean up voice-captured text with an LLM.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { writeJsonDurably } = require('./lib/durable-json-store');
const { createPrivateIpcServer } = require('./lib/private-ipc');
const { projectMessageForPwa } = require('./lib/reminder-projection');
const { createTaskService, migrateTaskWriteSchema } = require('./lib/task-service');

const PORT = process.env.PORT || 4780;
const LISTEN_HOST = process.env.SIDEBRAIN_LISTEN_HOST || undefined;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.SIDEBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- database

const DEFAULT_DB = {
  settings: {
    theme: 'dark',          // dark | light
    font: 'courier',        // courier | modern | classic
    compact: false,
    hideTagNav: false,
    groupByTime: true,
    boardColumns: [],       // tag ids used as board columns (2-5)
    openaiKey: '',          // AI key for the Ask tab + voice cleanup (env var wins)
    aiBaseUrl: '',          // optional OpenAI-compatible base URL (Groq, Ollama, ...)
    aiModel: '',            // optional model override
    ntfyTopic: '',          // ntfy.sh topic for free push notifications
    discordWebhook: '',     // Discord webhook URL (alternative push channel)
    telegramToken: '',      // Telegram bot token (alternative push channel)
    telegramChatId: '',     // Telegram chat id for the bot
    digestHour: 8,          // local hour for the daily task digest push (null = off)
  },
  automations: [],// {id, name, prompt, createdAt} — replayable Ask prompts
  circulations: [],// {id, name, prompt, hour, day('daily'|0-6), enabled, lastRun, lastError}
  tags: [],       // {id, name, color, keywords[], parent, createdAt}
  habits: {},     // {'YYYY-MM-DD': {gym, workout, steps, calories, weight}}
  messages: [],   // {id, text, createdAt, pinned, tagIds[], files[], list, checked[], canvas:{on,x,y}}
  reminders: [],  // {id, text, due, done, createdAt}
  taskOperations: [], // durable idempotency records and safe MCP receipts
};

const PUBLIC_SETTING_KEYS = [
  'theme',
  'font',
  'compact',
  'hideTagNav',
  'groupByTime',
  'boardColumns',
  'aiBaseUrl',
  'aiModel',
  'digestHour',
];

const SECRET_SETTING_KEYS = [
  'captureToken',
  'openaiKey',
  'ntfyTopic',
  'discordWebhook',
  'discordBotToken',
  'discordCaptureChannel',
  'telegramToken',
  'telegramChatId',
];

function publicSettings(settings) {
  const safe = {};
  for (const key of PUBLIC_SETTING_KEYS) safe[key] = settings[key];
  for (const key of SECRET_SETTING_KEYS) safe[`${key}Configured`] = !!String(settings[key] || '').trim();
  return safe;
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { ...structuredClone(DEFAULT_DB), ...db, settings: { ...DEFAULT_DB.settings, ...(db.settings || {}) } };
  } catch {
    return structuredClone(DEFAULT_DB);
  }
}

let db = loadDb();
let saveTimer = null;
migrateTaskWriteSchema(db);

if (!db.settings.captureToken) {
  db.settings.captureToken = crypto.randomBytes(16).toString('hex');
}

// migration: task semantics (week planner shows only tasks)
for (const m of db.messages) {
  if (m.task === undefined) m.task = !!m.plannedFor;
  m.done = !!m.done;
}

// purge trash older than 30 days
{
  const cutoff = Date.now() - 30 * 86400000;
  db.messages = db.messages.filter((m) => !m.deletedAt || Date.parse(m.deletedAt) > cutoff);
}

// seed default circulations once (morning briefing absorbs the plain digest)
if (!db.settings.circSeeded) {
  db.settings.circSeeded = true;
  db.circulations.push(
    {
      id: crypto.randomUUID(), name: 'Morning briefing', day: 'daily', hour: 8, enabled: true, lastRun: null, lastError: null,
      prompt: "Morning briefing: list today's tasks (with times) and anything overdue, as a tight list. Then pick one interesting older note from my archive (2+ weeks old), quote it briefly, and say in one line why it might matter today. Do not make any changes to my data.",
    },
    {
      id: crypto.randomUUID(), name: 'Weekly review', day: 0, hour: 18, enabled: true, lastRun: null, lastError: null,
      prompt: 'Weekly review: summarize what I captured this week by theme, list what I completed, and call out tasks that keep slipping (overdue or repeatedly moved). Suggest at most 3 concrete next actions for the coming week. Do not make any changes to my data.',
    },
  );
  if (db.settings.digestHour === 8) db.settings.digestHour = null; // briefing replaces it
}

function persistDbNow(database = db) {
  writeJsonDurably(DB_PATH, database);
}

function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistDbNow(db);
  }, 50);
}

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 220 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Persist data-URL attachments to disk; pass through already-saved files.
function materializeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.slice(0, 10).map((f) => {
    if (f && f.url && !String(f.data || '').startsWith('data:')) {
      return { url: f.url, name: f.name || 'file', type: f.type || '' };
    }
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(f && f.data || '');
    if (!m) return null;
    const type = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 15 * 1024 * 1024) return null; // 15MB cap, like the original
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'image/svg+xml': '.svg' }[type] || '.bin';
    const name = uid() + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return { url: '/uploads/' + name, name: (f.name || name).slice(0, 120), type };
  }).filter(Boolean);
}

// Auto-tag: match "#tagname" tokens (or tag keywords) in the text.
function autoTagIds(text) {
  const found = new Set();
  const lower = String(text || '').toLowerCase();
  const tokens = new Set((lower.match(/#([\p{L}\p{N}_-]+)/gu) || []).map((t) => t.slice(1)));
  for (const tag of db.tags) {
    const names = [tag.name, ...(tag.keywords || [])].map((s) => String(s).toLowerCase().replace(/^#/, ''));
    for (const n of names) {
      if (!n) continue;
      if (tokens.has(n)) { found.add(tag.id); break; }
      // bare trigger word at the very start of the message ("idea buy more RAM")
      if (lower.startsWith(n + ' ')) { found.add(tag.id); break; }
    }
  }
  return [...found];
}

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function createMessage(body) {
  const text = String(body.text || '').trim();
  const files = materializeFiles(body.files);
  if (!text && !files.length) return null;
  const tagIds = [...new Set([...(body.tagIds || []), ...autoTagIds(text)])];
  const tagNames = tagIds.map((id) => (db.tags.find((t) => t.id === id) || {}).name || '').map((n) => n.toLowerCase());
  const msg = {
    id: uid(),
    text,
    createdAt: body.createdAt || new Date().toISOString(),
    pinned: false,
    tagIds,
    files,
    list: !!body.list,
    checked: [],
    // tasks show up in the week planner; a #todo / #task tag marks one automatically
    task: !!body.task || tagNames.includes('todo') || tagNames.includes('task'),
    done: false,
    plannedFor: DAY_RE.test(body.plannedFor || '') ? body.plannedFor : null,
    dueTime: TIME_RE.test(body.dueTime || '') ? body.dueTime : null,
    taskNotified: false,
    parentId: body.parentId && db.messages.some((m) => m.id === body.parentId) ? body.parentId : null,
    canvas: { on: false, x: 40, y: 40 },
  };
  db.messages.unshift(msg);
  saveDb();
  return msg;
}

// AI config: env vars win, then Settings. Base URL/model overrides let this
// point at any OpenAI-compatible API (Groq free tier, local Ollama, ...).
function aiConfig() {
  return {
    key: process.env.OPENAI_API_KEY || String(db.settings.openaiKey || '').trim(),
    base: (process.env.OPENAI_BASE_URL || String(db.settings.aiBaseUrl || '').trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL || String(db.settings.aiModel || '').trim() || 'gpt-4o-mini',
  };
}

// Clean up a raw voice transcription. Uses the AI when a key is present,
// otherwise falls back to light heuristics.
async function cleanupTranscript(text) {
  const raw = String(text || '').trim();
  // Shared links / anything containing a URL is not a transcription — never let
  // the model rewrite it (it tends to reply "I can't open links"). Keep verbatim.
  if (/https?:\/\/\S+/i.test(raw)) return raw;

  const { key, base, model } = aiConfig();
  if (key) {
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: "You clean up voice-note transcriptions. Fix punctuation, casing, and obvious transcription errors; remove filler words (um, uh, like, you know); keep the meaning and wording; never add new content or commentary. When the speaker says 'hashtag X' (or it was transcribed as 'hashtag to-do', 'hash tag idea', etc.), write it as #x — lowercase, no spaces or hyphens (e.g. 'hashtag to-do' becomes #todo). Keep existing #hashtags as-is. Return ONLY the cleaned text, with no preface or explanation." },
            { role: 'user', content: raw },
          ],
        }),
      });
      if (r.ok) {
        const j = await r.json();
        const out = j.choices?.[0]?.message?.content?.trim();
        // guard: if the model replied conversationally (apology / meta) instead
        // of cleaning, discard it and keep the original text
        const refusal = /\b(i'?m sorry|i can'?t|i cannot|as an ai|i'?m unable|provide the (text|voice|note)|please provide|i don'?t have access)\b/i;
        if (out && !refusal.test(out)) return out;
      }
    } catch { /* fall through to heuristics */ }
  }
  let t = raw
    .replace(/\b(u+m+|u+h+|erm+)\b[,.]?\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

// Free push notifications via ntfy.sh: the phone app subscribes to a secret
// topic; we POST to it when a reminder comes due.
async function notifyNtfy(title, body, priority = 'default') {
  const topic = String(db.settings.ntfyTopic || '').trim();
  if (!topic) return false;
  try {
    const r = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
      method: 'POST',
      // header values must stay ASCII (Node fetch rejects non-Latin1) — emoji go in the body
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: 'brain', Priority: priority, Markdown: 'yes' },
      body,
    });
    return r.ok;
  } catch { return false; }
}

async function notifyDiscord(title, body) {
  const url = String(db.settings.discordWebhook || '').trim();
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }),
    });
    return r.ok;
  } catch { return false; }
}

async function deliverDurableDiscordReminder({ title, body }) {
  const url = String(db.settings.discordWebhook || '').trim();
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) {
    throw new Error('Discord reminder delivery is not configured');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `**${title}**\n${body}`.slice(0, 1900),
      allowed_mentions: { parse: [] },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Discord reminder delivery was rejected');
  return { ok: true };
}

async function notifyTelegram(title, body) {
  const token = String(db.settings.telegramToken || '').trim();
  const chat = String(db.settings.telegramChatId || '').trim();
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `${title}\n${body}`.slice(0, 4000) }),
    });
    return r.ok;
  } catch { return false; }
}

// fan out to every configured channel; true if any of them accepted it
async function notifyAll(title, body, priority = 'default') {
  const results = await Promise.all([
    notifyNtfy(title, body, priority),
    notifyDiscord(title, body),
    notifyTelegram(title, body),
  ]);
  return { any: results.some(Boolean), ntfy: results[0], discord: results[1], telegram: results[2] };
}

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- nightly backup

const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function dailyBackup(now) {
  const today = localDay(now);
  if (db.settings.lastBackupDay === today || now.getHours() < 3) return;
  db.settings.lastBackupDay = today;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, `db-${today}.json`), JSON.stringify(db, null, 2));
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of old.slice(0, -14)) fs.unlinkSync(path.join(BACKUP_DIR, f)); // keep last 14
  } catch { /* best effort */ }
  saveDb();
}

// ---------------------------------------------------------------- discord queued capture

// A Discord bot polls a capture channel: anything you message there becomes a
// note. Discord holds messages while this machine is asleep, so nothing is lost.
let discordPolling = false;
async function pollDiscordCapture() {
  const token = String(db.settings.discordBotToken || '').trim();
  const chan = String(db.settings.discordCaptureChannel || '').trim();
  if (!token || !chan || discordPolling) return;
  discordPolling = true;
  try {
    const auth = { Authorization: 'Bot ' + token };
    const last = db.settings.discordLastMsgId;
    if (!last) {
      // first run: baseline 15 minutes back — a test message sent during setup
      // still gets captured, but old channel history doesn't flood in
      const snowflake = ((BigInt(Date.now() - 15 * 60000) - 1420070400000n) << 22n).toString();
      db.settings.discordLastMsgId = snowflake;
      saveDb();
      return;
    }
    const r = await fetch(`https://discord.com/api/v10/channels/${chan}/messages?limit=50&after=${last}`, { headers: auth });
    if (!r.ok) return;
    const msgs = await r.json();
    if (!Array.isArray(msgs) || !msgs.length) return;
    for (const dm of msgs.reverse()) { // oldest first
      db.settings.discordLastMsgId = dm.id;
      const text = String(dm.content || '').trim();
      if (dm.author?.bot || dm.webhook_id || !text) continue;
      const msg = createMessage({ text });
      if (msg && !msg.tagIds.length) await classifyMessage(msg.id);
      fetch(`https://discord.com/api/v10/channels/${chan}/messages/${dm.id}/reactions/${encodeURIComponent('✅')}/@me`, { method: 'PUT', headers: auth }).catch(() => {});
    }
    saveDb();
  } catch { /* transient network errors are fine */ }
  finally { discordPolling = false; }
}
setInterval(pollDiscordCapture, 45000);

// ---------------------------------------------------------------- circulations (scheduled AI runs)

function runCirculations(now) {
  const today = localDay(now);
  for (const c of db.circulations) {
    if (!c.enabled || c.lastRun === today) continue;
    if (now.getHours() !== c.hour) continue;
    if (c.day === 'monthly' ? now.getDate() !== 1 : (c.day !== 'daily' && Number(c.day) !== now.getDay())) continue;
    c.lastRun = today;
    saveDb();
    runAgentTurn([{ role: 'user', content: c.prompt }])
      .then(({ reply, actions }) => {
        c.lastError = null;
        saveDb();
        const body = reply + (actions.length ? '\n\nChanges:\n' + actions.map((a) => '- ' + a).join('\n') : '');
        notifyAll(c.name, body.slice(0, 3500), 'high');
      })
      .catch((e) => {
        c.lastError = String(e.message || e).slice(0, 200);
        saveDb();
      });
  }
}

function anyChannelConfigured() {
  return !!(String(db.settings.ntfyTopic || '').trim() ||
    String(db.settings.discordWebhook || '').trim() ||
    (String(db.settings.telegramToken || '').trim() && String(db.settings.telegramChatId || '').trim()));
}

setInterval(() => {
  const now = new Date();
  dailyBackup(now);
  runCirculations(now);
  if (!anyChannelConfigured()) return;

  // exact-time reminder pushes
  for (const r of db.reminders) {
    if (r.channel === 'discord' && r.state) continue;
    if (r.done || r.notified) continue;
    if (Date.parse(r.due) <= now.getTime()) {
      r.notified = true;
      saveDb();
      notifyAll('Sidebrain reminder', r.text, 'high');
    }
  }

  // exact-time task pushes (tasks with a due time; "YYYY-MM-DDTHH:MM" parses as local time)
  for (const m of db.messages) {
    if (m.deletedAt || !m.task || m.done || m.taskNotified || !m.plannedFor || !m.dueTime) continue;
    const t = Date.parse(`${m.plannedFor}T${m.dueTime}`);
    if (!isNaN(t) && t <= now.getTime()) {
      m.taskNotified = true;
      saveDb();
      notifyAll('Task due', m.text.split('\n')[0].slice(0, 140), 'high');
    }
  }

  // morning digest: today's + overdue tasks from the week planner
  const dh = db.settings.digestHour;
  const today = localDay(now);
  if (Number.isInteger(dh) && now.getHours() === dh && db.settings.lastDigestDay !== today) {
    db.settings.lastDigestDay = today;
    saveDb();
    const open = db.messages.filter((m) => !m.deletedAt && m.task && !m.done && m.plannedFor && m.plannedFor <= today);
    if (open.length) {
      const line = (m) => '- ' + m.text.split('\n')[0].slice(0, 80) + (m.dueTime ? ` @ ${m.dueTime}` : '');
      const todays = open.filter((m) => m.plannedFor === today);
      const overdue = open.filter((m) => m.plannedFor < today);
      const title = `Today: ${todays.length} task${todays.length === 1 ? '' : 's'}` +
        (overdue.length ? ` (+${overdue.length} overdue)` : '');
      const body = [...todays.map(line), ...overdue.map((m) => line(m) + ' (overdue)')].join('\n');
      notifyAll(title, body, 'high');
    }
  }
}, 30000);

// ---------------------------------------------------------------- ask (AI chat)

const TAG_COLOR_KEYS = ['sky', 'green', 'amber', 'red', 'rose', 'teal', 'orange', 'cyan', 'lime', 'fuchsia', 'slate', 'rose2', 'peach', 'lavender'];

function tagByNameOrCreate(name) {
  const clean = String(name || '').trim().replace(/^#/, '');
  if (!clean) return null;
  let tag = db.tags.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (!tag) {
    tag = { id: uid(), name: clean, color: TAG_COLOR_KEYS[db.tags.length % TAG_COLOR_KEYS.length], keywords: [], parent: null, createdAt: new Date().toISOString() };
    db.tags.push(tag);
  }
  return tag;
}

const CHAT_TOOLS = [
  { type: 'function', function: { name: 'update_note', description: 'Update fields on an existing note or task. Only pass fields you want to change.', parameters: { type: 'object', properties: {
    id: { type: 'string', description: 'note id from the snapshot' },
    text: { type: 'string' },
    pinned: { type: 'boolean' },
    task: { type: 'boolean', description: 'true = shows in week planner' },
    done: { type: 'boolean' },
    plannedFor: { type: ['string', 'null'], description: 'due date YYYY-MM-DD, or null to clear' },
    dueTime: { type: ['string', 'null'], description: 'due time HH:MM (24h), or null to clear' },
    tagNames: { type: 'array', items: { type: 'string' }, description: 'replace tags with these names (missing tags are created)' },
  }, required: ['id'] } } },
  { type: 'function', function: { name: 'create_note', description: 'Create a new note or task in the feed.', parameters: { type: 'object', properties: {
    text: { type: 'string' },
    task: { type: 'boolean' },
    plannedFor: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    dueTime: { type: ['string', 'null'], description: 'HH:MM 24h' },
    tagNames: { type: 'array', items: { type: 'string' } },
    parentId: { type: ['string', 'null'], description: 'id of the note/task this follows from (creates a tracked lineage)' },
  }, required: ['text'] } } },
  { type: 'function', function: { name: 'log_habit', description: "Log or update the user's daily habit record (gym, workout type, steps, calories burnt, weight). Only pass fields mentioned.", parameters: { type: 'object', properties: {
    date: { type: 'string', description: 'YYYY-MM-DD, default today' },
    gym: { type: 'boolean' },
    workout: { type: 'string', description: 'push | pull | legs | upper | lower | other' },
    steps: { type: 'number' },
    calories: { type: 'number' },
    weight: { type: 'number' },
  } } } },
  { type: 'function', function: { name: 'delete_note', description: 'Permanently delete a note. Only when the user clearly asked for deletion.', parameters: { type: 'object', properties: {
    id: { type: 'string' },
  }, required: ['id'] } } },
  { type: 'function', function: { name: 'create_reminder', description: 'Create a reminder that pushes a notification at an exact time.', parameters: { type: 'object', properties: {
    text: { type: 'string' },
    due: { type: 'string', description: 'local datetime YYYY-MM-DDTHH:MM' },
  }, required: ['text', 'due'] } } },
];

function applyChatTool(name, args) {
  const brief = (t) => String(t || '').split('\n')[0].slice(0, 60);
  if (name === 'log_habit') {
    const day = DAY_RE.test(args.date || '') ? args.date : localDay();
    const h = (db.habits[day] ||= {});
    if ('gym' in args) h.gym = !!args.gym;
    if ('workout' in args) h.workout = String(args.workout || '').toLowerCase().slice(0, 20) || null;
    for (const k of ['steps', 'calories', 'weight']) if (k in args && !isNaN(+args[k])) h[k] = +args[k];
    saveDb();
    return { ok: true, summary: `logged habits for ${day}` };
  }
  if (name === 'create_note') {
    const parent = args.parentId ? db.messages.find((m) => m.id === args.parentId || m.id.startsWith(args.parentId)) : null;
    const msg = createMessage({ text: args.text, task: !!args.task, plannedFor: args.plannedFor || undefined, dueTime: args.dueTime || undefined, parentId: parent ? parent.id : undefined });
    if (!msg) return { ok: false, error: 'empty text' };
    if (Array.isArray(args.tagNames) && args.tagNames.length) {
      msg.tagIds = [...new Set(args.tagNames.map((n) => tagByNameOrCreate(n)).filter(Boolean).map((t) => t.id))];
    }
    if (args.dueTime && TIME_RE.test(args.dueTime)) msg.dueTime = args.dueTime;
    saveDb();
    return { ok: true, id: msg.id, summary: `created "${brief(msg.text)}"` };
  }
  // snapshot ids are truncated to 8 chars — match by prefix
  const msg = db.messages.find((m) => m.id === args.id || m.id.startsWith(String(args.id || '')));
  if (name === 'delete_note') {
    if (!msg) return { ok: false, error: 'not found' };
    msg.deletedAt = new Date().toISOString(); // AI deletions go to trash too
    saveDb();
    return { ok: true, summary: `moved "${brief(msg.text)}" to trash` };
  }
  if (name === 'update_note') {
    if (!msg) return { ok: false, error: 'not found' };
    const changed = [];
    if ('text' in args && args.text) { msg.text = String(args.text); changed.push('text'); }
    for (const k of ['pinned', 'task']) if (k in args) { msg[k] = !!args[k]; changed.push(k + (args[k] ? '' : ' off')); }
    if ('plannedFor' in args) { msg.plannedFor = DAY_RE.test(args.plannedFor || '') ? args.plannedFor : null; msg.taskNotified = false; if (msg.plannedFor) msg.task = true; changed.push('due ' + (msg.plannedFor || 'cleared')); }
    if ('dueTime' in args) { msg.dueTime = TIME_RE.test(args.dueTime || '') ? args.dueTime : null; msg.taskNotified = false; if (msg.dueTime) changed.push('at ' + msg.dueTime); }
    if (Array.isArray(args.tagNames)) { msg.tagIds = [...new Set(args.tagNames.map((n) => tagByNameOrCreate(n)).filter(Boolean).map((t) => t.id))]; changed.push('tags'); }
    if ('done' in args) {
      if (msg.task) {
        taskService.setTaskCompletion({
          idempotencyKey: `pwa:${uid()}`,
          origin: 'pwa',
          taskId: msg.id,
          completed: !!args.done,
        });
      } else {
        msg.done = !!args.done;
      }
      changed.push('done' + (args.done ? '' : ' off'));
    }
    saveDb();
    const updated = db.messages.find((message) => message.id === msg.id) || msg;
    return { ok: true, summary: `updated "${brief(updated.text)}" (${changed.join(', ')})` };
  }
  if (name === 'create_reminder') {
    const t = Date.parse(args.due);
    if (!args.text || isNaN(t)) return { ok: false, error: 'need text and a valid due datetime' };
    const rem = { id: uid(), text: String(args.text), due: new Date(t).toISOString(), done: false, createdAt: new Date().toISOString() };
    db.reminders.push(rem);
    saveDb();
    return { ok: true, summary: `reminder "${brief(rem.text)}" at ${args.due}` };
  }
  return { ok: false, error: 'unknown tool' };
}

// ---------------------------------------------------------------- embeddings (semantic memory)

const EMB_PATH = path.join(DATA_DIR, 'embeddings.json');
let EMB = {};
try { EMB = JSON.parse(fs.readFileSync(EMB_PATH, 'utf8')); } catch { EMB = {}; }
let embSaveTimer = null;
function saveEmb() {
  clearTimeout(embSaveTimer);
  embSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(EMB_PATH, JSON.stringify(EMB)); } catch {}
  }, 300);
}
function invalidateEmbedding(id) { delete EMB[id]; saveEmb(); }

async function embedTexts(texts) {
  const { key, base } = aiConfig();
  if (!key) return null;
  const r = await fetch(base + '/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'text-embedding-3-small', dimensions: 256, input: texts.map((t) => t.slice(0, 2000)) }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.data || []).map((d) => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function similarTo(vec, excludeId, limit = 5, floor = 0.35) {
  const out = [];
  for (const m of db.messages) {
    if (m.id === excludeId || m.deletedAt || !EMB[m.id]) continue;
    const s = cosine(vec, EMB[m.id]);
    if (s >= floor) out.push({ id: m.id, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// backfill loop: embed new/edited notes in batches; flag déjà vu on fresh ones
let embedding = false;
async function backfillEmbeddings() {
  if (embedding || !aiConfig().key) return;
  const todo = db.messages.filter((m) => !m.deletedAt && m.text && !EMB[m.id]).slice(0, 40);
  if (!todo.length) return;
  embedding = true;
  try {
    const vecs = await embedTexts(todo.map((m) => m.text));
    if (vecs) {
      todo.forEach((m, i) => {
        if (!vecs[i]) return;
        EMB[m.id] = vecs[i];
        // déjà vu: notes younger than a day get flagged if old thoughts match closely
        if (Date.now() - Date.parse(m.createdAt) < 86400000 && m.similarTo === undefined) {
          const sims = similarTo(vecs[i], m.id, 3, 0.6)
            .filter((s) => { const o = db.messages.find((x) => x.id === s.id); return o && o.createdAt < m.createdAt; });
          m.similarTo = sims.map((s) => s.id);
        }
      });
      saveEmb();
      saveDb();
    }
  } catch { /* transient */ }
  finally { embedding = false; }
}
setInterval(backfillEmbeddings, 45000);
setTimeout(backfillEmbeddings, 4000); // one pass shortly after boot

// Auto-classify a freshly captured note that arrived with no tags: pick tags,
// decide if it's a task, and pull out any due date/time implied by the text.
// Only fills gaps — never overrides tags/task/due values that already exist.
async function classifyMessage(msgId) {
  const { key, base, model } = aiConfig();
  if (!key) return;
  const snapshotText = (db.messages.find((m) => m.id === msgId) || {}).text;
  if (!snapshotText) return;
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: `You classify captured notes for a personal notes app. Now: ${new Date().toString()}. Existing tags: ${db.tags.map((t) => t.name).join(', ') || '(none yet)'}.
Reply with ONLY a JSON object, no prose, shaped exactly like:
{"tags": string[], "task": boolean, "plannedFor": "YYYY-MM-DD" | null, "dueTime": "HH:MM" | null}
Rules: 0-2 tags; STRONGLY prefer existing tags; at most one new tag (single lowercase word) and only when clearly useful; task=true only for actionable to-dos; plannedFor/dueTime only when the text clearly implies a date/time (resolve relative words like "tomorrow" or "friday evening" using Now); otherwise null.` },
          { role: 'user', content: snapshotText.slice(0, 600) },
        ],
      }),
    });
    if (!r.ok) return;
    const j = await r.json();
    const raw = j.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const c = JSON.parse(jsonMatch[0]);

    const live = db.messages.find((m) => m.id === msgId); // may have been edited or deleted meanwhile
    if (!live) return;
    if (!live.tagIds.length && Array.isArray(c.tags)) {
      live.tagIds = [...new Set(c.tags.slice(0, 2).map((n) => tagByNameOrCreate(n)).filter(Boolean).map((t) => t.id))];
    }
    if (c.task === true) live.task = true;
    if (!live.plannedFor && DAY_RE.test(c.plannedFor || '')) { live.plannedFor = c.plannedFor; live.task = true; }
    if (!live.dueTime && live.plannedFor && TIME_RE.test(c.dueTime || '')) live.dueTime = c.dueTime;
    saveDb();
  } catch { /* classification is best-effort */ }
}

function chatSystemPrompt() {
  const tagName = (id) => (db.tags.find((t) => t.id === id) || {}).name;
  const lines = [...db.messages]
    .filter((m) => !m.deletedAt)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 250)
    .map((m) => {
      const kind = m.task ? (m.done ? 'task✓' : 'task') : 'note';
      const due = m.plannedFor ? ` due:${m.plannedFor}${m.dueTime ? ' ' + m.dueTime : ''}` : '';
      const tags = m.tagIds.map(tagName).filter(Boolean).join(',');
      return `${m.id.slice(0, 8)} | ${m.createdAt.slice(0, 10)} | ${kind}${m.pinned ? ' pin' : ''}${due}${tags ? ' #' + tags : ''} | ${m.text.replace(/\n/g, ' ').slice(0, 160)}`;
    });
  const rems = db.reminders.filter((r) => !r.done).map((r) => `- ${r.text} @ ${r.due}`);
  const now = new Date();
  return `You are Sidebrain's assistant. Sidebrain is the user's private feed of notes, tasks (with optional due date/time), tags, and reminders.
Now: ${now.toString()}.
You can answer questions about the data and modify it with the tools. Note ids below are truncated to 8 chars — pass those ids to tools (they are matched by prefix). Prefer acting over asking when the request is clear; for bulk deletions, confirm first. Keep replies short and concrete. Use the user's timezone for all dates.

NOTES (newest first: id | created | kind | text):
${lines.join('\n') || '(none yet)'}

OPEN REMINDERS:
${rems.join('\n') || '(none)'}

TAGS: ${db.tags.map((t) => t.name).join(', ') || '(none)'}

HABITS (last 14 days — day | gym/workout | steps | calories | weight):
${Object.entries(db.habits).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)
  .map(([d, h]) => `${d} | ${h.gym ? 'gym:' + (h.workout || 'yes') : 'no gym'} | ${h.steps ?? '-'} | ${h.calories ?? '-'} | ${h.weight ?? '-'}`)
  .join('\n') || '(none logged yet)'}`;
}

// One streamed chat-completions call: returns the assembled assistant message,
// forwarding content deltas to onEvent as they arrive.
async function streamCompletion({ key, base, model, msgs, onEvent }) {
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: msgs, tools: CHAT_TOOLS, tool_choice: 'auto', temperature: 0.3, stream: true }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`AI request failed (${r.status}): ${t.slice(0, 300)}`);
  }
  const message = { role: 'assistant', content: '', tool_calls: [] };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // keep the trailing partial line
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim();
      if (!data || !line.startsWith('data:') || data === '[DONE]') continue;
      let delta;
      try { delta = JSON.parse(data).choices?.[0]?.delta; } catch { continue; }
      if (!delta) continue;
      if (delta.content) {
        message.content += delta.content;
        if (onEvent) onEvent({ delta: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (message.tool_calls[tc.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }
  if (!message.tool_calls.length) delete message.tool_calls;
  return message;
}

// One full agent turn: system prompt + history → (tool calls → apply)* → reply.
// Used by the Ask tab (streaming via onEvent) and by circulations. Throws on failure.
async function runAgentTurn(history, onEvent) {
  const { key, base, model } = aiConfig();
  if (!key) {
    const err = new Error('No AI key configured. Open Settings → AI assistant and paste an OpenAI API key (or a Groq key with its base URL).');
    err.statusCode = 400;
    throw err;
  }
  const msgs = [{ role: 'system', content: chatSystemPrompt() }, ...history];
  const actions = [];
  for (let step = 0; step < 6; step++) {
    const msg = await streamCompletion({ key, base, model, msgs, onEvent });
    msgs.push(msg);
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let out;
        try { out = applyChatTool(tc.function.name, JSON.parse(tc.function.arguments || '{}')); }
        catch (e) { out = { ok: false, error: String(e.message || e) }; }
        if (out.summary) {
          actions.push(out.summary);
          if (onEvent) onEvent({ action: out.summary });
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
      }
      continue;
    }
    return { reply: msg.content || '', actions };
  }
  return { reply: 'I stopped after several steps — the changes so far are listed below.', actions };
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fetchTitle(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    if (!/^https?:$/.test(u.protocol)) return resolve(null);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: 5000, headers: { 'user-agent': 'Mozilla/5.0 MindChukLocal' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchTitle(new URL(res.headers.location, u).href).then(resolve);
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { html += c; if (html.length > 200000) { req.destroy(); } });
      res.on('end', () => {
        const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
        resolve(m ? m[1].trim().slice(0, 200) : null);
      });
      res.on('close', () => {
        const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
        resolve(m ? m[1].trim().slice(0, 200) : null);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------- api

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', resource, id?]
  const resource = parts[1];
  const id = parts[2];
  const method = req.method;

  // ---- state
  if (resource === 'state' && method === 'GET') {
    const ip = lanIp();
    const { taskOperations: _taskOperations, ...applicationState } = db;
    const legacyReminders = db.reminders.filter((reminder) => !(reminder.channel === 'discord' && reminder.state));
    return send(res, 200, {
      ...applicationState,
      messages: db.messages.map((message) => projectMessageForPwa(db, message)),
      reminders: legacyReminders,
      settings: publicSettings(db.settings),
      meta: { lanUrl: ip ? `http://${ip}:${PORT}` : null },
    });
  }

  // ---- voice / external capture (Apple Shortcuts etc.)
  if (resource === 'capture' && method === 'POST') {
    const captureUrl = new URL(req.url, 'http://x');
    if (captureUrl.searchParams.has('token')) {
      return send(res, 400, { error: 'capture token must be sent in the Authorization header' });
    }
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth !== db.settings.captureToken) return send(res, 401, { error: 'invalid capture token' });
    const body = await readBody(req);
    const raw = String(body.text || '').trim();
    if (!raw) return send(res, 400, { error: 'text required' });
    const text = body.raw ? raw : await cleanupTranscript(raw);
    const msg = createMessage({ ...body, text });
    if (!msg) return send(res, 400, { error: 'empty message' });
    // voice notes that arrived untagged get AI classification (awaited so the
    // Shortcut response already carries the tags)
    if (!msg.tagIds.length && msg.text) await classifyMessage(msg.id);
    return send(res, 201, db.messages.find((m) => m.id === msg.id) || msg);
  }

  // ---- settings
  if (resource === 'settings' && method === 'PATCH') {
    const body = await readBody(req);
    db.settings = { ...db.settings, ...body };
    saveDb();
    return send(res, 200, publicSettings(db.settings));
  }

  // ---- messages
  if (resource === 'messages') {
    if (method === 'POST') {
      const body = await readBody(req);
      const msg = createMessage(body);
      if (!msg) return send(res, 400, { error: 'empty message' });
      // composer stays snappy: classify untagged notes in the background
      if (!msg.tagIds.length && msg.text) classifyMessage(msg.id);
      return send(res, 201, msg);
    }
    if (method === 'PATCH' && id) {
      let msg = db.messages.find((m) => m.id === id);
      if (!msg) return send(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if ('text' in body) {
        msg.text = String(body.text);
        msg.tagIds = [...new Set([...(body.tagIds || msg.tagIds), ...autoTagIds(msg.text)])];
        invalidateEmbedding(msg.id); // re-embed edited text
        delete msg.similarTo;
      }
      if ('parentId' in body) msg.parentId = body.parentId && db.messages.some((m) => m.id === body.parentId) ? body.parentId : null;
      if ('tagIds' in body) msg.tagIds = [...new Set(body.tagIds)];
      for (const k of ['pinned', 'list', 'checked', 'canvas', 'task']) if (k in body) msg[k] = body[k];
      if ('done' in body) {
        if (msg.task) {
          taskService.setTaskCompletion({
            idempotencyKey: `pwa:${uid()}`,
            origin: 'pwa',
            taskId: msg.id,
            completed: !!body.done,
          });
          msg = db.messages.find((message) => message.id === id);
        } else {
          msg.done = body.done;
        }
      }
      if (body.restore) msg.deletedAt = null;
      if ('plannedFor' in body) msg.plannedFor = DAY_RE.test(body.plannedFor || '') ? body.plannedFor : null;
      if ('dueTime' in body) msg.dueTime = TIME_RE.test(body.dueTime || '') ? body.dueTime : null;
      // rescheduling re-arms the exact-time push
      if ('plannedFor' in body || 'dueTime' in body) msg.taskNotified = false;
      if ('files' in body) msg.files = materializeFiles(body.files);
      saveDb();
      return send(res, 200, projectMessageForPwa(db, msg));
    }
    if (method === 'DELETE' && id) {
      const msg = db.messages.find((m) => m.id === id);
      if (msg && !msg.deletedAt) {
        msg.deletedAt = new Date().toISOString(); // soft delete → trash (30 days)
      } else {
        db.messages = db.messages.filter((m) => m.id !== id); // second delete = forever
        invalidateEmbedding(id);
      }
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // ---- tags
  if (resource === 'tags') {
    if (method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/^#/, '');
      if (!name) return send(res, 400, { error: 'name required' });
      if (db.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        return send(res, 409, { error: 'Tag name already exists.' });
      }
      const tag = {
        id: uid(),
        name,
        color: body.color || 'sky',
        keywords: (body.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 10),
        parent: body.parent || null,
        createdAt: new Date().toISOString(),
      };
      db.tags.push(tag);
      saveDb();
      return send(res, 201, tag);
    }
    if (method === 'PATCH' && id) {
      const tag = db.tags.find((t) => t.id === id);
      if (!tag) return send(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if ('name' in body) tag.name = String(body.name).trim().replace(/^#/, '') || tag.name;
      if ('color' in body) tag.color = body.color;
      if ('keywords' in body) tag.keywords = (body.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 10);
      if ('parent' in body) tag.parent = body.parent || null;
      saveDb();
      return send(res, 200, tag);
    }
    if (method === 'DELETE' && id) {
      db.tags = db.tags.filter((t) => t.id !== id);
      db.tags.forEach((t) => { if (t.parent === id) t.parent = null; });
      db.messages.forEach((m) => { m.tagIds = m.tagIds.filter((tid) => tid !== id); });
      db.settings.boardColumns = (db.settings.boardColumns || []).filter((tid) => tid !== id);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // ---- reminders
  if (resource === 'reminders') {
    if (method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'Reminder text is required.' });
      if (!body.due || isNaN(Date.parse(body.due))) return send(res, 400, { error: 'Fill in all date and time fields.' });
      const rem = { id: uid(), text, due: body.due, done: false, createdAt: new Date().toISOString() };
      db.reminders.push(rem);
      saveDb();
      return send(res, 201, rem);
    }
    if (method === 'PATCH' && id) {
      const rem = db.reminders.find((r) => r.id === id);
      if (!rem) return send(res, 404, { error: 'not found' });
      const body = await readBody(req);
      for (const k of ['text', 'due', 'done']) if (k in body) rem[k] = body[k];
      saveDb();
      return send(res, 200, rem);
    }
    if (method === 'DELETE' && id) {
      db.reminders = db.reminders.filter((r) => r.id !== id);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // ---- csv export
  if (resource === 'export.csv' && method === 'GET') {
    const tagName = (tid) => (db.tags.find((t) => t.id === tid) || {}).name || '';
    const rows = [['created_at', 'text', 'tags', 'pinned', 'attachments']];
    for (const m of db.messages.filter((x) => !x.deletedAt)) {
      rows.push([m.createdAt, m.text, m.tagIds.map(tagName).filter(Boolean).join('; '), m.pinned ? 'yes' : 'no', (m.files || []).map((f) => f.name).join('; ')]);
    }
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sidebrain-export.csv"',
    });
    return res.end(csv);
  }

  // ---- semantic search + related notes (embeddings)
  if (resource === 'semantic-search' && method === 'POST') {
    const body = await readBody(req);
    const q = String(body.q || '').trim();
    if (!q || !aiConfig().key) return send(res, 200, { results: [] });
    const [vec] = (await embedTexts([q])) || [];
    if (!vec) return send(res, 200, { results: [] });
    return send(res, 200, { results: similarTo(vec, null, 15, 0.28) });
  }
  if (resource === 'related' && method === 'GET' && id) {
    let vec = EMB[id];
    if (!vec) {
      const m = db.messages.find((x) => x.id === id);
      if (m && m.text && aiConfig().key) {
        [vec] = (await embedTexts([m.text])) || [];
        if (vec) { EMB[id] = vec; saveEmb(); }
      }
    }
    if (!vec) return send(res, 200, { related: [] });
    const rel = similarTo(vec, id, 4, 0.35).map((s) => {
      const m = db.messages.find((x) => x.id === s.id);
      return { id: s.id, score: Math.round(s.score * 100) / 100, preview: m.text.split('\n')[0].slice(0, 90), createdAt: m.createdAt };
    });
    return send(res, 200, { related: rel });
  }

  // ---- habits: one merged record per day
  if (resource === 'habits' && method === 'PATCH' && id) {
    if (!DAY_RE.test(id)) return send(res, 400, { error: 'bad day' });
    const body = await readBody(req);
    const h = (db.habits[id] ||= {});
    if ('gym' in body) h.gym = !!body.gym;
    if ('workout' in body) h.workout = String(body.workout || '').slice(0, 20) || null;
    for (const k of ['steps', 'calories', 'weight']) {
      if (k in body) {
        const v = parseFloat(body[k]);
        h[k] = isNaN(v) ? null : v;
      }
    }
    saveDb();
    return send(res, 200, { day: id, ...h });
  }

  // ---- automations: saved Ask prompts, replayable with one tap
  if (resource === 'automations') {
    if (method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 60);
      const prompt = String(body.prompt || '').trim().slice(0, 2000);
      if (!name || !prompt) return send(res, 400, { error: 'name and prompt required' });
      const auto = { id: uid(), name, prompt, createdAt: new Date().toISOString() };
      db.automations.push(auto);
      saveDb();
      return send(res, 201, auto);
    }
    if (method === 'DELETE' && id) {
      db.automations = db.automations.filter((a) => a.id !== id);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // ---- ask: AI chat over the app's data, with tool-calling for edits
  if (resource === 'chat' && method === 'POST') {
    const body = await readBody(req);
    const history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-16);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        const result = await runAgentTurn(history, emit);
        emit({ done: true, reply: result.reply, actions: result.actions });
      } catch (e) {
        emit({ error: String(e.message || e) });
      }
      return res.end();
    }
    try {
      const result = await runAgentTurn(history);
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.statusCode || 502, { error: String(e.message || e) });
    }
  }

  // ---- circulations: scheduled AI runs
  if (resource === 'circulations') {
    if (method === 'POST') {
      const body = await readBody(req);
      const c = {
        id: uid(),
        name: String(body.name || '').trim().slice(0, 60) || 'Untitled',
        prompt: String(body.prompt || '').trim().slice(0, 3000),
        hour: Math.max(0, Math.min(23, +body.hour || 8)),
        day: body.day === 'daily' || body.day === 'monthly' ? body.day : Math.max(0, Math.min(6, +body.day || 0)),
        enabled: body.enabled !== false,
        lastRun: null,
        lastError: null,
      };
      if (!c.prompt) return send(res, 400, { error: 'prompt required' });
      db.circulations.push(c);
      saveDb();
      return send(res, 201, c);
    }
    if (method === 'PATCH' && id) {
      const c = db.circulations.find((x) => x.id === id);
      if (!c) return send(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if ('name' in body) c.name = String(body.name).trim().slice(0, 60) || c.name;
      if ('prompt' in body) c.prompt = String(body.prompt).trim().slice(0, 3000) || c.prompt;
      if ('hour' in body) c.hour = Math.max(0, Math.min(23, +body.hour || 0));
      if ('day' in body) c.day = body.day === 'daily' || body.day === 'monthly' ? body.day : Math.max(0, Math.min(6, +body.day || 0));
      if ('enabled' in body) c.enabled = !!body.enabled;
      saveDb();
      return send(res, 200, c);
    }
    if (method === 'DELETE' && id) {
      db.circulations = db.circulations.filter((x) => x.id !== id);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // ---- ntfy: save topic + send a test push
  if (resource === 'ntfy-test' && method === 'POST') {
    const body = await readBody(req);
    if ('topic' in body) db.settings.ntfyTopic = String(body.topic || '').trim();
    if ('discordWebhook' in body) db.settings.discordWebhook = String(body.discordWebhook || '').trim();
    if ('telegramToken' in body) db.settings.telegramToken = String(body.telegramToken || '').trim();
    if ('telegramChatId' in body) db.settings.telegramChatId = String(body.telegramChatId || '').trim();
    saveDb();
    const result = await notifyAll('Sidebrain connected', 'Push notifications are working ✓ Reminders will arrive here.');
    return send(res, 200, { ok: result.any, channels: result });
  }

  // ---- link title lookup
  if (resource === 'link-title' && method === 'POST') {
    const body = await readBody(req);
    const title = await fetchTitle(body.url);
    return send(res, 200, { title });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- static

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, '404 Not Found', 'text/plain');
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // app code must revalidate every load or iOS PWAs serve stale versions;
    // uploaded media is immutable and can cache hard
    const cache = filePath.startsWith(UPLOAD_DIR)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);

    if (pathname.startsWith('/uploads/')) {
      const file = path.normalize(path.join(UPLOAD_DIR, pathname.slice('/uploads/'.length)));
      if (!file.startsWith(UPLOAD_DIR)) return send(res, 403, 'forbidden', 'text/plain');
      return serveFile(res, file);
    }

    let rel = pathname === '/' ? '/index.html' : pathname === '/app' ? '/app.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden', 'text/plain');
    return serveFile(res, file);
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

const ipcNow = process.env.NODE_ENV === 'test' && process.env.SIDEBRAIN_MCP_TEST_NOW
  ? () => new Date(process.env.SIDEBRAIN_MCP_TEST_NOW)
  : () => new Date();
const taskService = createTaskService({
  getDatabase: () => db,
  replaceDatabase: (next) => { db = next; },
  persistDatabase: persistDbNow,
  deliverDiscord: deliverDurableDiscordReminder,
  now: ipcNow,
});
const privateIpc = createPrivateIpcServer({ getDatabase: () => db, taskService, now: ipcNow });
let reminderTimer = null;

async function start() {
  await privateIpc.start();
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(PORT, LISTEN_HOST);
    });
  } catch (error) {
    await privateIpc.close();
    throw error;
  }

  const ip = lanIp();
  const activePort = server.address().port;
  console.log(`\n  Sidebrain — for minds that never turn off`);
  console.log(`  ➜  http://localhost:${activePort}         (landing page)`);
  console.log(`  ➜  http://localhost:${activePort}/app     (your feed)`);
  if (ip && !LISTEN_HOST) console.log(`  ➜  http://${ip}:${activePort}/app   (phone, same Wi-Fi)`);
  console.log(`  ➜  private MCP IPC: ready`);
  console.log(`  ➜  voice capture: Bearer token required at POST /api/capture`);
  console.log(`  ➜  voice cleanup: ${process.env.OPENAI_API_KEY ? 'OpenAI (' + (process.env.OPENAI_MODEL || 'gpt-4o-mini') + ')' : 'heuristic (set OPENAI_API_KEY for LLM cleanup)'}\n`);
  saveDb(); // persist a freshly generated capture token
  reminderTimer = setInterval(() => {
    taskService.runReminderCycle().catch(() => console.error('Sidebrain reminder cycle failed'));
  }, 15_000);
  taskService.runReminderCycle().catch(() => console.error('Sidebrain reminder recovery failed'));
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (reminderTimer) clearInterval(reminderTimer);
  clearTimeout(saveTimer);
  persistDbNow(db);
  await new Promise((resolve) => server.listening ? server.close(resolve) : resolve());
  await privateIpc.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stop().then(() => process.exit(0), (error) => {
      console.error(`Sidebrain shutdown failed: ${String(error.message || error)}`);
      process.exit(1);
    });
  });
}

start().catch((error) => {
  console.error(`Sidebrain startup failed: ${String(error.message || error)}`);
  process.exit(1);
});
