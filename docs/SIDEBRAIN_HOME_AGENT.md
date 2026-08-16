# Sidebrain Home Agent

## Architecture

The existing Sidebrain process remains the only `db.json` writer. The existing **Side Brain Tasks** stdio MCP app still uses its per-process private Unix socket and ephemeral token. Three narrow services are added behind that boundary:

- `govee-client` calls only `https://openapi.api.govee.com` and reads the API key from a protected local file.
- `home-service` discovers light devices and capability descriptors before it validates or sends any control. It stores only Sidebrain presets in `db.json`.
- `delegation-service` reconciles `codex`-tagged tasks into a leased state machine, stores claim-token hashes, allows one active claim globally, and queues safe Discord notifications in the existing durable reminder outbox.
- `voice-command-service` deterministically routes a bounded set of authenticated commands. It never turns voice text into a general prompt or shell command.

All migrations are additive. Existing messages, tags, reminders, operations, uploads, PWA routes, Tailscale access, and legacy voice capture remain intact.

## Govee setup and discovery

Sidebrain uses the official Govee Developer API device, state, control, dynamic-scene, and DIY-scene endpoints. Snapshots are discovered from the device capability list. No model, range, scene value, or capability is hard-coded.

The default key path is `~/.config/sidebrain/govee-api-key`. Both the directory and file must be owned by the Sidebrain user, must not be symlinks, and must have modes `0700` and `0600`. The key is never stored in `db.json`, returned by an API or MCP tool, or included in a log/error message.

Run this single line from an interactive zsh only when ready to configure the key. Input is intentionally invisible; press Return after typing the key:

```zsh
( install -d -m 700 "$HOME/.config/sidebrain" && umask 077 && IFS= read -r -s 'SIDEBRAIN_GOVEE_KEY?Govee API key: ' && printf '\n' >&2 && printf '%s\n' "$SIDEBRAIN_GOVEE_KEY" > "$HOME/.config/sidebrain/govee-api-key" && chmod 600 "$HOME/.config/sidebrain/govee-api-key" && unset SIDEBRAIN_GOVEE_KEY && printf 'Saved securely.\n' )
```

After configuration, call `list_lights` first. It returns opaque Sidebrain light IDs, Govee app names, models, online state, current queryable state, and useful discovered capabilities. Call `list_light_scenes` to discover dynamic, DIY, and snapshot options. Those returned IDs/names are the only accepted scene selectors.

Named Sidebrain presets support different settings for each discovered bulb. Suggested names include Focus, Reading, Movie, Wind Down, Night, and All Off; they are intentionally not seeded until the real bulbs and desired per-bulb settings are known.

Read-only production discovery on 2026-08-16 verified three `devices.types.light` devices: **Door**, **Computer table**, and **Bedside**, all model H6008. Each exposes power, brightness 1-100, RGB, color temperature 2000-9000 K, dynamic scenes, and DIY-scene capability. The scene API returned the same 56 named dynamic scenes for each bulb. The DIY endpoint currently returns no selectable DIY options, and none of the three device descriptors exposes snapshots, so Sidebrain reports neither until Govee supplies selectable values. Two virtual entries (`SameModeGroup` and `DreamViewScenic`) were also returned by Govee; they are deliberately excluded because their device type is not a light and their state/scene endpoints reject requests.

## Delegation schema and lifecycle

`taskDelegations[]` contains the durable queue records. A record has a task ID, state, server-approved `projectAlias`, attempt count, bounded progress, timestamps, and temporary claim metadata. Claim tokens are returned once and only their SHA-256 hashes are stored.

The lifecycle is:

`ready → claimed → running → completed | failed | waiting`

Deleted tasks and tasks that lose the `codex` tag become `cancelled`. Manually completed tasks become `completed`. `waiting`, `completed`, `failed`, and `cancelled` are not eligible for claiming. After Sameer supplies the missing input, `requeue_codex_task` can return a waiting, failed, or retagged cancelled task to `ready`, but only with explicit user confirmation; scheduled workers are forbidden from calling it themselves. An expired `claimed` or `running` record can be returned to `ready` only by the recovery operation. Progress renews a healthy lease. Only one global active claim is allowed, so overlapping scheduled runs cannot claim different tasks concurrently.

The only project alias currently allowlisted is `mindchuck`. Task content cannot supply a filesystem path or shell command. A completed result is stored as a child note of the original task. Completion, waiting, and failure queue bounded title-only Discord notifications through the existing leased/retrying/dead-letter delivery system; results and waiting reasons are not copied to Discord.

The reviewed schedule specification is in `automation/sidebrain-codex-agent.md`. Creating or enabling it is a separate approval step.

## Apple Shortcut: Side Brain

Create a Shortcut named **Side Brain**:

1. Add **Dictate Text** (or reuse the existing transcription action).
2. Add **Get Contents of URL**.
   - URL: `http://<Sidebrain Tailscale name or LAN address>:4780/api/voice-command`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <existing Sidebrain capture token>` and `Content-Type` = `application/json`
   - JSON body: `text` = Dictated Text, `timeZone` = `America/New_York`
3. Read the response as a dictionary, get `text`, and pass it to **Speak Text**.
4. If `requiresConfirmation` is true, speak the response and ask for clarification. For an ambiguous task, choose one returned candidate and repeat the request with `selectionId`; completion also requires `confirmed` = `true`. For a disruptive flashing/alarm scene, ask for confirmation and repeat the same command with `confirmed` = `true`.

The endpoint supports upcoming tasks, ordinary task creation, exact Discord reminders, unambiguous task completion, power, brightness, named/hex RGB color, color temperature, discovered scenes, Sidebrain presets, and Codex delegation status. Dates accept `today`, `tomorrow`, or exact `YYYY-MM-DD`; other date wording is rejected for clarification rather than guessed.

The token must stay in the `Authorization` header. URL query credentials are rejected.

## Live verification (requires approval)

1. Back up `data/db.json` with a timestamped mode-0600 file under `data/backups/`.
2. Configure the protected Govee key with the hidden-input command above.
3. Run `list_lights` and verify exactly three expected device names, online flags, and discovered capabilities. This is read-only.
4. Run `list_light_scenes` and verify dynamic, DIY, and snapshot inventory for each bulb. This is read-only.
5. With explicit bulb-action approval, control one selected bulb at low brightness, restore it, then test one scene. Create the six desired presets from the discovered IDs and verify each one only with approval.
6. POST an authenticated read-only upcoming-task voice command over localhost, then test a temporary-database write in staging. Do not create a live task until separately approved.
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

- Actual bulb inventory and read-only capabilities are verified. Presets remain intentionally unseeded until Sameer chooses the per-bulb settings.
- Scene parity depends on what each Govee model returns; the service does not invent unsupported options.
- The voice grammar is intentionally narrow and deterministic. It asks for exact dates instead of interpreting conversational weekday phrases.
- Sidebrain still assumes the existing trusted LAN/private-Tailscale boundary; the voice endpoint adds bearer authentication but does not change transport security.
- The Codex automation is prepared but not created or enabled.
