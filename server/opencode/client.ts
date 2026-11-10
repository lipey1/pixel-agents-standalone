import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenCodeBackend, OpenCodeBasicAuth } from "./backend.js";
import { basicAuthHeaders } from "./backend.js";
import { subscribeSse } from "./sse.js";
import type {
  OpenCodeGlobalEvent,
  OpenCodeMessageWithParts,
  OpenCodeSession,
  OpenCodeSessionStatus,
} from "./types.js";

const DEFAULT_SERVER_PORTS = [4096, 18083, 49374];
const V2_PORT_SCAN_LIMIT = 12;
const PORT_SCAN_LIMIT = 8;
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_V2_USERNAME = "opencode";

export interface DiscoveredOpenCodeServer {
  baseUrl: string;
  port: number;
  autoStarted: boolean;
  api: "v1" | "v2";
  auth?: OpenCodeBasicAuth;
  process?: ChildProcess;
}

export interface DiscoverOpenCodeOptions {
  env?: NodeJS.ProcessEnv;
  autoStart?: boolean;
  onLog?: (message: string) => void;
}

export interface AttachLaunchResult {
  ok: boolean;
  method: string;
  command: string;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
  let trimmed = value.trim().replace(/\/+$/, "");
  if (/\/api$/i.test(trimmed)) trimmed = trimmed.slice(0, -4);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function parseExplicitUrl(value: string): { baseUrl: string; auth?: OpenCodeBasicAuth } {
  let trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`;
  try {
    const url = new URL(trimmed);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";
    if (url.pathname === "/" || url.pathname === "/api") {
      url.pathname = "";
    } else if (url.pathname.endsWith("/api")) {
      url.pathname = url.pathname.slice(0, -4);
    }
    const baseUrl = url.toString().replace(/\/+$/, "");
    return { baseUrl, auth: username ? { username, password } : undefined };
  } catch {
    return { baseUrl: normalizeBaseUrl(value) };
  }
}

function envAuth(env: NodeJS.ProcessEnv): OpenCodeBasicAuth | null {
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD;
  if (!password) return null;
  return {
    username: env.OPENCODE_USERNAME || env.OPENCODE_SERVER_USERNAME || DEFAULT_V2_USERNAME,
    password,
  };
}

function readDesktopServiceAuth(env: NodeJS.ProcessEnv): OpenCodeBasicAuth | null {
  const candidates = [
    join(homedir(), ".config", "opencode", "service.json"),
    env.APPDATA ? join(env.APPDATA, "ai.opencode.desktop", "service.json") : "",
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "ai.opencode.desktop", "service.json") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        username?: unknown;
        password?: unknown;
      };
      if (typeof parsed.password === "string" && parsed.password) {
        return {
          username:
            typeof parsed.username === "string" && parsed.username ? parsed.username : DEFAULT_V2_USERNAME,
          password: parsed.password,
        };
      }
    } catch {
      /* try the next location */
    }
  }
  return null;
}

function dedupeAuths(values: Array<OpenCodeBasicAuth | null | undefined>): OpenCodeBasicAuth[] {
  const result: OpenCodeBasicAuth[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = `${value.username}\u0000${value.password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function authCandidates(env: NodeJS.ProcessEnv, explicit?: OpenCodeBasicAuth): OpenCodeBasicAuth[] {
  return dedupeAuths([explicit, envAuth(env), readDesktopServiceAuth(env)]);
}

/**
 * OpenCode Desktop starts `opencode-cli serve --service` on a random loopback
 * port and records it in the newest main.log as
 * `url: 'http://127.0.0.1:28894'`.
 */
function readDesktopServicePorts(env: NodeJS.ProcessEnv): number[] {
  const appData = env.APPDATA || process.env.APPDATA;
  if (!appData) return [];
  const logsRoot = join(appData, "ai.opencode.desktop", "logs");
  if (!existsSync(logsRoot)) return [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(logsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 4);
  } catch {
    return [];
  }

  const ports = new Set<number>();
  for (const dir of dirs) {
    const logPath = join(logsRoot, dir, "main.log");
    if (!existsSync(logPath)) continue;
    try {
      const text = readFileSync(logPath, "utf8");
      const regex = /(?:url:\s*['"]|https?:\/\/)(?:127\.0\.0\.1|localhost):(\d+)/g;
      for (const match of text.matchAll(regex)) {
        const port = Number.parseInt(match[1], 10);
        if (port > 0 && port < 65536) ports.add(port);
      }
    } catch {
      /* ignore unreadable logs */
    }
    if (ports.size >= 4) break;
  }
  return [...ports];
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : null;
}

function portFromUrl(baseUrl: string): number {
  try {
    const url = new URL(baseUrl);
    if (url.port) return Number.parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeOpenCodeServer(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}/global/health`,
      { headers: { accept: "application/json" } },
      timeoutMs,
    );
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") ?? "";
    // OpenCode v2 serves the SPA (HTTP 200, text/html) for unknown routes such
    // as /global/health. Require a JSON health payload so we don't mistake the
    // v2 web UI for a v1 API.
    if (!contentType.includes("application/json")) return false;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return Boolean(
      body && typeof body === "object" && (typeof body.healthy === "boolean" || typeof body.version === "string"),
    );
  } catch {
    return false;
  }
}

export async function probeOpenCodeV2Server(
  baseUrl: string,
  auth?: OpenCodeBasicAuth,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}/api/session`,
      { headers: { accept: "application/json", ...basicAuthHeaders(auth) } },
      timeoutMs,
    );
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return false;
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    return Boolean(body && Array.isArray(body.data));
  } catch {
    return false;
  }
}

async function probeV2WithAuths(
  baseUrl: string,
  auths: OpenCodeBasicAuth[],
  timeoutMs: number,
): Promise<OpenCodeBasicAuth | undefined | null> {
  for (const auth of auths) {
    if (await probeOpenCodeV2Server(baseUrl, auth, timeoutMs)) return auth;
  }
  if (await probeOpenCodeV2Server(baseUrl, undefined, timeoutMs)) return undefined;
  return null;
}

async function detectServer(
  baseUrl: string,
  auths: OpenCodeBasicAuth[],
  timeoutMs: number,
): Promise<{ api: "v1" | "v2"; auth?: OpenCodeBasicAuth } | null> {
  if (await probeOpenCodeServer(baseUrl, timeoutMs)) return { api: "v1" };
  const auth = await probeV2WithAuths(baseUrl, auths, timeoutMs);
  if (auth !== null) return { api: "v2", auth };
  return null;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort: number, attempts = 30): Promise<number | null> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) break;
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

function candidatePorts(env: NodeJS.ProcessEnv): number[] {
  const ports = new Set<number>();
  const envPort = parsePort(env.OPENCODE_PORT);
  if (envPort) ports.add(envPort);
  for (const port of DEFAULT_SERVER_PORTS) {
    ports.add(port);
  }
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    ports.add(4096 + offset);
    ports.add(18083 + offset);
  }
  return [...ports];
}

function candidateV2Ports(env: NodeJS.ProcessEnv): number[] {
  const ports = new Set<number>();
  const envPort = parsePort(env.OPENCODE_PORT);
  if (envPort) ports.add(envPort);
  for (const port of readDesktopServicePorts(env)) ports.add(port);
  for (let offset = 0; offset < V2_PORT_SCAN_LIMIT; offset += 1) ports.add(4096 + offset);
  return [...ports];
}

function getExecutable(env: NodeJS.ProcessEnv): string {
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

interface StartAttempt {
  child: ChildProcess;
  getStderr: () => string;
  getSpawnError: () => Error | null;
}

function startServerProcess(executable: string, args: string[], cwd: string): StartAttempt {
  let stderr = "";
  let spawnError: Error | null = null;
  const child = spawn(executable, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && executable.endsWith(".cmd"),
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  child.stdout?.on("data", () => {
    /* Drain stdout so the child doesn't block on a full pipe. */
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  return { child, getStderr: () => stderr, getSpawnError: () => spawnError };
}

async function waitForServer(
  baseUrl: string,
  attempt: StartAttempt,
  auths: OpenCodeBasicAuth[],
  onLog?: (message: string) => void,
): Promise<{ api: "v1" | "v2"; auth?: OpenCodeBasicAuth } | null> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastReport = 0;
  while (Date.now() < deadline) {
    const detected = await detectServer(baseUrl, auths, 1_000);
    if (detected) return detected;
    const spawnError = attempt.getSpawnError();
    if (spawnError) {
      onLog?.(`Could not launch OpenCode: ${spawnError.message}`);
      return null;
    }
    if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) {
      const stderr = attempt.getStderr().trim();
      onLog?.(`OpenCode server exited before becoming ready${stderr ? `: ${stderr}` : ""}`);
      return null;
    }
    if (Date.now() - lastReport > 5_000) {
      lastReport = Date.now();
      onLog?.("Waiting for OpenCode server to become ready...");
    }
    await delay(SERVER_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Find a running OpenCode server or, when allowed, start one.
 *
 * Supports both the legacy v1 API (`/global/health`, `/session`, `/global/event`)
 * and the v2 API used by OpenCode Desktop (`/api/session`, `/api/event`, Basic auth).
 */
export async function discoverOpenCodeServer(options: DiscoverOpenCodeOptions = {}): Promise<DiscoveredOpenCodeServer | null> {
  const env = options.env ?? process.env;
  const onLog = options.onLog ?? (() => {});
  const explicitUrl = env.OPENCODE_URL || env.OPENCODE_SERVER_URL;
  const auths = authCandidates(env);

  if (explicitUrl) {
    const explicit = parseExplicitUrl(explicitUrl);
    const explicitAuths = authCandidates(env, explicit.auth);
    const detected = await detectServer(explicit.baseUrl, explicitAuths, 2_000);
    if (detected) {
      onLog(`Found OpenCode ${detected.api} server at ${explicit.baseUrl}`);
      return {
        baseUrl: explicit.baseUrl,
        port: portFromUrl(explicit.baseUrl),
        autoStarted: false,
        api: detected.api,
        auth: detected.auth,
      };
    }
    onLog(
      `OPENCODE_URL is set to ${explicit.baseUrl}, but neither /global/health (v1) nor /api/session (v2) responded with JSON.`,
    );
    return null;
  }

  // Legacy v1 servers. The v2 web UI returns HTTP 200 HTML for /global/health,
  // so probeOpenCodeServer validates the JSON payload before accepting a port.
  for (const port of candidatePorts(env)) {
    const baseUrl = `http://127.0.0.1:${port}`;
    if (await probeOpenCodeServer(baseUrl, 700)) {
      onLog(`Found OpenCode v1 server at ${baseUrl}`);
      return { baseUrl, port, autoStarted: false, api: "v1" };
    }
  }

  // OpenCode Desktop's background service and standalone v2 servers. Desktop
  // uses a random port recorded in its main.log and Basic auth stored in
  // ~/.config/opencode/service.json.
  for (const port of candidateV2Ports(env)) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = await probeV2WithAuths(baseUrl, auths, 700);
    if (auth !== null) {
      onLog(
        `Found OpenCode v2 server at ${baseUrl}${auth ? ` (Basic auth user "${auth.username}")` : ""}`,
      );
      return { baseUrl, port, autoStarted: false, api: "v2", auth };
    }
  }

  if (options.autoStart === false || env.PIXEL_AGENTS_OPENCODE_AUTOSTART === "0") {
    return null;
  }

  const preferredPort = parsePort(env.OPENCODE_PORT) ?? 4096;
  const port = await findAvailablePort(preferredPort);
  if (!port) {
    onLog(`No free port found near ${preferredPort}; cannot start OpenCode server.`);
    return null;
  }

  const executable = getExecutable(env);
  const baseUrl = `http://127.0.0.1:${port}`;
  const cwd = env.PIXEL_AGENTS_PROJECT_DIR || process.cwd();
  onLog(`Starting OpenCode server: ${executable} serve --hostname 127.0.0.1 --port ${port} (cwd ${cwd})`);

  // Both v1 and v2 use `opencode serve`; older v1 builds accepted the flags directly.
  const commandVariants: string[][] = [
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    ["--hostname", "127.0.0.1", "--port", String(port)],
  ];

  for (const args of commandVariants) {
    const attempt = startServerProcess(executable, args, cwd);
    const detected = await waitForServer(baseUrl, attempt, auths, onLog);
    if (detected) {
      onLog(`OpenCode ${detected.api} server is ready at ${baseUrl}`);
      attempt.child.unref();
      return {
        baseUrl,
        port,
        autoStarted: true,
        api: detected.api,
        auth: detected.auth,
        process: attempt.child,
      };
    }
    if (attempt.getSpawnError()) {
      break;
    }
    if (attempt.child.exitCode === null && attempt.child.signalCode === null) {
      attempt.child.kill();
    }
  }

  onLog(
    "Could not start an OpenCode server. Install OpenCode (v1 CLI or Desktop v2), or set OPENCODE_URL / OPENCODE_PASSWORD.",
  );
  return null;
}

export class OpenCodeClient implements OpenCodeBackend {
  readonly baseUrl: string;
  readonly apiVersion = "v1" as const;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenCode request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  private unwrap<T>(value: unknown): T {
    if (value && typeof value === "object" && "data" in value) {
      return (value as { data: T }).data;
    }
    return value as T;
  }

  async health(): Promise<boolean> {
    return probeOpenCodeServer(this.baseUrl);
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const result = await this.request<unknown>("/session");
    const sessions = this.unwrap<OpenCodeSession[]>(result);
    return Array.isArray(sessions) ? sessions : [];
  }

  async getSession(sessionId: string): Promise<OpenCodeSession> {
    const result = await this.request<unknown>(`/session/${encodeURIComponent(sessionId)}`);
    return this.unwrap<OpenCodeSession>(result);
  }

  async createSession(title?: string, _directory?: string): Promise<OpenCodeSession> {
    const result = await this.request<unknown>("/session", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    });
    return this.unwrap<OpenCodeSession>(result);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`OpenCode delete failed: ${response.status} ${response.statusText}`);
    }
  }

  async getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
    const result = await this.request<unknown>("/session/status");
    const statuses = this.unwrap<Record<string, OpenCodeSessionStatus>>(result);
    return statuses && typeof statuses === "object" ? statuses : {};
  }

  async getSessionMessages(sessionId: string): Promise<OpenCodeMessageWithParts[]> {
    const result = await this.request<unknown>(`/session/${encodeURIComponent(sessionId)}/message`);
    const messages = this.unwrap<OpenCodeMessageWithParts[]>(result);
    return Array.isArray(messages) ? messages : [];
  }

  async getSessionChildren(sessionId: string): Promise<OpenCodeSession[]> {
    const result = await this.request<unknown>(`/session/${encodeURIComponent(sessionId)}/children`);
    const children = this.unwrap<OpenCodeSession[]>(result);
    return Array.isArray(children) ? children : [];
  }

  buildAttachCommand(sessionId: string, cwd?: string): string {
    const dirPart = cwd ? ` --dir "${cwd.replace(/"/g, '\\"')}"` : "";
    return `opencode attach ${this.baseUrl} --session ${sessionId}${dirPart}`;
  }

  subscribe(
    onEvent: (event: OpenCodeGlobalEvent) => void,
    handlers: {
      onError?: (error: unknown) => void;
      onOpen?: () => void;
    } = {},
  ): { dispose: () => void } {
    return subscribeSse(
      `${this.baseUrl}/global/event`,
      { headers: { accept: "text/event-stream" } },
      (value) => onEvent(value as OpenCodeGlobalEvent),
      handlers,
    );
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Open `opencode attach` in a new terminal window when a supported terminal
 * emulator exists. Returns ok=false (plus the command) when it cannot.
 */
export function launchAttachTerminal(command: string, title = "Pixel Agents — OpenCode"): AttachLaunchResult {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", title, "cmd.exe", "/k", command], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.on("error", () => {});
      child.unref();
      return { ok: true, method: "cmd start", command };
    }

    if (process.platform === "darwin") {
      const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const escapedCommand = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `tell application "Terminal"\nactivate\ndo script "printf '\\\\033]0;${escapedTitle}\\\\007'; ${escapedCommand}"\nend tell`;
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return { ok: true, method: "AppleScript Terminal", command };
    }

    const fullCommand = `${command}; exec bash`;
    const terminals: Array<{ bin: string; args: string[] }> = [
      { bin: "x-terminal-emulator", args: ["-e", "sh", "-c", fullCommand] },
      { bin: "gnome-terminal", args: ["--", "sh", "-c", fullCommand] },
      { bin: "konsole", args: ["-e", "sh", "-c", fullCommand] },
      { bin: "xterm", args: ["-e", "sh", "-c", fullCommand] },
    ];
    for (const terminal of terminals) {
      const available = spawnSync("sh", ["-c", `command -v ${shellSingleQuote(terminal.bin)}`], { stdio: "ignore" });
      if (available.status !== 0) continue;
      const child = spawn(terminal.bin, terminal.args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return { ok: true, method: terminal.bin, command };
    }

    return {
      ok: false,
      method: "none",
      command,
      error: "No supported terminal emulator found. Run the command manually.",
    };
  } catch (error) {
    return {
      ok: false,
      method: "error",
      command,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { quoteForCmd };
