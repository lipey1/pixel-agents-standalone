import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine } from "./parser.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import { OpenCodeSource } from "./opencode/source.js";
import type { OpenCodeDiscoveryMode } from "./opencode/types.js";
import type { ServerMessage, TrackedAgent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 600_000; // 10 minutes

// When another process owns this server's lifetime (for example the OpenCode
// Desktop GUI plugin), exit as soon as that process disappears. This keeps a
// force-killed OpenCode from leaving an orphan Pixel Agents server behind.
const PARENT_PID = Number.parseInt(process.env.PIXEL_AGENTS_PARENT_PID || "", 10);
if (Number.isFinite(PARENT_PID) && PARENT_PID > 0) {
  const parentWatchdog = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch {
      console.log(`[Server] Parent process ${PARENT_PID} is gone, shutting down...`);
      process.exit(0);
    }
  }, 5_000);
  parentWatchdog.unref();
}

// ── Source selection ────────────────────────────────────────────────────────
// OpenCode is the default. Set PIXEL_AGENTS_SOURCE=claude to use the legacy
// Claude Code JSONL watcher instead.
const SOURCE_KIND = (process.env.PIXEL_AGENTS_SOURCE || "opencode").trim().toLowerCase();
const IS_OPENCODE = SOURCE_KIND !== "claude" && SOURCE_KIND !== "claude-code" && SOURCE_KIND !== "jsonl";

function parseDiscoveryMode(value: string | undefined): OpenCodeDiscoveryMode {
  const normalized = (value || "recent").trim().toLowerCase();
  if (normalized === "all" || normalized === "1" || normalized === "true") return "all";
  if (normalized === "off" || normalized === "0" || normalized === "false" || normalized === "none") return "off";
  return "recent";
}

const PROJECT_DIR =
  process.env.PIXEL_AGENTS_PROJECT_DIR ||
  process.env.OPENCODE_DIRECTORY ||
  process.cwd();
const DISCOVERY_MODE = parseDiscoveryMode(process.env.PIXEL_AGENTS_DISCOVERY);
const DISCOVERY_WINDOW_MINUTES = Number.parseInt(process.env.PIXEL_AGENTS_DISCOVERY_WINDOW_MINUTES || "1440", 10);
const AUTO_ATTACH = process.env.PIXEL_AGENTS_ATTACH !== "0";
const AUTO_START_SERVER = process.env.PIXEL_AGENTS_OPENCODE_AUTOSTART !== "0";

// State for the legacy Claude watcher source
const claudeAgents = new Map<string, TrackedAgent>(); // sessionId -> agent
const hiddenClaudeSessionIds = new Set<string>();
let nextAgentId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

// Load assets at startup
// In dev mode (tsx), __dirname is server/ so assets are at ../webview-ui/public/assets/
// In production (esbuild), __dirname is dist/ so assets are at ./public/assets/
const devAssetsRoot = join(__dirname, "..", "webview-ui", "public", "assets");
const prodAssetsRoot = join(__dirname, "public", "assets");
const assetsRoot = existsSync(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;

console.log(`[Server] Loading assets from: ${assetsRoot}`);

const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);

// Persistence directory (override is useful for tests and profiles)
const persistDir = process.env.PIXEL_AGENTS_PERSIST_DIR || join(homedir(), ".pixel-agents");
const persistedLayoutPath = join(persistDir, "layout.json");
const persistedSeatsPath = join(persistDir, "agent-seats.json");

