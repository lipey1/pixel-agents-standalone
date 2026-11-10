import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type {
  OpenCodeV2Event,
  OpenCodeV2Message,
  OpenCodeV2Session,
} from "../server/opencode/types.js";

export interface MockOpenCodeV2Options {
  port?: number;
  host?: string;
  directory?: string;
  username?: string;
  password?: string;
  initialSessions?: Array<Partial<OpenCodeV2Session> & { id: string; title?: string }>;
}

export interface MockOpenCodeV2Server {
  port: number;
  baseUrl: string;
  username: string;
  password: string;
  sessions: Map<string, OpenCodeV2Session>;
  messages: Map<string, OpenCodeV2Message[]>;
  active: Set<string>;
  deletedSessions: string[];
  addSession: (session: Partial<OpenCodeV2Session> & { id: string }) => OpenCodeV2Session;
  setMessages: (sessionId: string, messages: OpenCodeV2Message[]) => void;
  setActive: (sessionId: string, active: boolean) => void;
  emit: (type: string, data: Record<string, unknown>) => OpenCodeV2Event;
  close: () => Promise<void>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(value),
  });
  res.end(value);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function authHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export async function createMockOpenCodeV2Server(
  options: MockOpenCodeV2Options = {},
): Promise<MockOpenCodeV2Server> {
  const host = options.host ?? "127.0.0.1";
  const directory = options.directory ?? process.cwd();
  const username = options.username ?? "opencode";
  const password = options.password ?? "mock-password";
  const expectedAuth = authHeader(username, password);
  const sessions = new Map<string, OpenCodeV2Session>();
  const messages = new Map<string, OpenCodeV2Message[]>();
  const active = new Set<string>();
  const deletedSessions: string[] = [];
  const sseClients = new Set<ServerResponse>();
  let nextEventId = 1;

  const addSession = (input: Partial<OpenCodeV2Session> & { id: string }): OpenCodeV2Session => {
    const now = Date.now();
    const session: OpenCodeV2Session = {
      id: input.id,
      parentID: input.parentID,
      projectID: input.projectID ?? "mock-project",
      agent: input.agent ?? "build",
      title: input.title ?? input.id,
      time: input.time ?? { created: now, updated: now },
      location: input.location ?? { directory },
    };
    sessions.set(session.id, session);
    if (!messages.has(session.id)) messages.set(session.id, []);
    return session;
  };

  for (const initial of options.initialSessions ?? []) addSession(initial);

  const sendEvent = (event: OpenCodeV2Event): void => {
    const payload = JSON.stringify(event);
    for (const client of sseClients) {
      client.write(`data: ${payload}\n\n`);
    }
  };

  const emit = (type: string, data: Record<string, unknown>): OpenCodeV2Event => {
    const event: OpenCodeV2Event = {
      id: `evt_mock_${nextEventId++}`,
      created: Date.now(),
      type,
      location: {
        directory:
          (typeof data.sessionID === "string" && sessions.get(data.sessionID)?.location?.directory) || directory,
      },
      data,
    };
    if (type === "session.created") {
      const sessionId = typeof data.sessionID === "string" ? data.sessionID : null;
      if (sessionId) {
        addSession({
          id: sessionId,
          parentID: typeof data.parentID === "string" ? data.parentID : undefined,
          title: typeof data.title === "string" ? data.title : sessionId,
          location: (data.location as OpenCodeV2Session["location"]) ?? { directory },
        });
      }
    }
    if (type === "session.deleted") {
      const sessionId = typeof data.sessionID === "string" ? data.sessionID : null;
      if (sessionId) {
        sessions.delete(sessionId);
        messages.delete(sessionId);
        active.delete(sessionId);
      }
    }
    sendEvent(event);
    return event;
  };

  const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.headers.authorization === expectedAuth) return true;
    res.setHeader("www-authenticate", 'Basic realm="OpenCode"');
    json(res, 401, { error: "unauthorized" });
    return false;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${options.port ?? 0}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/global/health") {
      // v1 health must not respond for the v2 mock; discovery should fall
      // through to the authenticated /api/session probe.
      json(res, 404, { error: "not found" });
      return;
    }

    if (pathname === "/api/event") {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(
        `data: ${JSON.stringify({
          id: `evt_mock_${nextEventId++}`,
          created: Date.now(),
          type: "server.connected",
          data: {},
        })}\n\n`,
      );
      sseClients.add(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === "/__state" && req.method === "GET") {
      if (!requireAuth(req, res)) return;
      json(res, 200, {
        sessions: [...sessions.values()],
        messages: Object.fromEntries(messages),
        active: [...active],
        deletedSessions,
      });
      return;
    }

    if (pathname === "/__emit" && req.method === "POST") {
      if (!requireAuth(req, res)) return;
      const raw = await readBody(req);
      try {
        const event = JSON.parse(raw) as { type: string; data: Record<string, unknown> };
        emit(event.type, event.data ?? {});
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { error: String(error) });
      }
      return;
    }

    if (!pathname.startsWith("/api/")) {
      text(res, 404, "not found");
      return;
    }
    if (!requireAuth(req, res)) return;

    if (pathname === "/api/session" && req.method === "GET") {
      json(res, 200, { data: [...sessions.values()].filter((session) => !session.time.archived) });
      return;
    }

    if (pathname === "/api/session" && req.method === "POST") {
      const raw = await readBody(req);
      let body: {
        title?: unknown;
        parentID?: unknown;
        location?: { directory?: unknown };
      } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        /* ignore invalid JSON */
      }
      const id = `ses_mock_v2_${sessions.size + 1}_${Date.now()}`;
      const sessionDirectory =
        typeof body.location?.directory === "string" && body.location.directory
          ? body.location.directory
          : directory;
      const session: OpenCodeV2Session = {
        id,
        parentID: typeof body.parentID === "string" ? body.parentID : undefined,
        projectID: "mock-project",
        agent: "build",
        title: typeof body.title === "string" && body.title ? body.title : id,
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: sessionDirectory },
      };
      sessions.set(id, session);
      messages.set(id, []);
      json(res, 200, { data: session });
      sendEvent({
        id: `evt_mock_${nextEventId++}`,
        created: Date.now(),
        type: "session.created",
        location: { directory: sessionDirectory },
        data: {
          sessionID: id,
          projectID: session.projectID,
          title: session.title,
          location: session.location,
          parentID: session.parentID,
        },
      });
      return;
    }

    if (pathname === "/api/session/active" && req.method === "GET") {
      const data: Record<string, { type: string }> = {};
      for (const sessionId of active) data[sessionId] = { type: "running" };
      json(res, 200, { data });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)(?:\/(message|permission))?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const suffix = sessionMatch[2];
      if (suffix === "message" && req.method === "GET") {
        json(res, 200, { data: messages.get(sessionId) ?? [] });
        return;
      }
      if (suffix === "permission" && req.method === "GET") {
        json(res, 200, { data: [] });
        return;
      }
      if (req.method === "GET") {
        const session = sessions.get(sessionId);
        if (!session) {
          json(res, 404, { error: "session not found" });
          return;
        }
        json(res, 200, { data: session });
        return;
      }
      if (req.method === "DELETE") {
        deletedSessions.push(sessionId);
        const removed = sessions.get(sessionId);
        sessions.delete(sessionId);
        messages.delete(sessionId);
        active.delete(sessionId);
        for (const child of [...sessions.values()]) {
          if (child.parentID === sessionId) {
            sessions.delete(child.id);
            messages.delete(child.id);
            active.delete(child.id);
          }
        }
        res.writeHead(204);
        res.end();
        sendEvent({
          id: `evt_mock_${nextEventId++}`,
          created: Date.now(),
          type: "session.deleted",
          location: { directory: removed?.location?.directory ?? directory },
          data: { sessionID: sessionId },
        });
        return;
      }
    }

    json(res, 404, { error: `not found: ${req.method} ${pathname}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    port,
    baseUrl: `http://${host}:${port}`,
    username,
    password,
    sessions,
    messages,
    active,
    deletedSessions,
    addSession,
    setMessages: (sessionId, entries) => {
      messages.set(sessionId, entries);
    },
    setActive: (sessionId, isActive) => {
      if (isActive) active.add(sessionId);
      else active.delete(sessionId);
    },
    emit,
    close: async () => {
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number.parseInt(process.env.MOCK_OPENCODE_V2_PORT || "4096", 10);
  const mock = await createMockOpenCodeV2Server({
    port,
    directory: process.env.PIXEL_AGENTS_PROJECT_DIR || process.cwd(),
    password: process.env.MOCK_OPENCODE_V2_PASSWORD || "mock-password",
    initialSessions: [
      {
        id: "ses_mock_v2_demo",
        title: "Mock OpenCode v2 session",
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
  });
  console.log(`Mock OpenCode v2 server listening at ${mock.baseUrl}`);
  console.log(`Basic auth: ${mock.username}:${mock.password}`);
  console.log("Emit events with: POST /__emit { type, data }");
  process.on("SIGINT", () => {
    void mock.close().then(() => process.exit(0));
  });
}
