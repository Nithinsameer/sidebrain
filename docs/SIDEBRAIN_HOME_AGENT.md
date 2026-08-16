# Sidebrain Home Agent

## Architecture

The existing Sidebrain process remains the only `db.json` writer. The existing **Side Brain Tasks** stdio MCP app still uses its per-process private Unix socket and ephemeral token. Three narrow services are added behind that boundary:

- `govee-client` calls only `https://openapi.api.govee.com` and reads the API key from a protected local file.
- `home-service` discovers light devices and capability descriptors before it validates or sends any control. It stores only Sidebrain presets in `db.json`.
- `delegation-service` reconciles `codex`-tagged tasks into a leased state machine, stores claim-token hashes, allows one active claim globally, and queues safe Discord notifications in the existing durable reminder outbox.
- `voice-intent-classifier` uses the existing Sidebrain AI configuration only to choose an allowlisted intent and extract schema-validated arguments. Voice text is passed as inert JSON data; the model cannot select routes, URLs, files, paths, settings, or shell commands.
- `voice-command-service` executes those validated intents through narrow task, home, and delegation adapters. It holds five-minute, single-use confirmation transactions in memory and never turns voice text into a general prompt or shell command.

All migrations are additive. Existing messages, tags, reminders, operations, uploads, PWA routes, Tailscale access, and legacy voice capture remain intact.

## Govee setup and discovery

Sidebrain uses the official Govee Developer API device, state, control, dynamic-scene, and DIY-scene endpoints. Snapshots are discovered from the device capability list. No model, range, scene value, or capability is hard-coded.

The default key path is `~/.config/sidebrain/govee-api-key`. Both the directory and file must be owned by the Sidebrain user, must not be symlinks, and must have modes `0700` and `0600`. The key is never stored in `db.json`, returned by an API or MCP tool, or included in a log/error message.

Run this single line from an interactive zsh only when ready to configure the key. Input is intentionally invisible; press Return after typing the key:

```zsh
( install -d -m 700 "$HOME/.config/sidebrain" && umask 077 && IFS= read -r -s 'SIDEBRAIN_GOVEE_KEY?Govee API key: ' && printf '\n' >&2 && printf '%s\n' "$SIDEBRAIN_GOVEE_KEY" > "$HOME/.config/sidebrain/govee-api-key" && chmod 600 "$HOME/.config/sidebrain/govee-api-key" && unset SIDEBRAIN_GOVEE_KEY && printf 'Saved securely.\n' )
```

After configuration, call `list_lights` first. It returns opaque Sidebrain light IDs, Govee app names, models, online state, current queryable state, and useful discovered capabilities. Call `list_light_scenes` to discover dynamic, DIY, and snapshot options. Those returned IDs/names are the only accepted scene selectors.

Govee may accept a control command before the state endpoint reflects it. Sidebrain sends each requested capability command once, reports `apiAccepted` separately, then polls state immediately and at one-second intervals for at most approximately five seconds. It reports `stateConfirmed` and `confirmationAttempts`; it never resends an accepted command merely because an early state read is stale. Scene activation reports API acceptance with `stateConfirmed: null` because Govee does not expose queryable active-scene state.

Named Sidebrain presets support different settings for each discovered bulb. Focus, Reading, Movie, Wind Down, Night, and All Off are configured. Batch control and preset activation check online state first, skip bulbs that are explicitly offline, continue reachable bulbs, and return the partial result.

Read-only production discovery on 2026-08-16 verified three `devices.types.light` devices: **Door**, **Computer table**, and **Bedside**, all model H6008. Each exposes power, brightness 1-100, RGB, color temperature 2000-9000 K, dynamic scenes, and DIY-scene capability. The scene API returned the same 56 named dynamic scenes for each bulb. The DIY endpoint currently returns no selectable DIY options, and none of the three device descriptors exposes snapshots, so Sidebrain reports neither until Govee supplies selectable values. Two virtual entries (`SameModeGroup` and `DreamViewScenic`) were also returned by Govee; they are deliberately excluded because their device type is not a light and their state/scene endpoints reject requests.

## Delegation schema and lifecycle

`taskDelegations[]` contains the durable queue records. A record has a task ID, state, server-approved `projectAlias`, attempt count, bounded progress, timestamps, and temporary claim metadata. Claim tokens are returned once and only their SHA-256 hashes are stored.

The lifecycle is:

`ready → claimed → running → completed | failed | waiting`

Deleted tasks and tasks that lose the `codex` tag become `cancelled`. Manually completed tasks become `completed`. `waiting`, `completed`, `failed`, and `cancelled` are not eligible for claiming. After Sameer supplies the missing input, `requeue_codex_task` can return a waiting, failed, or retagged cancelled task to `ready`, but only with explicit user confirmation; scheduled workers are forbidden from calling it themselves. An expired `claimed` or `running` record can be returned to `ready` only by the recovery operation. Progress renews a healthy lease. Only one global active claim is allowed, so overlapping scheduled runs cannot claim different tasks concurrently.

The only project alias currently allowlisted is `mindchuck`. Task content cannot supply a filesystem path or shell command. A completed result is stored as a child note of the original task. Completion, waiting, and failure queue bounded title-only Discord notifications through the existing leased/retrying/dead-letter delivery system; results and waiting reasons are not copied to Discord.