// Load layout: persisted first, then default
function loadLayout(): Record<string, unknown> | null {
  if (existsSync(persistedLayoutPath)) {
    try {
      const content = readFileSync(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content) as Record<string, unknown>;
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null }> | null {
  if (existsSync(persistedSeatsPath)) {
    try {
      const content = readFileSync(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

let currentLayout = loadLayout();
const persistedSeats = loadPersistedSeats();

// Express app
const app = express();
app.use(express.json());
// Serve production build
app.use(express.static(join(__dirname, "public")));

const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server });

// Ping/pong heartbeat — keeps clients Set accurate for shutdown guard
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of clients) {
    if ((ws as unknown as Record<string, boolean>).__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    (ws as unknown as Record<string, boolean>).__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

interface UiAgentInfo {
  id: number;
  sessionId: string;
  projectName: string;
  projectDir: string;
}

function listUiAgents(): UiAgentInfo[] {
  if (openCodeSource) {
    return openCodeSource.getAgents().map((agent) => ({
      id: agent.id,
      sessionId: agent.sessionId,
      projectName: agent.projectName,
      projectDir: agent.projectDir,
    }));
  }
  return [...claudeAgents.values()]
    .map((agent) => ({
      id: agent.id,
      sessionId: agent.sessionId,
      projectName: agent.projectName,
      projectDir: agent.projectDir,
    }))
    .sort((a, b) => a.id - b.id);
}

function sendClaudeAgentState(ws: WebSocket): void {
  for (const agent of claudeAgents.values()) {
    for (const tool of agent.activeTools.values()) {
      ws.send(JSON.stringify({ type: "agentToolStart", id: agent.id, toolId: tool.toolId, status: tool.status }));
    }
    if (agent.isWaiting) {
      ws.send(JSON.stringify({ type: "agentStatus", id: agent.id, status: "waiting" }));
    }
  }
}

function sendInitialData(ws: WebSocket): void {
  // Send settings
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));

  // Send character sprites
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }

  // Send wall tiles
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }

  // Send floor tiles (optional)
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }

  // Send furniture assets (optional)
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites,
      }),
    );
  }

  if (openCodeSource) {
    ws.send(JSON.stringify({ type: "workspaceFolders", folders: openCodeSource.getWorkspaceFolders() }));
    ws.send(JSON.stringify({ type: "sourceStatus", ...openCodeSource.getStatus() }));
  } else {
    ws.send(
      JSON.stringify({
        type: "sourceStatus",
        source: "claude",
        connected: true,
        serverUrl: null,
        message: "Claude Code (JSONL watcher)",
        agentCount: claudeAgents.size,
      }),
    );
  }

  // Send existing agents with persisted seat metadata
  const agentList = listUiAgents();
  const agentIds = agentList.map((a) => a.id);
  const folderNames: Record<number, string> = {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.projectName;
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
    }
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, agentMeta }));

  // Send layout (must come after existingAgents — the hook buffers agents until layout arrives)
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    // Send null layout to trigger default layout creation in the UI
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }

  // Re-send active tool state after the layout so the office has characters/seats.
  if (openCodeSource) {
    openCodeSource.sendAgentState((message) => ws.send(JSON.stringify(message)));
  } else {
    sendClaudeAgentState(ws);
  }
}

function findClaudeAgent(agentId: number): TrackedAgent | undefined {
  for (const agent of claudeAgents.values()) {
    if (agent.id === agentId) return agent;
  }
  return undefined;
}

function closeClaudeAgent(agentId: number): void {
  const agent = findClaudeAgent(agentId);
  if (!agent) return;
  hiddenClaudeSessionIds.add(agent.sessionId);
  claudeAgents.delete(agent.sessionId);
  broadcast({ type: "agentClosed", id: agent.id });
  console.log(`Agent ${agent.id} hidden: ${agent.projectName}`);
}

const openCodeSource: OpenCodeSource | null = IS_OPENCODE
  ? new OpenCodeSource({
      persistDir,
      directory: PROJECT_DIR,
      directoryExplicit: Boolean(process.env.PIXEL_AGENTS_PROJECT_DIR || process.env.OPENCODE_DIRECTORY),
      discovery: DISCOVERY_MODE,
      discoveryWindowMs:
        (Number.isFinite(DISCOVERY_WINDOW_MINUTES) ? DISCOVERY_WINDOW_MINUTES : 1440) * 60 * 1_000,
      autoAttach: AUTO_ATTACH,
      autoStartServer: AUTO_START_SERVER,
      broadcast,
      log: (message) => console.log(`[OpenCode] ${message}`),
    })
  : null;

