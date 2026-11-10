import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServerMessage } from "../types.js";
import type { OpenCodeBackend } from "./backend.js";
import {
  OpenCodeClient,
  discoverOpenCodeServer,
  launchAttachTerminal,
  type DiscoveredOpenCodeServer,
} from "./client.js";
import { OpenCodeV2Client } from "./clientV2.js";
import {
  formatToolStatus,
  isPermissionExempt,
  normalizeToolName,
  PERMISSION_TIMER_DELAY_MS,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TOOL_DONE_DELAY_MS,
} from "./toolStatus.js";
import type {
  ChildSessionBinding,
  OpenCodeDiscoveryMode,
  OpenCodeGlobalEvent,
  OpenCodeMessageWithParts,
  OpenCodePart,
  OpenCodeSession,
  OpenCodeSessionStatus,
  OpenCodeSourceStatus,
  OpenCodeTrackedAgent,
  PersistedOpenCodeAgent,
  PersistedOpenCodeState,
} from "./types.js";

const OPENCODE_STATE_FILE = "opencode-agents.json";
const RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DISCOVERY_RETRY_MS = 10_000;
const RECONNECT_CHECK_MS = 15_000;
const ATTACH_COOLDOWN_MS = 10_000;
const MAX_CHILD_DEPTH = 8;

export interface OpenCodeSourceOptions {
  persistDir: string;
  directory: string;
  directoryExplicit?: boolean;
  discovery?: OpenCodeDiscoveryMode;
  discoveryWindowMs?: number;
  autoAttach?: boolean;
  autoStartServer?: boolean;
  broadcast: (message: ServerMessage) => void;
  log?: (message: string) => void;
}

interface RegisterAgentOptions {
  notify?: boolean;
  projectDir?: string;
  projectName?: string;
}

function truncateTaskDescription(description: string): string {
  return description.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH
    ? `${description.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}\u2026`
    : description;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function infoToSession(value: unknown): OpenCodeSession | null {
  const info = asRecord(value);
  if (!info || typeof info.id !== "string") return null;
  return info as unknown as OpenCodeSession;
}

function sessionIdFromProperties(properties: Record<string, unknown>): string | null {
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (typeof properties.sessionId === "string") return properties.sessionId;
  const permission = asRecord(properties.permission);
  if (permission && typeof permission.sessionID === "string") return permission.sessionID;
  const part = asRecord(properties.part);
  if (part && typeof part.sessionID === "string") return part.sessionID;
  const info = asRecord(properties.info);
  if (info && typeof info.sessionID === "string") return info.sessionID;
  return null;
}

function partStatus(part: OpenCodePart): { status: string; input: Record<string, unknown> } {
  const state = asRecord(part.state);
  const status = state && typeof state.status === "string" ? state.status : "pending";
  const input = (state && asRecord(state.input)) || {};
  return { status, input };
}

function isRunningStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "started" || status === "in_progress";
}

function updatedAt(session: OpenCodeSession): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

export class OpenCodeSource {
  private readonly persistDir: string;
  private readonly statePath: string;
  private directory: string;
  private readonly directoryExplicit: boolean;
  private readonly discovery: OpenCodeDiscoveryMode;
  private readonly discoveryWindowMs: number;
  private readonly autoAttach: boolean;
  private readonly autoStartServer: boolean;
  private readonly broadcastMessage: (message: ServerMessage) => void;
  private readonly log: (message: string) => void;

  private agents = new Map<number, OpenCodeTrackedAgent>();
  private sessionToAgent = new Map<string, number>();
  private childBindings = new Map<string, ChildSessionBinding>();
  private childSessionTitles = new Map<string, string>();
  private knownSessions = new Map<string, OpenCodeSession>();
  private hiddenSessionIds = new Set<string>();
  private persistedAgents: PersistedOpenCodeAgent[] = [];
  private nextAgentId = 1;
  private nextSessionIndex = 1;

