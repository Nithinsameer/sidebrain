# Sidebrain

Your brain, on the side. A fully local, self-hosted personal feed inspired by MindChuk — send it anything: ideas, notes, links, images, to-dos. Searchable, tagged, organized forever. Everything stays on your machine.

Zero dependencies. No build step. No accounts.

## Run it

```bash
node server.js
```

Then open:

- **http://localhost:4780** — landing page
- **http://localhost:4780/app** — your feed

Use a different port with `PORT=5000 node server.js`. The startup log prints your LAN URL for phone and tablet access. Stored credentials, including the Apple Shortcut capture token, are not printed or returned by the API.

## Where your data lives

| What | Where |
|---|---|
| Notes, tags, reminders, settings | `data/db.json` |
| Image / PDF attachments | `data/uploads/` |

Back up the `data/` folder and you've backed up everything. Settings also has one-click CSV export.

## Features

**Capture**
- Composer with `⌘+Enter` to send, image/PDF attach (10 files, 15MB each), paste-an-image
- **Hashtag triggers** — a tag named `idea` auto-tags any note containing `#idea`, starting with the bare word, or matching the tag's extra keywords
- **Voice capture** from Apple Shortcuts via `POST /api/capture` (see below)
- Link previews with locally fetched page titles

**Organize**
- Tags with 14 colors + trigger keywords; filter bar with counts
- Search by text or date with fuzzy matching (`/` focuses search); calendar button next to search filters by **created date or due date**
- Pin, copy, edit, delete; to-do checklists; reminders with due nudges

**AI (optional — one key in Settings → AI assistant)**
- **Ask tab**: chat over your actual data; it can also act — edit tasks, move due dates, retag, create notes/reminders — via tool calls, with ✓ receipts for every change
- **Voice cleanup**: transcriptions get LLM-cleaned before saving
- **Auto-classification**: notes captured *without* tags get tags, a task flag, and any due date/time implied by the text ("pay rent friday evening" → task, Friday, 18:00). Explicit tags/dates are never overridden.
- Works with any OpenAI-compatible API: OpenAI `gpt-4o-mini` (~pennies), Groq free tier (`https://api.groq.com/openai/v1`), or local Ollama (`http://localhost:11434/v1`)

**Tasks vs notes**
- A note becomes a **task** when: you add it from the week planner, tag it `#todo` / `#task`, or hit the calendar-check action on its card
- Tasks render with a checkbox everywhere; checking one marks it done (strikethrough)
- Tasks can carry a **due date** (`plannedFor`), shown as a "Due …" chip on the card

**Views**
- **Feed** — full-width Google-Keep-style masonry card dump: pinned cards first, then newest first — no sections
- **Board** — pick 2–5 tags as kanban columns, drag cards to retag
- **Week** — TeuxDeux-style planner, **tasks only**: 7 day-columns plus an **Inbox** strip underneath for tasks without a due date. Quick-add into any day or the Inbox; drag Inbox → day to schedule (drag back to Inbox to unschedule)
- **Calendar** — month grid with tag dots; click a day and its notes open in a scrollable panel on the right
- **Canvas** — free-form board with a card folder; drag cards anywhere

**Make it yours**
- Light/dark mode, 3 fonts (Typewriter / Modern / Classic), compact view, hide tag bar

## Voice capture from your Apple Shortcut

You already have: Action button → record → OpenAI transcription → text. Point that text here:

1. Use your existing **capture token**. Sidebrain intentionally does not return it through the PWA or API. For a first-time local setup, retrieve it directly from `data/db.json` on the trusted Mac.
2. In Shortcuts, after your transcription step, add **Get Contents of URL**:
   - URL: `http://<your-mac>:4780/api/capture` (LAN IP from the startup log, or Tailscale name)
   - Method: **POST**, Request Body: **JSON** with field `text` = the transcribed text
   - Header: `Authorization` = `Bearer <your-token>`
3. Done — the note lands in your feed, auto-tagged by any `#hashtags` you spoke.

The server cleans the transcription before saving (punctuation, casing, filler words). With `OPENAI_API_KEY` set it uses OpenAI (`OPENAI_MODEL`, default `gpt-4o-mini`); without a key it applies light heuristics. Optional JSON fields: `"raw": true` skips cleanup, `"task": true` sends it straight to the week planner's Inbox (saying "hashtag todo" in the voice note does the same via the tag trigger).

