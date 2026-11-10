# Pixel Agents Standalone

A standalone web app that visualizes **OpenCode** sessions as pixel-art characters working in a virtual office.

Each top-level OpenCode session becomes a character that walks around, sits at a desk, and shows what it is doing in real time — reading files, running tools, delegating subtasks, waiting for permission, or idle. Child sessions and subtasks appear as sub-agent characters.

![Screenshot](webview-ui/public/Screenshot.jpg)

> **Based on [pixel-agents](https://github.com/pablodelucca/pixel-agents) by Pablo De Lucca** (MIT License).
> The original is a VS Code extension. This fork runs as a standalone web app in your browser — no VS Code required.

## What's Different

| Original (VS Code Extension) | This Fork (Standalone Web App) |
|-------------------------------|-------------------------------|
| Runs inside VS Code webview | Runs in any browser at `localhost:3456` |
| Uses VS Code extension API | Express + WebSocket server |
| Requires VS Code | Works with any terminal |
| Claude Code only | **OpenCode by default**, Claude Code JSONL as fallback |

## Requirements

- **Node.js 18+** (Node 22+ recommended; the server uses global `fetch` and `AbortController`).
- **OpenCode**, in either of these forms:
  - **OpenCode Desktop 2.2+** (recommended) — the app connects to the Desktop background service that is already running. No second server is needed.
  - **OpenCode CLI/server** — a v1 or v2 `opencode serve` instance.
- A terminal emulator only if you want automatic `opencode attach` windows for **v1** servers.

### Supported APIs

| API | Used by | Endpoints |
|-----|---------|-----------|
| v1 | older CLI `opencode serve` | `/global/health`, `/global/event`, `/session*` |
| v2 | OpenCode Desktop 2.x and current `opencode serve` | `/api/session`, `/api/session/active`, `/api/session/:id/message`, `/api/event` |

The app detects which API a server exposes. v2 servers require HTTP Basic auth; the app uses username `opencode` and reads the password from `~/.config/opencode/service.json` (Desktop), `OPENCODE_PASSWORD`, or credentials embedded in `OPENCODE_URL`.

## Quick Start

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
npm start
```

Open `http://localhost:3456` in your browser.

If **OpenCode Desktop** is running, the app finds its background service automatically and shows its top-level sessions as characters. If no server is found, the app tries to start one:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

You can also point the app at a specific server:

```bash
OPENCODE_URL=http://127.0.0.1:28894 OPENCODE_PASSWORD=your-password npm start
```

The status badge in the bottom toolbar shows whether OpenCode is connected, which API version is in use, and how many agents are visible.

### Start and stop with OpenCode Desktop

The [`integrations/opencode-plugin`](integrations/opencode-plugin) folder contains an OpenCode Desktop GUI plugin that ties Pixel Agents to the app lifecycle: Pixel Agents starts when OpenCode starts, opens in the browser, and stops when OpenCode quits, reloads, or disables the plugin. A parent-PID watchdog also stops the server if OpenCode is force-killed.

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File integrations\opencode-plugin\install.ps1
```

Then add the printed entry to the `plugins` array in `~/.config/opencode/opencode.jsonc` and restart OpenCode Desktop. See the [plugin README](integrations/opencode-plugin/README.md) for options and logs (or use `start-pixel-agents.cmd` for a manual launch on Windows).

### Server discovery order

1. `OPENCODE_URL` / `OPENCODE_SERVER_URL`, when set.
2. Legacy v1 servers on `4096`, `18083`, `49374`, and nearby ports (the health response must be valid JSON).
3. OpenCode Desktop v2 service ports read from the newest `%APPDATA%\ai.opencode.desktop\logs\*\main.log`, then ports `4096`–`4107`. Each candidate is probed with Basic auth.
4. If nothing is found and autostart is enabled, the app spawns `opencode serve`.

> **Port 4096 may not be OpenCode Desktop.** Tools such as OpenCodeRemote can start a separate server there with its own `OPENCODE_SERVER_PASSWORD`. Desktop usually listens on a random loopback port recorded in its `main.log`. Set `OPENCODE_PASSWORD` for that other server, or use `OPENCODE_URL` to choose explicitly.

## How OpenCode Maps to the Office

| OpenCode | Office |
|----------|--------|
| Top-level session (`session` without `parentID`) | Primary agent character |
| Child session (`parentID`) or `subagent`/`subtask` message part | Sub-agent character |
| `session.status` busy/retry, `session.execution.started` | Character is active |
| `session.idle`, `session.execution.succeeded` | Character shows the waiting bubble |
| `message.part.updated` / `session.tool.called` with a tool | Speech bubble with the tool status |
| `permission.asked` / `permission.replied` | Permission bubble / clear |
| Tool call inside a child session | Tool bubble on the sub-agent character |

Additional behavior:

- **`+ Agent`** creates a new session (`POST /session` or `POST /api/session`). On v1 it opens an `opencode attach` terminal when possible; on v2 the session is already available in Desktop and the attach command is shown only when you focus the character.
- **Closing a character** hides it and remembers the hidden session. The underlying OpenCode session is **not deleted**.
- **Restarting the server** restores persisted agent-to-session bindings from `~/.pixel-agents/opencode-agents.json` and replays current messages, child sessions, tools, and idle/busy status.
- Nested child sessions are flattened onto the root sub-agent character, since the office renders one sub-agent per direct subtask.
- Both event orderings are handled: a subtask part may arrive before its child session, or the child session may arrive first. Each subtask creates exactly one sub-agent.
- v2 rename/move events only contain the changed fields. The app merges them with full session metadata so a renamed child session is never promoted to a main character.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Port for the Pixel Agents web server |
| `PIXEL_AGENTS_SOURCE` | `opencode` | Source: `opencode` or `claude` (legacy JSONL watcher) |
| `OPENCODE_URL` / `OPENCODE_SERVER_URL` | — | Use an existing server, e.g. `http://127.0.0.1:28894`; skips discovery. Supports `user:password@host` and `/api` suffixes |
| `OPENCODE_PASSWORD` | Desktop `service.json` | Basic-auth password for v2 servers |
| `OPENCODE_USERNAME` | `opencode` | Basic-auth username for v2 servers |
| `OPENCODE_SERVER_PASSWORD` | — | Fallback for `OPENCODE_PASSWORD` (used by CLI servers) |
| `OPENCODE_PORT` | `4096` | Preferred port when auto-starting OpenCode |
| `OPENCODE_BIN` | `opencode` / `opencode.cmd` | OpenCode executable to spawn |
| `PIXEL_AGENTS_PROJECT_DIR` / `OPENCODE_DIRECTORY` | inferred | Project directory for workspace metadata and `+ Agent` |
| `PIXEL_AGENTS_PERSIST_DIR` | `~/.pixel-agents` | Directory for `layout.json`, `agent-seats.json`, and `opencode-agents.json` |
| `PIXEL_AGENTS_DISCOVERY` | `recent` | Session discovery: `recent`, `all`, or `off` |
| `PIXEL_AGENTS_DISCOVERY_WINDOW_MINUTES` | `1440` | Window used by `recent` discovery |
| `PIXEL_AGENTS_ATTACH` | `1` | Set to `0` to disable automatic `opencode attach` terminals (v1 only; v2 never opens terminals) |
| `PIXEL_AGENTS_OPENCODE_AUTOSTART` | `1` | Set to `0` to never spawn `opencode serve` automatically |

### Discovery modes

- `recent` (default) — at startup, shows top-level sessions updated within the window plus any session currently busy/retrying.
- `all` — shows every top-level OpenCode session known to the server.
- `off` — only shows sessions created while the app is running or restored from persisted bindings.

### Project directory inference

Unless `PIXEL_AGENTS_PROJECT_DIR` / `OPENCODE_DIRECTORY` is set, the app infers the project directory from the most recently updated root session and uses that for metadata and `+ Agent`. v2 `POST /api/session` accepts a `location.directory`, so new v2 sessions honor the inferred directory. v1 `POST /session` does not accept a directory; new v1 sessions are created in the OpenCode server's working directory.

## Claude Code Fallback

The original Claude Code JSONL watcher is still available:

```bash
PIXEL_AGENTS_SOURCE=claude npm start
```

It watches `~/.claude/projects/` for active session files. To start the server automatically when a Claude Code session begins, add a `SessionStart` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "/path/to/pixel-agents/scripts/cmux-hook.sh"
      }
    ]
  }
}
```

Edit `scripts/cmux-hook.sh` and set `PIXEL_AGENTS_DIR` to wherever you cloned this repo.

## Development

```bash
npm run dev
```

Runs the Express server (with hot reload) and the Vite dev server concurrently.

Run the end-to-end OpenCode integration tests:

```bash
npm run test:opencode      # v1 API
npm run test:opencode:v2   # v2 Desktop-style API
```

Each test starts a mock OpenCode server and a real Pixel Agents server, then verifies:

- server discovery and agent creation
- root tools and subtask tool bubbles
- both subtask/child event orderings (no duplicate sub-agents)
- child tools, sub-agent cleanup, and idle/waiting status
- non-destructive close and hidden-session persistence
- `+ Agent` session creation
- restore after server restart

The v2 test additionally covers Basic auth, `{data: ...}` envelopes, `session.execution.*`/`session.tool.*` events, `subagent` metadata, replay of an already-running subagent, v2 session creation with `location.directory`, and child-session rename events that omit `parentID`.

Run a standalone mock OpenCode server for UI development:

```bash
npm run mock-opencode       # v1, port 4096
npm run mock-opencode:v2    # v2, port 4096, password "mock-password"
```

The mocks accept events at `POST /__emit`:

```bash
curl -X POST http://127.0.0.1:4096/__emit \
  -H "content-type: application/json" \
  -d '{"type":"session.status","properties":{"sessionID":"ses_mock_demo","status":{"type":"busy"}}}'
