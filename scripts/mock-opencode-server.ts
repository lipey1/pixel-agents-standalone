import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type {
  OpenCodeGlobalEvent,
  OpenCodeMessageWithParts,
  OpenCodePart,
  OpenCodeSession,
  OpenCodeSessionStatus,
} from "../server/opencode/types.js";

export interface MockOpenCodeOptions {
  port?: number;
  host?: string;
  directory?: string;
  initialSessions?: Array<Partial<OpenCodeSession> & { id: string }>;
}

export interface MockOpenCodeServer {
  port: number;
  baseUrl: string;
  sessions: Map<string, OpenCodeSession>;
  statuses: Map<string, OpenCodeSessionStatus>;
  messages: Map<string, OpenCodeMessageWithParts[]>;
  deletedSessions: string[];
  emit: (event: OpenCodeGlobalEvent["payload"]) => void;
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isSession(value: unknown): value is OpenCodeSession {
  return Boolean(value) && typeof (value as OpenCodeSession).id === "string";
}

export async function createMockOpenCodeServer(options: MockOpenCodeOptions = {}): Promise<MockOpenCodeServer> {
  const host = options.host ?? "127.0.0.1";
  const directory = options.directory ?? process.cwd();
  const sessions = new Map<string, OpenCodeSession>();
  const statuses = new Map<string, OpenCodeSessionStatus>();
  const messages = new Map<string, OpenCodeMessageWithParts[]>();
  const deletedSessions: string[] = [];
  const sseClients = new Set<ServerResponse>();
  let nextSessionId = 1;

  const upsertSession = (session: OpenCodeSession) => {
    sessions.set(session.id, session);
    if (!statuses.has(session.id)) {
      statuses.set(session.id, { type: "idle" });
    }
    if (!messages.has(session.id)) {
      messages.set(session.id, []);
    }
  };

  for (const initial of options.initialSessions ?? []) {
    upsertSession({
      id: initial.id,
      title: initial.title ?? initial.id,
      directory: initial.directory ?? directory,
      parentID: initial.parentID,
      time: initial.time ?? { created: Date.now(), updated: Date.now() },
    });
  }

  const storePart = (part: OpenCodePart) => {
    const list = messages.get(part.sessionID) ?? [];
    let message = list.find((entry) => entry.info.id === part.messageID);
    if (!message) {
      message = {
        info: {
          id: part.messageID,
          sessionID: part.sessionID,
          role: "assistant",
          time: { created: Date.now() },
        },
        parts: [],
      };
      list.push(message);
      messages.set(part.sessionID, list);
    }
    const index = message.parts.findIndex((entry) => entry.id === part.id);
    if (index >= 0) {
      message.parts[index] = part;
    } else {
      message.parts.push(part);
    }
  };

  const applyEvent = (event: OpenCodeGlobalEvent["payload"]) => {
    const properties = event.properties ?? {};
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        if (isSession(properties.info)) upsertSession(properties.info);
        break;
      }
      case "session.deleted": {
        if (isSession(properties.info)) {
          sessions.delete(properties.info.id);
          statuses.delete(properties.info.id);
        }
        break;
      }
      case "session.idle": {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
        if (sessionID) statuses.set(sessionID, { type: "idle" });
        break;
      }
      case "session.status": {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
        const status = properties.status as OpenCodeSessionStatus | undefined;
        if (sessionID && status) statuses.set(sessionID, status);
        break;
      }
      case "message.part.updated": {
        const part = properties.part as OpenCodePart | undefined;
        if (part && typeof part.id === "string" && typeof part.sessionID === "string") {
          storePart(part);
        }
        break;
      }
      default:
        break;
    }
  };

  const emit = (event: OpenCodeGlobalEvent["payload"]) => {
    applyEvent(event);
    const data = JSON.stringify({ directory, payload: event });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${options.port ?? 0}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/global/health") {
      json(res, 200, { healthy: true, version: "mock-1.0.0" });
      return;
    }

    if (pathname === "/global/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === "/session" && req.method === "GET") {
      json(res, 200, [...sessions.values()]);
      return;
    }

    if (pathname === "/session" && req.method === "POST") {
      const raw = await readBody(req);
      let title = "";
      try {
        const body = raw ? (JSON.parse(raw) as { title?: string }) : {};
        title = typeof body.title === "string" ? body.title : "";
      } catch {
        /* ignore invalid JSON */
      }
      const id = `ses_mock_${nextSessionId++}`;
      const session: OpenCodeSession = {
        id,
        title: title || `Mock Session ${id}`,
        directory,
        time: { created: Date.now(), updated: Date.now() },
      };
      upsertSession(session);
      json(res, 200, session);
      return;
    }

    if (pathname === "/session/status" && req.method === "GET") {
      json(res, 200, Object.fromEntries(statuses));
      return;
    }

    if (pathname === "/__state" && req.method === "GET") {
      json(res, 200, {
        sessions: [...sessions.values()],
        statuses: Object.fromEntries(statuses),
        deletedSessions,
      });
      return;
    }

    if (pathname === "/__emit" && req.method === "POST") {
      const raw = await readBody(req);
      try {
        const event = JSON.parse(raw) as OpenCodeGlobalEvent["payload"];
        emit(event);
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { error: String(error) });
      }
      return;
    }

    const sessionMatch = pathname.match(/^\/session\/([^/]+)(?:\/(message|children))?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const suffix = sessionMatch[2];
      if (suffix === "message" && req.method === "GET") {
        json(res, 200, messages.get(sessionId) ?? []);
        return;
      }
      if (suffix === "children" && req.method === "GET") {
        json(
          res,
          200,
          [...sessions.values()].filter((session) => session.parentID === sessionId),
        );
        return;
      }
      if (req.method === "GET") {
        const session = sessions.get(sessionId);
        if (!session) {
          json(res, 404, { error: "session not found" });
          return;
        }
        json(res, 200, session);
        return;
      }
      if (req.method === "DELETE") {
        deletedSessions.push(sessionId);
        sessions.delete(sessionId);
        statuses.delete(sessionId);
        messages.delete(sessionId);
        json(res, 200, {});
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
    sessions,
    statuses,
    messages,
    deletedSessions,
    emit,
    close: async () => {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number.parseInt(process.env.MOCK_OPENCODE_PORT || "4096", 10);
  const mock = await createMockOpenCodeServer({
    port,
    directory: process.env.PIXEL_AGENTS_PROJECT_DIR || process.cwd(),
    initialSessions: [
      {
        id: "ses_mock_demo",
        title: "Mock OpenCode session",
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
  });
  console.log(`Mock OpenCode server listening at ${mock.baseUrl}`);
  console.log("Emit events with: POST /__emit { type, properties }");
  process.on("SIGINT", () => {
    void mock.close().then(() => process.exit(0));
  });
}