The reviewed once-daily 8:30 AM America/New_York schedule specification is in `automation/sidebrain-codex-agent.md`. It is enabled only after the manual delegation test passes.

## Apple Shortcut: Side Brain

The voice endpoint uses a dedicated, scoped, revocable credential at `~/.config/sidebrain/voice-command-token`. This is not the capture token, Govee key, tunnel key, Discord webhook, or OpenAI key. The containing directory must be owned by the Sidebrain user with mode `0700`; the credential must be an owned regular non-symlink file with mode `0600`. It is never stored in `db.json`, source control, API responses, or ordinary logs.

Generate it without printing it:

```zsh
( install -d -m 700 "$HOME/.config/sidebrain" && umask 077 && openssl rand -out "$HOME/.config/sidebrain/voice-command-token" -hex 32 && chmod 600 "$HOME/.config/sidebrain/voice-command-token" )
```

Create a Shortcut named **Side Brain** with this flow:

1. Add **Dictate Text** (or reuse the existing transcription action).
2. Add **Get Contents of URL**.
   - URL: `http://nithins-macbook-air.tail5c3528.ts.net:4780/api/voice-command`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <dedicated voice credential>` and `Content-Type` = `application/json`
   - JSON body: `text` = Dictated Text, `timeZone` = `America/New_York`
3. Read the response as a dictionary, get `spokenResponse`, and pass it to **Speak Text**. Never speak the full dictionary.
4. If `confirmation_required` is true, add another **Dictate Text**, then POST `confirmationToken` and `confirmationResponse` to the same endpoint with the same headers. Speak only that response's `spokenResponse`. The token is single-use and expires after five minutes.
5. Wrap the request in Shortcut error handling. Speak a fixed useful message for timeout/server offline, Tailscale unavailable, HTTP 401/503, a missing or malformed dictionary, or a response without `spokenResponse`. Do not speak raw response bodies, credentials, stack traces, internal IDs, or claim tokens.

The endpoint supports upcoming and overdue tasks, ordinary tasks, Discord reminders, task finding/completion/reopening/receipts, light inventory and multi-light power/brightness/RGB/color-temperature control, discovered scenes, Sidebrain presets, creating or marking Codex tasks, Codex status/waiting state, and completed summaries. The AI may interpret natural phrasing and dates, but only the validated allowlist executes. Reminder dates and times, ambiguous task matches, completion, reopening, disruptive scenes, and other ambiguous or consequential requests require the spoken confirmation turn.

The credential must stay in the `Authorization` header. URL query credentials are rejected. Tailscale Serve/HTTPS was checked on 2026-08-16 and is not enabled for this tailnet. The documented URL is therefore HTTP at the application layer carried inside Tailscale's authenticated WireGuard-encrypted private tunnel; it is not localhost, LAN fallback, public HTTP, or Funnel. If Tailscale Serve is enabled later, replace the URL with the tailnet HTTPS origin after testing rather than weakening certificate validation.

## Live verification (requires approval)

1. Back up `data/db.json` with a timestamped mode-0600 file under `data/backups/`.
2. Configure the protected Govee key with the hidden-input command above.
3. Run `list_lights` and verify exactly three expected device names, online flags, and discovered capabilities. This is read-only.
4. Run `list_light_scenes` and verify dynamic, DIY, and snapshot inventory for each bulb. This is read-only.
5. With explicit bulb-action approval, control one selected bulb at low brightness, restore it, then test one scene. Create the six desired presets from the discovered IDs and verify each one only with approval.
6. POST an authenticated read-only upcoming-task voice command over the Mac's Tailscale address, then test a temporary-database write in staging. A localhost request is diagnostic only and is not voice acceptance.
7. Add a temporary codex-tagged task only with approval, run one worker cycle manually, verify claim exclusion, progress, child result, task completion, and one safe Discord notification.
8. Create/enable the reviewed **Sidebrain Codex Agent** automation only after explicit approval; verify two intervals do not overlap and an empty queue exits without writes.
9. Verify PWA load, capture, task completion, existing reminder delivery, private MCP startup, LAN URL, and Tailscale URL before closing the deployment window.

## Deployment and rollback

Deployment is intentionally not performed by this branch.

1. Confirm the worktree is clean and run `npm test` with the production Node version.
2. From the live checkout, create `data/backups/db-<timestamp>-pre-home-agent.json` with mode `0600`, then verify it parses and matches the source file size/checksum.
3. Merge the reviewed pull request, fast-forward the live checkout, and restart `com.sidebrain.server` only with approval.
4. Verify startup logs contain no secrets and execute the read-only checks above before any write/device action.

For code rollback, restore the previous commit and restart the service. The schema is additive, so the previous server ignores the new top-level arrays; preserve the newer database unless data corruption is proven. If database restoration is necessary, stop the service, preserve the failed database separately, copy the verified pre-deployment backup into place with mode `0600`, and then restart.

## Limitations

- Actual bulb inventory, read-only capabilities, and six presets are verified.
- Scene parity depends on what each Govee model returns; the service does not invent unsupported options.
- Natural language is AI-classified, but execution remains a strict validated allowlist with a deterministic fallback for basic commands.
- The current tailnet has no Tailscale Serve/HTTPS configuration. Voice HTTP is private WireGuard transport, and the Shortcut must not fall back to LAN or public transport silently.
- The Codex automation is prepared but not created or enabled.