```

For the v2 mock, use the v2 event shape and Basic auth:

```bash
curl -X POST http://127.0.0.1:4096/__emit \
  -u opencode:mock-password \
  -H "content-type: application/json" \
  -d '{"type":"session.execution.started","data":{"sessionID":"ses_mock_v2_demo"}}'
```

## Architecture

- **Server** (`server/`) — Express + WebSocket. Selects an OpenCode or Claude Code source, serves the UI, and broadcasts agent state.
- **OpenCode source** (`server/opencode/`)
  - `backend.ts` — shared backend interface and Basic-auth helpers used by both API versions.
  - `client.ts` — server discovery/autostart, v1 HTTP client, Desktop service-port detection, auth candidates, and attach-terminal launcher.
  - `clientV2.ts` — v2 `/api` client, `{data: ...}` unwrapping, session/message mapping, event translation, and `subagent` → sub-agent mapping.
  - `sse.ts` — resilient SSE client with reconnect/backoff shared by v1 and v2.
  - `source.ts` — maps sessions, messages, tools, subtasks, permissions, and child sessions into the webview protocol; handles persistence and replay.
  - `toolStatus.ts` — normalizes OpenCode tool names and formats speech-bubble text.
  - `types.ts` — v1/v2 API types and tracked-agent state.
- **Watcher** (`server/watcher.ts`, `server/parser.ts`) — legacy Claude Code JSONL source.
- **UI** (`webview-ui/`) — React + Canvas 2D office simulation with pathfinding, sprite animation, sub-agent characters, tool bubbles, and a layout editor.

## Office Tileset

The built-in layout uses basic furniture (desks, chairs, plants). For the full 452-piece furniture catalog, purchase the [Office Interior Tileset](https://donarg.itch.io/office-interior-tileset-16x16) by Donarg ($2 on itch.io), place it at `assets/office_tileset_16x16.png`, and run:

```bash
npm run extract-furniture
```

## Troubleshooting

**The toolbar says OpenCode is offline.**
For a v1 server, check:

```bash
curl http://127.0.0.1:4096/global/health
```

For OpenCode Desktop v2, first confirm Desktop is running, then find its service URL in the newest log:

```powershell
Get-ChildItem "$env:APPDATA\ai.opencode.desktop\logs" -Directory |
  Sort-Object Name -Descending | Select-Object -First 1 |
  ForEach-Object { Select-String -Path (Join-Path $_.FullName "main.log") -Pattern "url: 'http://127.0.0.1:" }