// REST status endpoint for diagnostics and scripts
app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    source: IS_OPENCODE ? "opencode" : "claude",
    projectDir: PROJECT_DIR,
    persistDir,
    agents: listUiAgents(),
    opencode: openCodeSource?.getStatus() ?? null,
  });
});

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => {
    (ws as unknown as Record<string, boolean>).__isAlive = true;
  });
  clients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; [key: string]: unknown };
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
      } else if (msg.type === "saveLayout") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedLayoutPath, JSON.stringify(msg.layout, null, 2));
          currentLayout = msg.layout as Record<string, unknown>;
          // Broadcast to other clients for multi-tab sync
          const data = JSON.stringify({ type: "layoutLoaded", layout: msg.layout, version: 1 });
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        } catch (err) {
          console.error(`[Server] Failed to save layout: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "saveAgentSeats") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedSeatsPath, JSON.stringify(msg.seats, null, 2));
        } catch (err) {
          console.error(`[Server] Failed to save agent seats: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "openAgentSession" || msg.type === "openClaude") {
        if (openCodeSource) {
          void openCodeSource.createAgent(typeof msg.folderPath === "string" ? msg.folderPath : undefined);
        } else {
          broadcast({
            type: "notice",
            level: "warn",
            message: "Claude Code mode only observes existing sessions. Restart with PIXEL_AGENTS_SOURCE=opencode to create agents.",
          });
        }
      } else if (msg.type === "closeAgent") {
        const id = typeof msg.id === "number" ? msg.id : Number.parseInt(String(msg.id), 10);
        if (!Number.isFinite(id)) return;
        if (openCodeSource) {
          openCodeSource.closeAgent(id);
        } else {
          closeClaudeAgent(id);
        }
      } else if (msg.type === "focusAgent") {
        const id = typeof msg.id === "number" ? msg.id : Number.parseInt(String(msg.id), 10);
        if (!Number.isFinite(id)) return;
        openCodeSource?.focusAgent(id);
      } else if (msg.type === "openSessionsFolder") {
        broadcast({ type: "notice", level: "info", message: `Local data: ${persistDir}` });
      }
    } catch {
      /* ignore invalid messages */
    }
  });

  ws.on("close", () => clients.delete(ws));
});

// ── Legacy Claude JSONL watcher ────────────────────────────────────────────
const watcher = !IS_OPENCODE ? new JsonlWatcher() : null;

if (watcher) {
  watcher.on("fileAdded", (file: WatchedFile) => {
    if (claudeAgents.has(file.sessionId) || hiddenClaudeSessionIds.has(file.sessionId)) return;
    lastActivityTime = Date.now();

    const agent: TrackedAgent = {
      id: nextAgentId++,
      sessionId: file.sessionId,
      projectDir: dirname(file.path),
      projectName: file.projectName,
      jsonlFile: file.path,
      fileOffset: 0,
      lineBuffer: "",
      activity: "idle",
      activeTools: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastActivityTime: Date.now(),
    };

    claudeAgents.set(file.sessionId, agent);
    broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName });
    console.log(`Agent ${agent.id} joined: ${agent.projectName} (${file.sessionId.slice(0, 8)})`);
  });

  watcher.on("fileRemoved", (file: WatchedFile) => {
    const agent = claudeAgents.get(file.sessionId);
    if (!agent) return;

    claudeAgents.delete(file.sessionId);
    broadcast({ type: "agentClosed", id: agent.id });
    console.log(`Agent ${agent.id} left: ${agent.projectName}`);
  });

  watcher.on("line", (file: WatchedFile, line: string) => {
    const agent = claudeAgents.get(file.sessionId);
    if (!agent) return;
    lastActivityTime = Date.now();

    processTranscriptLine(line, agent, broadcast);
  });
}

// Start
server.listen(PORT, () => {
  console.log(`Pixel Agents server running at http://localhost:${PORT}`);
  if (openCodeSource) {
    console.log(`Source: OpenCode (discovery=${DISCOVERY_MODE}, project=${PROJECT_DIR})`);
    openCodeSource.start();
  } else {
    console.log(`Source: Claude Code (watching ~/.claude/projects/)`);
    watcher?.start();
  }
});

// Idle shutdown. A parent-managed server stays alive while OpenCode is open,
// even with no sessions or browser tabs connected.
setInterval(() => {
  if (Number.isFinite(PARENT_PID) && PARENT_PID > 0) return;
  const agentCount = listUiAgents().length;
  if (agentCount === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
    console.log("No active sessions or clients for 10 minutes, shutting down...");
    openCodeSource?.stop();
    watcher?.stop();
    server.close();
    process.exit(0);
  }
}, 30_000);

// Graceful shutdown
function shutdown(): void {
  openCodeSource?.stop();
  watcher?.stop();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
