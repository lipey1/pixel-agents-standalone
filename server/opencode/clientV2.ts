import type { OpenCodeBackend, OpenCodeBasicAuth } from "./backend.js";
import { basicAuthHeaders } from "./backend.js";
import { subscribeSse } from "./sse.js";
import type {
  OpenCodeGlobalEvent,
  OpenCodeMessageWithParts,
  OpenCodePart,
  OpenCodeSession,
  OpenCodeSessionStatus,
  OpenCodeV2AssistantPart,
  OpenCodeV2Event,
  OpenCodeV2Message,
  OpenCodeV2Session,
  OpenCodeV2ToolPart,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_CACHE_MS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeStatus(status: unknown): string {
  if (status === "streaming") return "running";
  return typeof status === "string" && status ? status : "completed";
}

function normalizeToolInput(toolName: string, value: unknown): Record<string, unknown> {
  const input = { ...(asRecord(value) ?? {}) };
  if (typeof input.path === "string" && typeof input.file_path !== "string") {
    input.file_path = input.path;
  }
  if ((toolName === "read" || toolName === "edit" || toolName === "write") && typeof input.file_path !== "string" && typeof input.file === "string") {
    input.file_path = input.file;
  }
  return input;
}

function toolOutput(part: OpenCodeV2ToolPart): string | undefined {
  const content = part.state?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => (item && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function toolError(part: OpenCodeV2ToolPart): string | undefined {
  const error = part.state?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = asString((error as Record<string, unknown>).message);
    if (message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class OpenCodeV2Client implements OpenCodeBackend {
  readonly baseUrl: string;
  readonly apiVersion = "v2" as const;

  private readonly auth?: OpenCodeBasicAuth;
  private sessionCache: { at: number; value: OpenCodeSession[] } | null = null;
  /** Tool call ID -> OpenCode tool name. v2 success/failure events omit the name. */
  private readonly toolNames = new Map<string, string>();

  constructor(baseUrl: string, auth?: OpenCodeBasicAuth) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = auth;
  }

  private async request<T>(pathname: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...basicAuthHeaders(this.auth),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const hint =
          response.status === 401
            ? " (set OPENCODE_PASSWORD, or make sure the Desktop service password is readable)"
            : "";
        throw new Error(
          `OpenCode v2 request failed: ${response.status} ${response.statusText}${hint}${body ? ` — ${body.slice(0, 300)}` : ""}`,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private unwrap<T>(value: unknown): T {
    const record = asRecord(value);
    if (record && "data" in record) return record.data as T;
    return value as T;
  }

  private mapSession(session: OpenCodeV2Session): OpenCodeSession {
    return {
      id: session.id,
      title: session.title || session.id.slice(0, 8),
      directory: session.location?.directory,
      parentID: session.parentID,
      projectID: session.projectID,
      time: {
        created: session.time?.created,
        updated: session.time?.updated,
        completed: session.time?.idle,
      },
    };
  }

  private async fetchSessions(force = false): Promise<OpenCodeSession[]> {
    const now = Date.now();
    if (!force && this.sessionCache && now - this.sessionCache.at < SESSION_CACHE_MS) {
      return this.sessionCache.value;
    }
    const result = await this.request<unknown>("/api/session");
    const raw = this.unwrap<OpenCodeV2Session[]>(result);
    const sessions = (Array.isArray(raw) ? raw : [])
      .filter((session) => session && typeof session.id === "string" && !session.time?.archived)
      .map((session) => this.mapSession(session));
    this.sessionCache = { at: now, value: sessions };
    return sessions;
  }

  async health(): Promise<boolean> {
    try {
      await this.fetchSessions(true);
      return true;
    } catch {
      return false;
    }
  }

  listSessions(): Promise<OpenCodeSession[]> {
    return this.fetchSessions();
  }

  async getSession(sessionId: string): Promise<OpenCodeSession> {
    const result = await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}`);
    return this.mapSession(this.unwrap<OpenCodeV2Session>(result));
  }

  async createSession(title?: string, directory?: string): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    if (directory) body.location = { directory };
    const result = await this.request<unknown>("/api/session", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const session = this.mapSession(this.unwrap<OpenCodeV2Session>(result));
    this.sessionCache = null;
    return session;
  }

  async getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
    const [activeResult, sessionsResult] = await Promise.allSettled([
      this.request<unknown>("/api/session/active"),
      this.fetchSessions(true),
    ]);
    const active = activeResult.status === "fulfilled" ? this.unwrap<Record<string, unknown>>(activeResult.value) : {};
    const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
    const statuses: Record<string, OpenCodeSessionStatus> = {};
    for (const session of sessions) {
      statuses[session.id] = active && active[session.id] ? { type: "busy" } : { type: "idle" };
    }
    if (active && typeof active === "object") {
      for (const sessionId of Object.keys(active)) {
        if (!statuses[sessionId]) statuses[sessionId] = { type: "busy" };
      }
    }
    return statuses;
  }

  async getSessionMessages(sessionId: string): Promise<OpenCodeMessageWithParts[]> {
    const result = await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/message`);
    const messages = this.unwrap<OpenCodeV2Message[]>(result);
    return (Array.isArray(messages) ? messages : []).map((message) => this.mapMessage(sessionId, message));
  }

  async getSessionChildren(sessionId: string): Promise<OpenCodeSession[]> {
    const sessions = await this.fetchSessions();
    return sessions.filter((session) => session.parentID === sessionId);
  }

  buildAttachCommand(sessionId: string, cwd?: string): string {
    const dirPart = cwd ? ` "${cwd.replace(/"/g, '\\"')}"` : "";
    // Without --server the v2 CLI talks to the Desktop background service and
    // picks up its credentials from ~/.config/opencode/service.json.
    return `opencode --session "${sessionId}"${dirPart}`;
  }

  private mapMessage(sessionId: string, message: OpenCodeV2Message): OpenCodeMessageWithParts {
    const cacheKey = `${sessionId}:${message.id}`;
    const info = {
      id: message.id,
      sessionID: sessionId,
      role: message.type === "user" ? ("user" as const) : ("assistant" as const),
      time: { created: message.time?.created, completed: message.time?.completed },
    };
    const parts: OpenCodePart[] = [];

    if (message.type === "assistant" && Array.isArray(message.content)) {
      message.content.forEach((part, index) => {
        const mapped = this.mapAssistantPart(sessionId, message.id, part, index, cacheKey);
        if (mapped) parts.push(mapped);
      });
      return { info, parts };
    }

    if (typeof message.text === "string" && message.text) {
      parts.push({
        id: `${message.id}:text`,
        sessionID: sessionId,
        messageID: message.id,
        type: "text",
        text: message.text,
      });
    }
    return { info, parts };
  }

  private mapAssistantPart(
    sessionId: string,
    messageId: string,
    part: OpenCodeV2AssistantPart,
    index: number,
    cacheKey: string,
  ): OpenCodePart | null {
    if (!part || typeof part !== "object") return null;
    if (part.type === "tool") {
      const tool = part as OpenCodeV2ToolPart;
      const toolName = tool.name || "tool";
      if (toolName === "subagent") {
        const input = asRecord(tool.state?.input) ?? {};
        return {
          id: tool.id,
          sessionID: sessionId,
          messageID: messageId,
          type: "subtask",
          description: asString(input.description),
          prompt: asString(input.prompt),
          agent: asString(input.agent),
        };
      }
      return {
        id: tool.id,
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        tool: toolName,
        callID: tool.id,
        state: {
          status: normalizeStatus(tool.state?.status),
          input: normalizeToolInput(toolName, tool.state?.input),
          output: toolOutput(tool),
          error: toolError(tool),
          metadata: tool.state?.metadata,
        },
      };
    }
    if (part.type === "text" || part.type === "reasoning") {
      return {
        id: `${messageId}:${cacheKey}:${index}`,
        sessionID: sessionId,
        messageID: messageId,
        type: part.type,
        text: part.text,
      };
    }
    return null;
  }

  private toolPart(
    event: OpenCodeV2Event,
    data: Record<string, unknown>,
    status: string,
    input?: unknown,
  ): OpenCodeGlobalEvent | null {
    const sessionID = asString(data.sessionID);
    const toolId = asString(data.id);
    if (!sessionID || !toolId) return null;
    const name = this.toolNames.get(toolId) ?? asString(data.name) ?? "tool";
    const messageID = asString(data.assistantMessageID) ?? `${event.id ?? toolId}:assistant`;
    const part: OpenCodePart = {
      id: toolId,
      sessionID,
      messageID,
      type: "tool",
      tool: name,
      callID: toolId,
      state: {
        status,
        input: normalizeToolInput(name, input),
      },
    };
    return this.partUpdated(part);
  }

  private subtaskPart(event: OpenCodeV2Event, data: Record<string, unknown>): OpenCodeGlobalEvent | null {
    const sessionID = asString(data.sessionID);
    const toolId = asString(data.id);
    if (!sessionID || !toolId) return null;
    const input = asRecord(data.input) ?? {};
    const part: OpenCodePart = {
      id: toolId,
      sessionID,
      messageID: asString(data.assistantMessageID) ?? `${event.id ?? toolId}:assistant`,
      type: "subtask",
      description: asString(input.description),
      prompt: asString(input.prompt),
      agent: asString(input.agent),
    };
    return this.partUpdated(part);
  }

  private partUpdated(part: OpenCodePart): OpenCodeGlobalEvent {
    return { payload: { type: "message.part.updated", properties: { part } } };
  }

  private markPart(sessionID: string | undefined, type: "text" | "reasoning" | "step-start"): OpenCodeGlobalEvent | null {
    if (!sessionID) return null;
    const part: OpenCodePart = {
      id: `${type}-${Date.now()}`,
      sessionID,
      messageID: "",
      type,
    };
    return this.partUpdated(part);
  }

  /** Convert a v2 SSE event into the v1-shaped event consumed by OpenCodeSource. */
  private translate(raw: unknown): OpenCodeGlobalEvent | null {
    const event = raw as OpenCodeV2Event;
    if (!event || typeof event.type !== "string") return null;
    const data = asRecord(event.data) ?? {};
    const sessionID = asString(data.sessionID);
    const location = event.location?.directory;

    switch (event.type) {
      case "session.created": {
        if (!sessionID) return null;
        const info: OpenCodeSession = {
          id: sessionID,
          title: asString(data.title) ?? sessionID.slice(0, 8),
          directory: asRecord(data.location)?.directory as string | undefined,
          parentID: asString(data.parentID),
          projectID: asString(data.projectID),
          time: { created: event.created, updated: event.created },
        };
        if (!info.directory) info.directory = location;
        return { directory: location, payload: { type: "session.created", properties: { info } } };
      }

      case "session.renamed": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: {
            type: "session.updated",
            properties: { info: { id: sessionID, title: asString(data.title) } },
          },
        };
      }

      case "session.moved": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: {
            type: "session.updated",
            properties: {
              info: {
                id: sessionID,
                directory: asRecord(data.location)?.directory as string | undefined,
                time: { updated: event.created },
              },
            },
          },
        };
      }

      case "session.deleted":
      case "session.archived": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: { type: "session.deleted", properties: { info: { id: sessionID }, sessionID } },
        };
      }

      case "session.idle": {
        if (!sessionID) return null;
        return { directory: location, payload: { type: "session.idle", properties: { sessionID } } };
      }

      case "session.status": {
        if (!sessionID) return null;
        const status = asRecord(data.status);
        if (!status || typeof status.type !== "string") return null;
        return { directory: location, payload: { type: "session.status", properties: { sessionID, status } } };
      }

      case "session.execution.started": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
        };
      }

      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
        };
      }

      case "session.retry.scheduled": {
        if (!sessionID) return null;
        const error = asRecord(data.error);
        return {
          directory: location,
          payload: {
            type: "session.status",
            properties: {
              sessionID,
              status: {
                type: "retry",
                message:
                  asString(error?.message) ??
                  asString(data.message) ??
                  "Retrying OpenCode request",
                attempt: typeof data.attempt === "number" ? data.attempt : 0,
                next: typeof data.at === "number" ? data.at : 0,
              },
            },
          },
        };
      }

      case "permission.asked": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: {
            type: "permission.asked",
            properties: { sessionID, permission: { sessionID, id: asString(data.id) } },
          },
        };
      }

      case "permission.replied": {
        if (!sessionID) return null;
        return {
          directory: location,
          payload: {
            type: "permission.replied",
            properties: { sessionID, requestID: asString(data.requestID), reply: asString(data.reply) },
          },
        };
      }

      case "session.tool.input.started": {
        // The input is still streaming at this point and `session.tool.called`
        // is the event that carries the parsed input (path, command, prompt).
        // Only remember the tool name so later events can label it.
        const toolId = asString(data.id);
        const name = asString(data.name) ?? "tool";
        if (toolId) this.toolNames.set(toolId, name);
        return null;
      }

      case "session.tool.called": {
        const toolId = asString(data.id);
        const name = (toolId && this.toolNames.get(toolId)) || asString(data.name) || "tool";
        if (name === "subagent") return this.subtaskPart(event, data);
        return this.toolPart(event, data, "running", data.input);
      }

      case "session.tool.success": {
        const toolId = asString(data.id);
        const name = (toolId && this.toolNames.get(toolId)) || asString(data.name) || "tool";
        if (toolId) this.toolNames.delete(toolId);
        if (name === "subagent") {
          const childSessionID = asString(asRecord(data.metadata)?.sessionID);
          if (!childSessionID) return null;
          return {
            directory: location,
            payload: { type: "session.idle", properties: { sessionID: childSessionID } },
          };
        }
        return this.toolPart(event, data, "completed", data.input);
      }

      case "session.tool.failed": {
        const toolId = asString(data.id);
        const name = (toolId && this.toolNames.get(toolId)) || asString(data.name) || "tool";
        if (toolId) this.toolNames.delete(toolId);
        if (name === "subagent") {
          const childSessionID = asString(asRecord(data.metadata)?.sessionID);
          if (!childSessionID) return null;
          return {
            directory: location,
            payload: { type: "session.idle", properties: { sessionID: childSessionID } },
          };
        }
        return this.toolPart(event, data, "error", data.input);
      }

      case "session.text.started":
      case "session.reasoning.started":
      case "session.step.started":
      case "session.compaction.started": {
        const type = event.type.includes("reasoning")
          ? "reasoning"
          : event.type.includes("step")
            ? "step-start"
            : "text";
        return this.markPart(sessionID, type);
      }

      case "session.text.ended":
      case "session.reasoning.ended":
      case "session.step.ended":
      case "session.step.streamed":
      case "session.compaction.ended": {
        const type = event.type.includes("reasoning")
          ? "reasoning"
          : event.type.includes("step")
            ? "step-start"
            : "text";
        return this.markPart(sessionID, type);
      }

      default:
        return null;
    }
  }

  subscribe(
    onEvent: (event: OpenCodeGlobalEvent) => void,
    handlers: { onError?: (error: unknown) => void; onOpen?: () => void } = {},
  ): { dispose: () => void } {
    return subscribeSse(
      `${this.baseUrl}/api/event`,
      {
        headers: {
          accept: "text/event-stream",
          ...basicAuthHeaders(this.auth),
        },
      },
      (value) => {
        const translated = this.translate(value);
        if (translated) onEvent(translated);
      },
      handlers,
    );
  }
}