```

Test the service with the password from `~/.config/opencode/service.json`:

```bash
curl -u opencode:YOUR_PASSWORD http://127.0.0.1:28894/api/session
```

If that works, set `OPENCODE_URL=http://127.0.0.1:28894` and `OPENCODE_PASSWORD=YOUR_PASSWORD` before starting. The app retries discovery every 10 seconds.

**Port 4096 returns 401 but the Desktop password does not work.**
Port `4096` may belong to a different server (for example OpenCodeRemote) that was started with its own `OPENCODE_SERVER_PASSWORD`. Use `OPENCODE_PASSWORD` with that server's password, or point `OPENCODE_URL` at Desktop's random port from `main.log`.

**No characters appear, but OpenCode is connected.**
Discovery defaults to `recent` (sessions updated in the last 24 hours). Start or resume an OpenCode session, or run with `PIXEL_AGENTS_DISCOVERY=all`.

**`+ Agent` opens no terminal.**
With OpenCode Desktop v2 this is intentional: the session is already available in Desktop and no terminal is spawned. Focus the character to see the session ID and an `opencode --session ...` command. With v1, automatic terminal launch needs a supported terminal emulator (Windows `cmd start`, macOS Terminal via AppleScript, or `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux). Set `PIXEL_AGENTS_ATTACH=0` to disable attempts entirely.

**Sub-agents do not appear.**
The app needs the child session in `/api/session` (with `parentID`) or a `subagent`/`subtask` message part. Top-level sessions are the only ones discovered at startup; children are attached to their root character during replay and live events. Check that the source reports `apiVersion: "v2"` or is a v1 server.

**A closed character came back after restart.**
Hidden session IDs are stored in `PIXEL_AGENTS_PERSIST_DIR/opencode-agents.json`. Make sure the server can write to that directory. Delete the file to reset all agent bindings and hidden sessions.

**Sessions are not restored.**
Verify that the persisted OpenCode session still exists on the server. Agents whose sessions were deleted are dropped during hydration. Layout and seats are stored separately in `layout.json` and `agent-seats.json`.

## Support

If watching your agents wander a pixel office made your day better, a [⭐ star](https://github.com/rolandal/pixel-agents-standalone) keeps the office lights on — and star [the original](https://github.com/pablodelucca/pixel-agents) too.

## Credits

- **[pixel-agents](https://github.com/pablodelucca/pixel-agents)** by Pablo De Lucca — original VS Code extension (MIT License)
- **[Office Interior Tileset](https://donarg.itch.io/office-interior-tileset-16x16)** by Donarg — pixel art furniture (purchased separately)

## License

MIT