```bash
# start with LLM cleanup
OPENAI_API_KEY=sk-... node server.js

# test capture from anywhere
curl -X POST http://localhost:4780/api/capture \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"text":"um so remember to uh check the analytics dashboard #todo"}'
```

## Push notifications (free, via ntfy.sh)

Reminders can be pushed to your phone even when the app isn't open:

1. Install the **ntfy** app (free, App Store) on your phone.
2. In ntfy, subscribe to a secret topic name you invent — treat it like a password, e.g. `sidebrain-8f3k2p`.
3. In Sidebrain → Settings → **Push notifications**, enter the same topic and hit **Save & test**. A test push should land on your phone immediately.

From then on, when a reminder comes due the server pushes it to your phone. (In-app banners and desktop notifications still work too.) ntfy topics are public-write by design, which is why the topic should be a random string; only the topic name ever leaves your machine — plus the reminder text when one fires.

## Use it on your phone

The server listens on your whole network, and the app is a PWA:

1. **Same Wi-Fi**: open `http://<mac-lan-ip>:4780/app` on your phone (URL is in the startup log and in Settings), then **Share → Add to Home Screen**. You get a full-screen app icon with the same live feed.
2. **From anywhere**: install [Tailscale](https://tailscale.com) (free) on your Mac and phone — your Mac gets a stable private address like `http://your-mac.tailnet-name.ts.net:4780/app` that works on cellular too. No ports opened to the internet, traffic stays encrypted.
3. **Keep it running**: load the included LaunchAgent so the server starts at login and stays up:

```bash
sed "s|__DIR__|$(pwd)|g" extras/com.sidebrain.server.plist > ~/Library/LaunchAgents/com.sidebrain.server.plist
launchctl load ~/Library/LaunchAgents/com.sidebrain.server.plist
```

Your Mac must be awake to serve requests — in System Settings → Battery, enable "Prevent automatic sleeping on power adapter" (or run `caffeinate -s` while plugged in).

## Security boundary

Sidebrain currently assumes a trusted personal environment: the Mac, its current LAN, and its private Tailscale network. The HTTP API is not authenticated, and service credentials remain in plaintext in `data/db.json`, historical backups, and local logs. Those are accepted constraints for personal use on these trusted networks.

- Do not configure Tailscale Funnel, forward port 4780 from a router, or otherwise publish Sidebrain to the internet.
- Do not share the tailnet with untrusted users or use Sidebrain on an untrusted LAN without revisiting authentication and transport security.
- API settings responses expose only configured/not-configured flags for credentials. Credential values remain write-only through the PWA and must never be returned to ChatGPT or MCP clients.
- Existing LAN, Tailscale PWA, and Authorization-header Apple Shortcut access are intentional and supported.
- Before any public deployment, tailnet sharing, or access by untrusted LAN devices, add authentication and authorization, move traffic to HTTPS, review stored credentials and historical logs/backups, and harden all API routes.

The planned ChatGPT integration must use a narrow local MCP sidecar over stdio and private IPC. Its IPC commands must be allowlisted, it must not expose the general Sidebrain HTTP API, and its responses must exclude credentials and unrelated Sidebrain state. MCP write tools remain disabled until durable task writes and the required tunnel-account association have been verified.

## Read-only MCP sidecar

Gate 2 adds a local stdio MCP sidecar with exactly one tool: `get_upcoming_tasks`. The sidecar never opens `data/db.json` or calls Sidebrain's HTTP API. Instead, the main Sidebrain process owns a Unix-domain socket and returns a bounded projection containing only task id, a one-line credential-redacted title, due date/time, and whether the task is overdue, due today, or upcoming.

The main process creates a per-user runtime directory (`0700`), socket (`0600`), and ephemeral authorization token (`0600`). Both processes default to the same OS temporary runtime path; set `SIDEBRAIN_MCP_RUNTIME_DIR` for an isolated instance. The token is regenerated on every Sidebrain start and is never printed.

Run the stdio sidecar with:

```sh
npm run mcp:stdio
```

The tool requires an IANA `timeZone` and accepts a 1–31 day window (default 7). It returns open scheduled tasks through that local-date window, including overdue tasks, with at most 100 results. It does not expose settings, credentials, uploads, reminders, note bodies, or unrelated database state. No write tools are present.