  private client: OpenCodeBackend | null = null;
  private server: DiscoveredOpenCodeServer | null = null;
  private subscription: { dispose: () => void } | null = null;
  private permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private hydrating: Promise<void> | null = null;
  private hasHydratedOnce = false;
  private stopped = false;
  private status: OpenCodeSourceStatus = {
    source: "opencode",
    connected: false,
    serverUrl: null,
    message: "Looking for an OpenCode server...",
    agentCount: 0,
    discovery: "recent",
    autoStartedServer: false,
  };
  private noticeCooldowns = new Map<string, number>();
  private lastAttachAt = new Map<number, number>();
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenCodeSourceOptions) {
    this.persistDir = options.persistDir;
    this.statePath = join(options.persistDir, OPENCODE_STATE_FILE);
    this.directory = options.directory;
    this.directoryExplicit = options.directoryExplicit ?? false;
    this.discovery = options.discovery ?? "recent";
    this.discoveryWindowMs = options.discoveryWindowMs ?? RECENT_SESSION_WINDOW_MS;
    this.autoAttach = options.autoAttach ?? true;
    this.autoStartServer = options.autoStartServer ?? true;
    this.broadcastMessage = options.broadcast;
    this.log = options.log ?? ((message) => console.log(`[OpenCode] ${message}`));
  }

  getWorkspaceFolders(): Array<{ name: string; path: string }> {
    return [{ name: basename(this.directory) || this.directory, path: this.directory }];
  }

  getAgents(): OpenCodeTrackedAgent[] {
    return [...this.agents.values()].sort((a, b) => a.id - b.id);
  }

  getStatus(): OpenCodeSourceStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    this.loadState();
    this.status = { ...this.status, discovery: this.discovery };
    this.broadcastStatus();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.subscription?.dispose();
    this.subscription = null;
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.reconnectCheckTimer) {
      clearTimeout(this.reconnectCheckTimer);
      this.reconnectCheckTimer = null;
    }
    for (const timer of this.permissionTimers.values()) {
      clearTimeout(timer);
    }
    this.permissionTimers.clear();
  }

  /** Called for new WebSocket clients after layoutLoaded. */
  sendAgentState(send: (message: ServerMessage) => void): void {
    send({ type: "workspaceFolders", folders: this.getWorkspaceFolders() });
    for (const agent of this.getAgents()) {
      for (const [toolId, status] of agent.activeToolStatuses) {
        send({ type: "agentToolStart", id: agent.id, toolId, status });
      }
      for (const [parentToolId, tools] of agent.activeSubagentToolIds) {
        const statuses = agent.activeSubagentToolStatuses.get(parentToolId);
        for (const toolId of tools) {
          const status = statuses?.get(toolId) ?? "Using tool";
          send({ type: "subagentToolStart", id: agent.id, parentToolId, toolId, status });
        }
      }
      if (agent.isWaiting) {
        send({ type: "agentStatus", id: agent.id, status: "waiting" });
      }
      if (agent.permissionSent) {
        send({ type: "agentToolPermission", id: agent.id });
      }
    }
    send({ type: "sourceStatus", ...this.status });
  }

  async createAgent(folderPath?: string): Promise<OpenCodeTrackedAgent | null> {
    if (!this.client) {
      this.emitNotice("error", "OpenCode is not connected. Make sure the OpenCode server is running.");
      return null;
    }
    const requestedDirectory = folderPath || this.directory;
    const requestedName = basename(requestedDirectory) || requestedDirectory;
    const index = this.nextSessionIndex++;
    const title = `Pixel Agent — ${requestedName}: ${index}`;
    try {
      const session = await this.client.createSession(title, requestedDirectory);
      this.knownSessions.set(session.id, session);
      const effectiveDirectory = session.directory || requestedDirectory;
      const projectName = basename(effectiveDirectory) || requestedName;
      if (!this.directoryExplicit && effectiveDirectory !== this.directory) {
        this.directory = effectiveDirectory;
        this.broadcast({ type: "workspaceFolders", folders: this.getWorkspaceFolders() });
      }
      const agent = this.registerAgent(this.allocateAgentId(), session, {
        notify: true,
        projectDir: effectiveDirectory,
        projectName,
      });
      this.saveState();
      this.emitNotice("info", `Agent ${agent.id} created for OpenCode session ${session.id.slice(0, 8)}.`);
      this.attachToSession(agent, false);
      this.broadcastStatus();
      return agent;
    } catch (error) {
      this.log(`Failed to create session: ${String(error)}`);
      this.emitNotice("error", `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Hide a character without deleting the underlying OpenCode session. */
  closeAgent(agentId: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.hiddenSessionIds.add(agent.sessionId);
    this.removeAgent(agentId, { notify: true, deleteSession: false });
    this.saveState();
  }

  focusAgent(agentId: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.attachToSession(agent, true);
  }

  private allocateAgentId(): number {
    const id = this.nextAgentId;
    this.nextAgentId += 1;
    return id;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      const discovered = await discoverOpenCodeServer({
        autoStart: this.autoStartServer,
        onLog: (message) => this.log(message),
      });
      if (this.stopped) return;
      if (!discovered) {
        this.setStatus(
          false,
          "OpenCode not found. Start OpenCode Desktop (v2) or a v1 server, or set OPENCODE_URL.",
          {
            serverUrl: null,
            autoStartedServer: false,
            apiVersion: undefined,
          },
        );
        this.emitNotice("warn", "OpenCode not found. Retrying in 10s.", "opencode-not-found");
        this.scheduleDiscoveryRetry();
        return;
      }

      this.server = discovered;
      this.client =
        discovered.api === "v2"
          ? new OpenCodeV2Client(discovered.baseUrl, discovered.auth)
          : new OpenCodeClient(discovered.baseUrl);
      const apiLabel = discovered.api === "v2" ? "OpenCode v2" : "OpenCode v1";
      const connectedMessage = `Connected to ${apiLabel} at ${discovered.baseUrl}`;
      this.setStatus(true, connectedMessage, {
        serverUrl: discovered.baseUrl,
        autoStartedServer: discovered.autoStarted,
        apiVersion: discovered.api,
      });
      if (discovered.autoStarted) {
        this.emitNotice("info", `${apiLabel} server started at ${discovered.baseUrl}.`, "opencode-autostart");
      }

      this.subscription?.dispose();
      this.subscription = this.client.subscribe(
        (event) => this.enqueueEvent(event),
        {
          onOpen: () => {
            this.setStatus(true, connectedMessage, {
              serverUrl: discovered.baseUrl,
              autoStartedServer: discovered.autoStarted,
              apiVersion: discovered.api,
            });
            void this.hydrateSessions();
          },
          onError: (error) => {
            this.log(`SSE error: ${String(error)}`);
            this.setStatus(false, "OpenCode event stream lost; reconnecting...");
            this.scheduleReconnectCheck();
          },
        },
      );
      void this.hydrateSessions();
    } catch (error) {
      this.log(`Connection failed: ${String(error)}`);
      this.setStatus(false, `Failed to connect to OpenCode: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleDiscoveryRetry();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleDiscoveryRetry(): void {
    if (this.stopped || this.discoveryTimer) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      void this.connect();
    }, DISCOVERY_RETRY_MS);
  }

  private scheduleReconnectCheck(): void {
    if (this.stopped || this.reconnectCheckTimer) return;
    this.reconnectCheckTimer = setTimeout(() => {
      this.reconnectCheckTimer = null;
      void (async () => {
        if (this.stopped) return;
        if (this.client && (await this.client.health())) {
          // The SSE loop reconnects on its own.
          return;
        }
        this.subscription?.dispose();
        this.subscription = null;
        this.client = null;
        this.server = null;
        void this.connect();
      })();
    }, RECONNECT_CHECK_MS);
  }

  private enqueueEvent(event: OpenCodeGlobalEvent): void {
    this.eventQueue = this.eventQueue
      .then(() => this.processEvent(event))
      .catch((error) => this.log(`Failed to process OpenCode event: ${String(error)}`));
  }

  private async hydrateSessions(): Promise<void> {
    if (!this.client || this.hydrating) return this.hydrating ?? undefined;
    const client = this.client;
    this.hydrating = (async () => {
      try {
        const [sessionsResult, statusesResult] = await Promise.allSettled([
          client.listSessions(),
          client.getSessionStatuses(),
        ]);
        if (sessionsResult.status === "rejected") {
          throw sessionsResult.reason;
        }
        const sessions = sessionsResult.value;
        const statuses = statusesResult.status === "fulfilled" ? statusesResult.value : {};
        for (const session of sessions) {
          this.knownSessions.set(session.id, session);
        }
        if (!this.directoryExplicit) {
          const rootsWithDirectory = sessions
            .filter((session) => !session.parentID && typeof session.directory === "string" && session.directory)
            .sort((a, b) => updatedAt(b) - updatedAt(a));
          const inferredDirectory = rootsWithDirectory[0]?.directory;
          if (inferredDirectory && inferredDirectory !== this.directory) {
            this.directory = inferredDirectory;
            this.broadcast({ type: "workspaceFolders", folders: this.getWorkspaceFolders() });
          }
        }
        const sessionsById = new Map(sessions.map((session) => [session.id, session]));

        // Restore agents persisted by previous server runs.
        for (const persisted of this.persistedAgents) {
          if (this.sessionToAgent.has(persisted.sessionId) || this.hiddenSessionIds.has(persisted.sessionId)) {
            continue;
          }
          const info = sessionsById.get(persisted.sessionId) ?? (await this.getSessionSafe(persisted.sessionId));
          if (!info) {
            this.log(`Dropping stale persisted agent ${persisted.id}: session ${persisted.sessionId} is gone`);
            continue;
          }
          this.registerAgent(persisted.id, info, {
            notify: true,
            projectDir: persisted.projectDir,
            projectName: persisted.projectName,
          });
        }

        // Discover untracked top-level sessions.
        if (this.discovery !== "off") {
          const now = Date.now();
          for (const session of sessions) {
            if (session.parentID) continue;
            if (this.hiddenSessionIds.has(session.id)) continue;
            if (this.sessionToAgent.has(session.id)) continue;
            const status = statuses[session.id];
            const isActive = status?.type === "busy" || status?.type === "retry";
            const isRecent = updatedAt(session) > 0 && now - updatedAt(session) <= this.discoveryWindowMs;
            if (this.discovery === "all" || isActive || isRecent) {
              this.registerAgent(this.allocateAgentId(), session, { notify: true });
            }
          }
        }

        for (const agent of this.getAgents()) {
          const status = statuses[agent.sessionId];
          const shouldReplay = !this.hasHydratedOnce || status?.type !== "idle" || agent.activeToolIds.size > 0;
          if (shouldReplay) {
            await this.replayAgent(agent, status, statuses);
          }
        }

        this.nextSessionIndex = Math.max(this.nextSessionIndex, this.agents.size + 1);
        this.hasHydratedOnce = true;
        this.saveState();
        this.broadcastStatus();
      } catch (error) {
        this.log(`Hydration failed: ${String(error)}`);
        this.setStatus(false, `Failed to load OpenCode sessions: ${String(error)}`);
      } finally {
        this.hydrating = null;
      }
    })();
    return this.hydrating;
  }

  private async getSessionSafe(sessionId: string): Promise<OpenCodeSession | null> {
    if (!this.client) return null;
    try {
      const session = await this.client.getSession(sessionId);
      this.knownSessions.set(session.id, session);
      return session;
    } catch {
      return null;
    }
  }

  private registerAgent(id: number, session: OpenCodeSession, options: RegisterAgentOptions = {}): OpenCodeTrackedAgent {
    const existingId = this.sessionToAgent.get(session.id);
    if (existingId !== undefined) {
      const existing = this.agents.get(existingId);
      if (existing) {
        existing.sessionTitle = session.title || existing.sessionTitle;
        return existing;
      }
    }
    const projectDir = options.projectDir || session.directory || this.directory;
    const projectName =
      options.projectName || basename(projectDir) || session.title || session.id.slice(0, 8);
    const agent: OpenCodeTrackedAgent = {
      id,
      sessionId: session.id,
      projectDir,
      projectName,
      sessionTitle: session.title || projectName,
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      activeSubagentToolStatuses: new Map(),
      isWaiting: false,
      permissionSent: false,
      lastActivityTime: Date.now(),
      pendingSubtaskToolIds: [],
      seenSubtaskPartIds: new Set(),
      unclaimedChildSessionIds: [],
    };
    this.agents.set(id, agent);
    this.sessionToAgent.set(session.id, id);
    this.knownSessions.set(session.id, session);
    if (id >= this.nextAgentId) {
      this.nextAgentId = id + 1;
    }
    if (options.notify) {
      this.broadcast({ type: "agentCreated", id, folderName: projectName });
      this.log(`Agent ${id} joined: ${projectName} (${session.id.slice(0, 8)})`);
    }
    this.broadcastStatus();
    return agent;
  }

  private removeAgent(agentId: number, options: { notify: boolean; deleteSession: boolean }): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.cancelPermissionTimer(agentId);
    this.agents.delete(agentId);
    this.sessionToAgent.delete(agent.sessionId);
    this.lastAttachAt.delete(agentId);
    for (const [sessionId, binding] of this.childBindings) {
      if (binding.agentId === agentId) {
        this.childBindings.delete(sessionId);
        this.childSessionTitles.delete(sessionId);
      }
    }
    this.persistedAgents = this.persistedAgents.filter((entry) => entry.id !== agentId);
    if (options.notify) {
      this.broadcast({ type: "agentClosed", id: agentId });
      this.log(`Agent ${agentId} left: ${agent.projectName}`);
    }
    if (!options.deleteSession) {
      this.broadcastStatus();
    }
  }

  private broadcast(message: ServerMessage): void {
    this.broadcastMessage(message);
  }

  private setStatus(
    connected: boolean,
    message: string,
    extra: Partial<Pick<OpenCodeSourceStatus, "serverUrl" | "autoStartedServer" | "apiVersion">> = {},
  ): void {
    const next: OpenCodeSourceStatus = {
      ...this.status,
      ...extra,
      connected,
      message,
      agentCount: this.agents.size,
    };
    const changed =
      next.connected !== this.status.connected ||
      next.message !== this.status.message ||
      next.serverUrl !== this.status.serverUrl ||
      next.autoStartedServer !== this.status.autoStartedServer ||
      next.apiVersion !== this.status.apiVersion ||
      next.agentCount !== this.status.agentCount;
    this.status = next;
    if (changed) {
      this.broadcast({ type: "sourceStatus", ...next });
    }
  }

  private broadcastStatus(): void {
    this.status = { ...this.status, agentCount: this.agents.size };
    this.broadcast({ type: "sourceStatus", ...this.status });
  }

  private emitNotice(level: "info" | "warn" | "error", message: string, cooldownKey?: string): void {
    if (cooldownKey) {
      const now = Date.now();
      const last = this.noticeCooldowns.get(cooldownKey) ?? 0;
      if (now - last < 30_000) return;
      this.noticeCooldowns.set(cooldownKey, now);
    }
    this.broadcast({ type: "notice", level, message });
  }

  private attachToSession(agent: OpenCodeTrackedAgent, focus: boolean): void {
    const command = this.client?.buildAttachCommand(agent.sessionId, agent.projectDir);
    // With OpenCode Desktop (v2), the session is already available in the
    // Desktop window. Don't spawn a terminal on every new character; show the
    // command only when the user explicitly focuses the character.
    if (this.client?.apiVersion === "v2") {
      if (focus) {
        this.emitNotice(
          "info",
          `Session ${agent.sessionId} — open it in OpenCode Desktop or run: ${command ?? `opencode --session ${agent.sessionId}`}`,
          `attach-${agent.id}`,
        );
      }
      return;
    }
    const lastAttach = this.lastAttachAt.get(agent.id) ?? 0;
    if (Date.now() - lastAttach < ATTACH_COOLDOWN_MS) {
      if (focus && command) {
        this.emitNotice("info", `Session ${agent.sessionId} is already attached. Run manually: ${command}`, `attach-${agent.id}`);
      }
      return;
    }
    if (!this.autoAttach || !this.client || !command) {
      if (focus) {
        this.emitNotice(
          "info",
          `Session ${agent.sessionId} — run: ${command ?? `opencode attach --session ${agent.sessionId}`}`,
        );
      }
      return;
    }
    const result = launchAttachTerminal(command, `Pixel Agent #${agent.id}`);
    if (result.ok) {
      this.lastAttachAt.set(agent.id, Date.now());
      if (!focus) {
        this.emitNotice("info", `Terminal opened for agent ${agent.id}.`, `attach-${agent.id}`);
      }
    } else {
      this.emitNotice(
        "warn",
        `Could not open a terminal automatically. Run: ${command}`,
        `attach-failed-${agent.id}`,
      );
    }
  }

  private async processEvent(event: OpenCodeGlobalEvent): Promise<void> {
    const payload = event.payload;
    if (!payload || typeof payload.type !== "string") return;
    const properties = payload.properties ?? {};

    switch (payload.type) {
      case "session.created":
      case "session.updated": {
        let info = infoToSession(properties.info);
        if (!info) return;

        // v2 rename/move events only carry the changed fields, so a child
        // session would look top-level (`parentID` missing) and be registered
        // as a main character. Merge with what we already know, and fetch the
        // full session when its parentage is still unknown.
        const known = this.knownSessions.get(info.id);
        let parentageKnown = payload.type === "session.created" || known !== undefined;
        if (known) {
          info = {
            ...known,
            ...info,
            title: info.title || known.title,
            directory: info.directory ?? known.directory,
            parentID: info.parentID ?? known.parentID,
            time: { ...known.time, ...info.time },
          };
        }
        if (info.parentID === undefined && payload.type === "session.updated") {
          const fresh = await this.getSessionSafe(info.id);
          if (fresh) {
            parentageKnown = true;
            info = {
              ...fresh,
              ...info,
              title: info.title || fresh.title,
              directory: info.directory ?? fresh.directory,
              parentID: info.parentID ?? fresh.parentID,
              time: { ...fresh.time, ...info.time },
            };
          }
        }
        this.knownSessions.set(info.id, info);

        if (!info.parentID) {
          if (!parentageKnown) return;
          if (this.hiddenSessionIds.has(info.id)) return;
          const existingAgentId = this.sessionToAgent.get(info.id);
          if (existingAgentId !== undefined) {
            const agent = this.agents.get(existingAgentId);
            if (agent && info.title) {
              agent.sessionTitle = info.title;
            }
            return;
          }
          this.registerAgent(this.allocateAgentId(), info, { notify: true });
          this.saveState();
          return;
        }
        if (payload.type === "session.created" || !known || known.parentID !== info.parentID) {
          await this.handleChildSessionCreated(info);
        }
        return;
      }

      case "session.deleted": {
        const info = infoToSession(properties.info);
        const sessionId = info?.id ?? (typeof properties.sessionID === "string" ? properties.sessionID : null);
        if (!sessionId) return;
        const agentId = this.sessionToAgent.get(sessionId);
        if (agentId !== undefined) {
          this.removeAgent(agentId, { notify: true, deleteSession: false });
          this.saveState();
          return;
        }
        const binding = this.childBindings.get(sessionId);
        if (binding) {
          const agent = this.agents.get(binding.agentId);
          this.childBindings.delete(sessionId);
          this.childSessionTitles.delete(sessionId);
          if (agent) {
            this.broadcast({ type: "subagentClear", id: agent.id, parentToolId: binding.parentToolId });
          }
        }
        return;
      }

      case "session.idle": {
        const sessionId = sessionIdFromProperties(properties);
        if (!sessionId) return;
        this.handleSessionIdle(sessionId);
        return;
      }

      case "session.status": {
        const sessionId = sessionIdFromProperties(properties);
        const status = asRecord(properties.status);
        if (!sessionId || !status || typeof status.type !== "string") return;
        this.handleSessionStatus(sessionId, status as unknown as OpenCodeSessionStatus);
        return;
      }

      case "permission.asked": {
        const sessionId = sessionIdFromProperties(properties);
        if (!sessionId) return;
        this.handlePermissionAsked(sessionId);
        return;
      }

      case "permission.replied": {
        const sessionId = sessionIdFromProperties(properties);
        if (!sessionId) return;
        this.handlePermissionReplied(sessionId);
        return;
      }

      case "message.part.updated": {
        const part = asRecord(properties.part);
        if (!part || typeof part.sessionID !== "string" || typeof part.type !== "string") return;
        await this.handlePart(part as unknown as OpenCodePart);
        return;
      }

      default:
        return;
    }
  }

  private async handleChildSessionCreated(info: OpenCodeSession): Promise<void> {
    const parentId = info.parentID;
    if (!parentId) return;
    this.knownSessions.set(info.id, info);
    this.childSessionTitles.set(info.id, info.title || "OpenCode subtask");

    // Direct child of a known root agent.
    const rootAgentId = this.sessionToAgent.get(parentId);
    if (rootAgentId !== undefined) {
      const agent = this.agents.get(rootAgentId);
      if (agent) {
        this.bindChildSession(info, agent);
      }
      return;
    }

    // Nested child: flatten onto the root subagent's tool list.
    const parentBinding = this.childBindings.get(parentId);
    if (parentBinding) {
      this.childBindings.set(info.id, {
        agentId: parentBinding.agentId,
        parentToolId: parentBinding.parentToolId,
        direct: false,
        synthetic: false,
        claimed: true,
      });
      return;
    }

    const inherited = await this.resolveNestedBinding(parentId, 0);
    if (inherited) {
      const agent = this.agents.get(inherited.agentId);
      if (agent) {
        this.childBindings.set(info.id, {
          agentId: agent.id,
          parentToolId: inherited.parentToolId,
          direct: false,
          synthetic: false,
          claimed: true,
        });
      }
    }
  }

  private async resolveNestedBinding(
    sessionId: string,
    depth: number,
  ): Promise<{ agentId: number; parentToolId: string } | null> {
    if (depth > MAX_CHILD_DEPTH) return null;
    const binding = this.childBindings.get(sessionId);
    if (binding) return { agentId: binding.agentId, parentToolId: binding.parentToolId };
    const directAgentId = this.sessionToAgent.get(sessionId);
    if (directAgentId !== undefined) return null;

    const info = this.knownSessions.get(sessionId) ?? (await this.getSessionSafe(sessionId));
    if (!info?.parentID) {
      if (info && !this.hiddenSessionIds.has(info.id)) {
        this.registerAgent(this.allocateAgentId(), info, { notify: true });
      }
      return null;
    }

    const parentBinding = await this.resolveNestedBinding(info.parentID, depth + 1);
    if (parentBinding) return parentBinding;

    const rootAgentId = this.sessionToAgent.get(info.parentID);
    if (rootAgentId !== undefined) {
      const agent = this.agents.get(rootAgentId);
      if (agent) {
        const created = this.bindChildSession(info, agent);
        return { agentId: created.agentId, parentToolId: created.parentToolId };
      }
    }
    return null;
  }

  private bindChildSession(info: OpenCodeSession, agent: OpenCodeTrackedAgent): ChildSessionBinding {
    const existing = this.childBindings.get(info.id);
    if (existing) return existing;
    this.childSessionTitles.set(info.id, info.title || "OpenCode subtask");

    if (agent.pendingSubtaskToolIds.length > 0) {
      const parentToolId = agent.pendingSubtaskToolIds.shift() as string;
      const binding: ChildSessionBinding = {
        agentId: agent.id,
        parentToolId,
        direct: true,
        synthetic: false,
        claimed: true,
      };
      this.childBindings.set(info.id, binding);
      return binding;
    }

    const parentToolId = info.id;
    const binding: ChildSessionBinding = {
      agentId: agent.id,
      parentToolId,
      direct: true,
      synthetic: true,
      claimed: false,
    };
    this.childBindings.set(info.id, binding);
    agent.unclaimedChildSessionIds.push(info.id);
    const title = info.title || "OpenCode subtask";
    this.startAgentTool(agent, parentToolId, "Task", `Subtask: ${truncateTaskDescription(title)}`);
    return binding;
  }

  private handleSubtaskPart(agent: OpenCodeTrackedAgent, part: OpenCodePart): void {
    const partId = typeof part.id === "string" ? part.id : `subtask-${Date.now()}`;
    if (agent.seenSubtaskPartIds.has(partId)) return;
    agent.seenSubtaskPartIds.add(partId);

    // A child session may have arrived before this part. Claim it instead of
    // creating a second character for the same subtask.
    while (agent.unclaimedChildSessionIds.length > 0) {
      const childId = agent.unclaimedChildSessionIds.shift() as string;
      const binding = this.childBindings.get(childId);
      if (!binding || binding.agentId !== agent.id || binding.claimed) continue;
      binding.claimed = true;
      return;
    }

    const description =
      (typeof part.description === "string" && part.description) ||
      (typeof part.prompt === "string" && part.prompt) ||
      "OpenCode subtask";
    agent.pendingSubtaskToolIds.push(partId);
    this.startAgentTool(agent, partId, "Task", `Subtask: ${truncateTaskDescription(description)}`);
  }

  private async handlePart(part: OpenCodePart): Promise<void> {
    const directAgentId = this.sessionToAgent.get(part.sessionID);
    if (directAgentId !== undefined) {
      const agent = this.agents.get(directAgentId);
      if (!agent) return;
      agent.lastActivityTime = Date.now();
      this.handleRootPart(agent, part);
      return;
    }

    let binding = this.childBindings.get(part.sessionID);
    if (!binding) {
      await this.resolveNestedBinding(part.sessionID, 0);
      binding = this.childBindings.get(part.sessionID);
    }
    if (!binding) {
      // Root session we don't know yet (for example, discovery was off).
      const info = this.knownSessions.get(part.sessionID) ?? (await this.getSessionSafe(part.sessionID));
      if (info && !info.parentID && !this.hiddenSessionIds.has(info.id)) {
        const agent = this.registerAgent(this.allocateAgentId(), info, { notify: true });
        this.saveState();
        agent.lastActivityTime = Date.now();
        this.handleRootPart(agent, part);
      }
      return;
    }

    const agent = this.agents.get(binding.agentId);
    if (!agent) return;
    agent.lastActivityTime = Date.now();
    this.handleChildPart(agent, part, binding.parentToolId);
  }

  private handleRootPart(agent: OpenCodeTrackedAgent, part: OpenCodePart): void {
    if (part.type === "tool") {
      this.handleToolPart(agent, part);
      return;
    }
    if (part.type === "subtask") {
      this.handleSubtaskPart(agent, part);
      return;
    }
    if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") {
      this.markAgentActive(agent);
    }
  }

  private handleChildPart(agent: OpenCodeTrackedAgent, part: OpenCodePart, parentToolId: string): void {
    if (part.type === "tool") {
      this.ensureSubagentTask(agent, parentToolId);
      this.handleToolPart(agent, part, parentToolId);
      return;
    }
    if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") {
      this.ensureSubagentTask(agent, parentToolId);
      this.markAgentActive(agent);
      return;
    }
    // Nested subtask parts are flattened under the same subagent character.
  }

  private handleToolPart(agent: OpenCodeTrackedAgent, part: OpenCodePart, parentToolId?: string): void {
    const rawToolName = typeof part.tool === "string" ? part.tool : "tool";
    const toolName = normalizeToolName(rawToolName);
    const { status, input } = partStatus(part);
    const toolId =
      typeof part.callID === "string"
        ? part.callID
        : typeof part.id === "string"
          ? part.id
          : `${toolName}-${Date.now()}`;
    const displayStatus = formatToolStatus(toolName, input);

    if (!parentToolId) {
      if (isRunningStatus(status)) {
        this.startAgentTool(agent, toolId, toolName, displayStatus);
      } else {
        this.finishAgentTool(agent, toolId);
      }
      return;
    }

    if (isRunningStatus(status)) {
      this.startSubagentTool(agent, parentToolId, toolId, toolName, displayStatus);
    } else {
      this.finishSubagentTool(agent, parentToolId, toolId);
    }
  }

  private startAgentTool(agent: OpenCodeTrackedAgent, toolId: string, toolName: string, status: string): void {
    if (agent.activeToolIds.has(toolId)) {
      agent.activeToolStatuses.set(toolId, status);
      agent.activeToolNames.set(toolId, toolName);
      return;
    }
    agent.activeToolIds.add(toolId);
    agent.activeToolNames.set(toolId, toolName);
    agent.activeToolStatuses.set(toolId, status);
    this.clearPermissionBubble(agent);
    this.markAgentActive(agent);
    this.broadcast({ type: "agentToolStart", id: agent.id, toolId, status });
    if (!isPermissionExempt(toolName)) {
      this.startPermissionTimer(agent);
    }
  }

  private finishAgentTool(agent: OpenCodeTrackedAgent, toolId: string): void {
    const toolName = agent.activeToolNames.get(toolId);
    if (toolName === "Task") {
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
      agent.activeSubagentToolStatuses.delete(toolId);
      this.broadcast({ type: "subagentClear", id: agent.id, parentToolId: toolId });
    }
    agent.pendingSubtaskToolIds = agent.pendingSubtaskToolIds.filter((id) => id !== toolId);
    if (!agent.activeToolIds.has(toolId)) return;
    agent.activeToolIds.delete(toolId);
    agent.activeToolNames.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    this.refreshPermissionState(agent);
    setTimeout(() => {
      this.broadcast({ type: "agentToolDone", id: agent.id, toolId });
    }, TOOL_DONE_DELAY_MS);
  }

  private startSubagentTool(
    agent: OpenCodeTrackedAgent,
    parentToolId: string,
    toolId: string,
    toolName: string,
    status: string,
  ): void {
    let toolIds = agent.activeSubagentToolIds.get(parentToolId);
    if (!toolIds) {
      toolIds = new Set();
      agent.activeSubagentToolIds.set(parentToolId, toolIds);
    }
    if (toolIds.has(toolId)) return;
    toolIds.add(toolId);

    let names = agent.activeSubagentToolNames.get(parentToolId);
    if (!names) {
      names = new Map();
      agent.activeSubagentToolNames.set(parentToolId, names);
    }
    names.set(toolId, toolName);

    let statuses = agent.activeSubagentToolStatuses.get(parentToolId);
    if (!statuses) {
      statuses = new Map();
      agent.activeSubagentToolStatuses.set(parentToolId, statuses);
    }
    statuses.set(toolId, status);

    this.clearPermissionBubble(agent);
    this.broadcast({ type: "subagentToolStart", id: agent.id, parentToolId, toolId, status });
    if (!isPermissionExempt(toolName)) {
      this.startPermissionTimer(agent);
    }
  }

  private finishSubagentTool(agent: OpenCodeTrackedAgent, parentToolId: string, toolId: string): void {
    agent.activeSubagentToolIds.get(parentToolId)?.delete(toolId);
    agent.activeSubagentToolNames.get(parentToolId)?.delete(toolId);
    agent.activeSubagentToolStatuses.get(parentToolId)?.delete(toolId);
    this.refreshPermissionState(agent);
    setTimeout(() => {
      this.broadcast({ type: "subagentToolDone", id: agent.id, parentToolId, toolId });
    }, TOOL_DONE_DELAY_MS);
  }

  private ensureSubagentTask(agent: OpenCodeTrackedAgent, parentToolId: string): void {
    if (agent.activeToolIds.has(parentToolId)) return;
    let title = "OpenCode subtask";
    for (const [childId, binding] of this.childBindings) {
      if (binding.agentId === agent.id && binding.parentToolId === parentToolId) {
        title = this.childSessionTitles.get(childId) || title;
        break;
      }
    }
    this.startAgentTool(agent, parentToolId, "Task", `Subtask: ${truncateTaskDescription(title)}`);
  }

  private handleSessionIdle(sessionId: string): void {
    const directAgentId = this.sessionToAgent.get(sessionId);
    if (directAgentId !== undefined) {
      const agent = this.agents.get(directAgentId);
      if (agent) this.applySessionStatus(agent, { type: "idle" });
      return;
    }
    const binding = this.childBindings.get(sessionId);
    if (!binding || !binding.direct) return;
    const agent = this.agents.get(binding.agentId);
    if (!agent) return;
    if (agent.activeToolIds.has(binding.parentToolId)) {
      this.finishAgentTool(agent, binding.parentToolId);
    }
  }

  private handleSessionStatus(sessionId: string, status: OpenCodeSessionStatus): void {
    const directAgentId = this.sessionToAgent.get(sessionId);
    if (directAgentId !== undefined) {
      const agent = this.agents.get(directAgentId);
      if (agent) this.applySessionStatus(agent, status);
      return;
    }
    const binding = this.childBindings.get(sessionId);
    if (!binding) return;
    const agent = this.agents.get(binding.agentId);
    if (!agent) return;
    if (status.type === "idle") {
      if (binding.direct && agent.activeToolIds.has(binding.parentToolId)) {
        this.finishAgentTool(agent, binding.parentToolId);
      }
    } else {
      this.ensureSubagentTask(agent, binding.parentToolId);
    }
  }

  private applySessionStatus(agent: OpenCodeTrackedAgent, status: OpenCodeSessionStatus): void {
    if (status.type === "idle") {
      this.refreshPermissionState(agent);
      if (agent.isWaiting) return;
      agent.isWaiting = true;
      this.broadcast({ type: "agentStatus", id: agent.id, status: "waiting" });
      return;
    }
    if (!agent.isWaiting) return;
    agent.isWaiting = false;
    this.broadcast({ type: "agentStatus", id: agent.id, status: "active" });
  }

  private markAgentActive(agent: OpenCodeTrackedAgent): void {
    if (!agent.isWaiting) return;
    agent.isWaiting = false;
    this.broadcast({ type: "agentStatus", id: agent.id, status: "active" });
  }

  private clearPermissionBubble(agent: OpenCodeTrackedAgent): void {
    if (!agent.permissionSent) return;
    agent.permissionSent = false;
    this.broadcast({ type: "agentToolPermissionClear", id: agent.id });
  }

  private hasActiveNonExemptTools(agent: OpenCodeTrackedAgent): boolean {
    for (const toolId of agent.activeToolIds) {
      if (!isPermissionExempt(agent.activeToolNames.get(toolId) ?? "")) return true;
    }
    for (const names of agent.activeSubagentToolNames.values()) {
      for (const toolName of names.values()) {
        if (!isPermissionExempt(toolName)) return true;
      }
    }
    return false;
  }

  private refreshPermissionState(agent: OpenCodeTrackedAgent): void {
    if (this.hasActiveNonExemptTools(agent)) return;
    this.cancelPermissionTimer(agent.id);
    this.clearPermissionBubble(agent);
  }

  private handlePermissionAsked(sessionId: string): void {
    const directAgentId = this.sessionToAgent.get(sessionId);
    if (directAgentId !== undefined) {
      const agent = this.agents.get(directAgentId);
      if (!agent) return;
      if (agent.permissionSent) return;
      agent.permissionSent = true;
      this.broadcast({ type: "agentToolPermission", id: agent.id });
      return;
    }
    const binding = this.childBindings.get(sessionId);
    if (!binding) return;
    this.broadcast({
      type: "subagentToolPermission",
      id: binding.agentId,
      parentToolId: binding.parentToolId,
    });
  }

  private handlePermissionReplied(sessionId: string): void {
    const directAgentId = this.sessionToAgent.get(sessionId);
    if (directAgentId !== undefined) {
      const agent = this.agents.get(directAgentId);
      if (!agent) return;
      agent.permissionSent = false;
      this.broadcast({ type: "agentToolPermissionClear", id: agent.id });
      return;
    }
    const binding = this.childBindings.get(sessionId);
    if (!binding) return;
    const agent = this.agents.get(binding.agentId);
    if (!agent) return;
    agent.permissionSent = false;
    this.broadcast({ type: "agentToolPermissionClear", id: agent.id });
  }

  private startPermissionTimer(agent: OpenCodeTrackedAgent): void {
    this.cancelPermissionTimer(agent.id);
    const timer = setTimeout(() => {
      this.permissionTimers.delete(agent.id);
      if (!this.agents.has(agent.id)) return;
      const stuckSubagentParentToolIds: string[] = [];
      let hasNonExempt = false;
      for (const toolId of agent.activeToolIds) {
        const toolName = agent.activeToolNames.get(toolId) ?? "";
        if (!isPermissionExempt(toolName)) {
          hasNonExempt = true;
          break;
        }
      }
      for (const [parentToolId, names] of agent.activeSubagentToolNames) {
        for (const toolName of names.values()) {
          if (!isPermissionExempt(toolName)) {
            stuckSubagentParentToolIds.push(parentToolId);
            hasNonExempt = true;
            break;
          }
        }
      }
      if (!hasNonExempt) return;
      agent.permissionSent = true;
      this.log(`Agent ${agent.id}: possible permission wait detected`);
      this.broadcast({ type: "agentToolPermission", id: agent.id });
      for (const parentToolId of stuckSubagentParentToolIds) {
        this.broadcast({ type: "subagentToolPermission", id: agent.id, parentToolId });
      }
    }, PERMISSION_TIMER_DELAY_MS);
    this.permissionTimers.set(agent.id, timer);
  }

  private cancelPermissionTimer(agentId: number): void {
    const timer = this.permissionTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.permissionTimers.delete(agentId);
    }
  }

  private resetAgentActivity(agent: OpenCodeTrackedAgent): void {
    this.cancelPermissionTimer(agent.id);
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    agent.activeSubagentToolStatuses.clear();
    agent.pendingSubtaskToolIds = [];
    agent.seenSubtaskPartIds.clear();
    agent.unclaimedChildSessionIds = [];
    agent.isWaiting = false;
    agent.permissionSent = false;
    for (const [sessionId, binding] of this.childBindings) {
      if (binding.agentId === agent.id) {
        this.childBindings.delete(sessionId);
      }
    }
    this.broadcast({ type: "agentToolsClear", id: agent.id });
    this.broadcast({ type: "agentStatus", id: agent.id, status: "active" });
  }

  private async replayAgent(
    agent: OpenCodeTrackedAgent,
    status: OpenCodeSessionStatus | undefined,
    statuses: Record<string, OpenCodeSessionStatus>,
  ): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.resetAgentActivity(agent);

    const messages = await client.getSessionMessages(agent.sessionId).catch((error) => {
      this.log(`Failed to load messages for ${agent.sessionId}: ${String(error)}`);
      return [] as OpenCodeMessageWithParts[];
    });
    for (const message of messages) {
      for (const part of message.parts) {
        this.replayRootPart(agent, part);
      }
    }

    const children = await client.getSessionChildren(agent.sessionId).catch((error) => {
      this.log(`Failed to load children for ${agent.sessionId}: ${String(error)}`);
      return [] as OpenCodeSession[];
    });
    await this.replayChildren(agent, children, 0, statuses);

    // Pending subtask parts with no matching child are stale.
    if (status?.type === "idle") {
      for (const toolId of [...agent.pendingSubtaskToolIds]) {
        this.finishAgentTool(agent, toolId);
      }
    }

    if (status) {
      this.applySessionStatus(agent, status);
    } else {
      this.markAgentActive(agent);
    }
  }

  private replayRootPart(agent: OpenCodeTrackedAgent, part: OpenCodePart): void {
    if (part.type === "tool") {
      this.handleToolPart(agent, part);
      return;
    }
    if (part.type === "subtask") {
      this.handleSubtaskPart(agent, part);
      return;
    }
    if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") {
      this.markAgentActive(agent);
    }
  }

  private async replayChildren(
    agent: OpenCodeTrackedAgent,
    children: OpenCodeSession[],
    depth: number,
    statuses: Record<string, OpenCodeSessionStatus>,
  ): Promise<void> {
    if (!this.client || depth > MAX_CHILD_DEPTH) return;
    for (const child of children) {
      this.knownSessions.set(child.id, child);
      const binding = this.bindChildSession(child, agent);
      const messages = await this.client.getSessionMessages(child.id).catch(() => [] as OpenCodeMessageWithParts[]);
      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type === "tool") {
            this.handleToolPart(agent, part, binding.parentToolId);
          } else if (part.type === "text" || part.type === "reasoning" || part.type === "step-start") {
            this.markAgentActive(agent);
          }
        }
      }
      const grandchildren = await this.client.getSessionChildren(child.id).catch(() => [] as OpenCodeSession[]);
      for (const grandchild of grandchildren) {
        this.childBindings.set(grandchild.id, {
          agentId: agent.id,
          parentToolId: binding.parentToolId,
          direct: false,
          synthetic: false,
          claimed: true,
        });
        this.childSessionTitles.set(grandchild.id, grandchild.title || "OpenCode subtask");
      }
      await this.replayChildren(agent, grandchildren, depth + 1, statuses);

      const childStatus = statuses[child.id];
      if (depth === 0 && binding.direct && (!childStatus || childStatus.type === "idle")) {
        if (agent.activeToolIds.has(binding.parentToolId)) {
          this.finishAgentTool(agent, binding.parentToolId);
        }
      }
    }
  }

  private loadState(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as Partial<PersistedOpenCodeState>;
      this.persistedAgents = Array.isArray(parsed.agents)
        ? parsed.agents.filter(
            (entry): entry is PersistedOpenCodeAgent =>
              Boolean(entry) &&
              typeof entry.id === "number" &&
              typeof entry.sessionId === "string" &&
              typeof entry.projectDir === "string" &&
              typeof entry.projectName === "string",
          )
        : [];
      this.hiddenSessionIds = new Set(
        Array.isArray(parsed.hiddenSessionIds)
          ? parsed.hiddenSessionIds.filter((value): value is string => typeof value === "string")
          : [],
      );
      const maxId = this.persistedAgents.reduce((max, entry) => Math.max(max, entry.id), 0);
      this.nextAgentId = Math.max(
        typeof parsed.nextAgentId === "number" ? parsed.nextAgentId : 1,
        maxId + 1,
        1,
      );
      this.nextSessionIndex = this.persistedAgents.length + 1;
      this.log(`Loaded ${this.persistedAgents.length} persisted agent(s)`);
    } catch (error) {
      this.log(`Failed to load persisted state: ${String(error)}`);
    }
  }

  private saveState(): void {
    try {
      mkdirSync(this.persistDir, { recursive: true });
      const state: PersistedOpenCodeState = {
        version: 1,
        agents: this.getAgents().map((agent) => ({
          id: agent.id,
          sessionId: agent.sessionId,
          projectDir: agent.projectDir,
          projectName: agent.projectName,
          sessionTitle: agent.sessionTitle,
        })),
        hiddenSessionIds: [...this.hiddenSessionIds],
        nextAgentId: this.nextAgentId,
      };
      writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.log(`Failed to save persisted state: ${String(error)}`);
    }
  }
}
