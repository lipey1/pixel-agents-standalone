import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createMockOpenCodeV2Server } from "./mock-opencode-v2-server.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface TestMessage {
  type: string;
  [key: string]: unknown;
}

interface TestClient {
  messages: TestMessage[];
  send: (message: unknown) => void;
  waitFor: (predicate: (message: TestMessage) => boolean, label: string, timeoutMs?: number) => Promise<TestMessage>;
  count: (predicate: (message: TestMessage) => boolean) => number;
  close: () => Promise<void>;
}

interface PixelServerHandle {
  port: number;
  logs: string[];
  hasExited: () => boolean;
  stop: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startPixelServer(port: number, env: NodeJS.ProcessEnv): PixelServerHandle {
  const logs: string[] = [];
  let exited = false;
  const child: ChildProcess = spawn(process.execPath, [tsxCli, "server/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.on("exit", () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill();
    const deadline = Date.now() + 5_000;
    while (!exited && Date.now() < deadline) {
      await sleep(100);
    }
    if (!exited) child.kill("SIGKILL");
  };

  return { port, logs, hasExited: () => exited, stop };
}

async function waitForHttpReady(server: PixelServerHandle): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.hasExited()) {
      throw new Error(`Pixel server exited during startup:\n${server.logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/status`);
      if (response.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  throw new Error("pixel server /api/status did not become ready");
}

async function connectClient(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connection timeout")), 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const messages: TestMessage[] = [];
  let cursor = 0;
  ws.on("message", (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()) as TestMessage);
    } catch {
      /* ignore malformed frames */
    }
  });

  const waitFor = (
    predicate: (message: TestMessage) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<TestMessage> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
      };
      const check = (): boolean => {
        for (let index = cursor; index < messages.length; index += 1) {
          if (predicate(messages[index])) {
            const matched = messages[index];
            cursor = index + 1;
            settled = true;
            cleanup();
            resolve(matched);
            return true;
          }
        }
        return false;
      };
      const onMessage = () => {
        if (!settled) check();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${label}. Recent messages:\n${JSON.stringify(messages.slice(-12), null, 2)}`,
          ),
        );
      }, timeoutMs);
      if (check()) return;
      ws.on("message", onMessage);
    });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });

  return {
    messages,
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    waitFor,
    count: (predicate) => messages.filter(predicate).length,
    close,
  };
}

function collectKnownAgentIds(client: TestClient): Set<number> {
  const ids = new Set<number>();
  for (const message of client.messages) {
    if (message.type === "agentCreated" && typeof message.id === "number") {
      ids.add(message.id);
    }
    if (message.type === "existingAgents" && Array.isArray(message.agents)) {
      for (const id of message.agents as number[]) ids.add(id);
    }
  }
  return ids;
}

interface StatusResponse {
  agents: Array<{ id: number; sessionId: string; projectName: string }>;
  opencode: { connected: boolean; apiVersion?: string; serverUrl: string | null; agentCount: number };
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "pixel-agents-opencode-v2-"));
  const projectDir = join(tempRoot, "project");
  const persistDir = join(tempRoot, "persist");
  const mock = await createMockOpenCodeV2Server({
    directory: projectDir,
    initialSessions: [
      {
        id: "ses_root",
        title: "Root session",
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
  });

  // Seed an already-running subagent so hydration/replay is covered too: the
  // root has a completed `subagent` part and its child session has a running
  // tool. The app must reconstruct the subagent character and its tool bubble
  // without waiting for new live events.
  mock.addSession({
    id: "ses_replay_child",
    parentID: "ses_root",
    title: "Replay subtask",
    location: { directory: projectDir },
  });
  mock.setActive("ses_replay_child", true);
  mock.setMessages("ses_root", [
    {
      id: "msg_root_replay",
      type: "assistant",
      time: { created: Date.now() },
      content: [
        {
          type: "tool",
          id: "call_replay_subagent",
          name: "subagent",
          state: {
            status: "completed",
            input: {
              description: "Replay subtask",
              prompt: "Replay the subtask",
              agent: "general",
            },
            metadata: { sessionID: "ses_replay_child" },
          },
        },
      ],
    },
  ]);
  mock.setMessages("ses_replay_child", [
    {
      id: "msg_child_replay",
      type: "assistant",
      time: { created: Date.now() },
      content: [
        {
          type: "tool",
          id: "call_replay_grep",
          name: "grep",
          state: {
            status: "running",
            input: { pattern: "replay" },
          },
        },
      ],
    },
  ]);

  const baseEnv: NodeJS.ProcessEnv = {
    PIXEL_AGENTS_SOURCE: "opencode",
    OPENCODE_URL: mock.baseUrl,
    OPENCODE_PASSWORD: mock.password,
    PIXEL_AGENTS_PROJECT_DIR: projectDir,
    PIXEL_AGENTS_PERSIST_DIR: persistDir,
    PIXEL_AGENTS_OPENCODE_AUTOSTART: "0",
    PIXEL_AGENTS_ATTACH: "0",
    PIXEL_AGENTS_DISCOVERY: "all",
  };

  const serverPort = await getFreePort();
  const server = startPixelServer(serverPort, baseEnv);
  let client: TestClient | null = null;

  try {
    await waitForHttpReady(server);

    const initialStatus = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/status`)
    ).json()) as StatusResponse;
    assert(initialStatus.opencode.connected === true, "OpenCode v2 source should be connected");
    assert(initialStatus.opencode.apiVersion === "v2", "sourceStatus must report apiVersion v2");

    client = await connectClient(server.port);
    client.send({ type: "webviewReady" });

    const connectedStatus = await client.waitFor(
      (message) => message.type === "sourceStatus" && message.connected === true,
      "connected sourceStatus",
    );
    assert(connectedStatus.apiVersion === "v2", "sourceStatus should report v2");
    assert(connectedStatus.source === "opencode", "sourceStatus should report opencode");

    // Hydration may complete before or after the WebSocket connects.
    const rootDeadline = Date.now() + 10_000;
    let rootAgentId: number | null = null;
    while (Date.now() < rootDeadline && rootAgentId === null) {
      rootAgentId = collectKnownAgentIds(client).values().next().value ?? null;
      await sleep(100);
    }
    assert(rootAgentId !== null, "root OpenCode v2 session should become a character");
    const rootAgent: number = rootAgentId;

    // Hydration must restore the running subagent and its current tool.
    const replayedSubagentTool = await client.waitFor(
      (message) =>
        message.type === "subagentToolStart" &&
        message.parentToolId === "call_replay_subagent" &&
        message.toolId === "call_replay_grep",
      "replayed subagent tool start",
    );
    assert(
      typeof replayedSubagentTool.status === "string" &&
        replayedSubagentTool.status === "Searching code",
      `unexpected replayed subagent status: ${String(replayedSubagentTool.status)}`,
    );

    // ── Root tool from v2 tool events ───────────────────────────────────────
    mock.emit("session.execution.started", { sessionID: "ses_root" });
    mock.emit("session.tool.input.started", {
      sessionID: "ses_root",
      assistantMessageID: "msg_root_1",
      id: "call_read",
      name: "read",
    });
    mock.emit("session.tool.called", {
      sessionID: "ses_root",
      assistantMessageID: "msg_root_1",
      id: "call_read",
      input: { path: join(projectDir, "foo.ts") },
    });
    const readTool = await client.waitFor(
      (message) => message.type === "agentToolStart" && message.toolId === "call_read",
      "root Read tool start",
    );
    assert(readTool.id === rootAgent, "Read tool belongs to root agent");
    assert(readTool.status === "Reading foo.ts", `Unexpected read status: ${String(readTool.status)}`);

    mock.emit("session.tool.success", {
      sessionID: "ses_root",
      assistantMessageID: "msg_root_1",
      id: "call_read",
      content: [{ type: "text", text: "read ok" }],
    });
    await client.waitFor(
      (message) => message.type === "agentToolDone" && message.toolId === "call_read",
      "root Read tool done",
    );

    // ── Subagent tool: parent subtask part, child session, child tool ───────
    mock.emit("session.tool.input.started", {
      sessionID: "ses_root",
      assistantMessageID: "msg_root_2",
      id: "call_subagent",
      name: "subagent",
    });
    mock.emit("session.tool.called", {
      sessionID: "ses_root",
      assistantMessageID: "msg_root_2",
      id: "call_subagent",
      input: {
        description: "Explore repo",
        prompt: "Explore the repo",
        agent: "general",
      },
    });
    const subtaskTool = await client.waitFor(
      (message) => message.type === "agentToolStart" && message.toolId === "call_subagent",
      "root subtask tool start",
    );
    assert(
      typeof subtaskTool.status === "string" && subtaskTool.status.startsWith("Subtask:"),
      "subtask status should start with Subtask:",
    );

    mock.emit("session.created", {
      sessionID: "ses_child",
      parentID: "ses_root",
      title: "Explore repo",
      location: { directory: projectDir },
    });
    await sleep(400);
    const subtaskStartsForRoot = client.count(
      (message) =>
        message.type === "agentToolStart" &&
        message.id === rootAgent &&
        message.toolId === "call_subagent",
    );
    assert(
      subtaskStartsForRoot === 1,
      `subtask part + child session must create exactly one subagent (got ${subtaskStartsForRoot})`,
    );

    // v2 rename events omit parentID; a renamed child must not become a main
    // character. The adapter has to resolve the missing parentage.
    const agentCreatedCountBeforeChildRename = client.count(
      (message) => message.type === "agentCreated",
    );
    mock.emit("session.renamed", { sessionID: "ses_child", title: "Explore repo renamed" });
    await sleep(600);
    const agentCreatedCountAfterChildRename = client.count(
      (message) => message.type === "agentCreated",
    );
    assert(
      agentCreatedCountAfterChildRename === agentCreatedCountBeforeChildRename,
      `renaming a child session must not create a main character (before=${agentCreatedCountBeforeChildRename}, after=${agentCreatedCountAfterChildRename})`,
    );
    const statusAfterChildRename = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/status`)
    ).json()) as StatusResponse;
    assert(
      statusAfterChildRename.agents.length === 1,
      `renaming a child session must keep one main character (got ${statusAfterChildRename.agents.length})`,
    );

    mock.emit("session.tool.input.started", {
      sessionID: "ses_child",
      assistantMessageID: "msg_child_1",
      id: "call_child_grep",
      name: "grep",
    });
    mock.emit("session.tool.called", {
      sessionID: "ses_child",
      assistantMessageID: "msg_child_1",
      id: "call_child_grep",
      input: { pattern: "needle" },
    });
    const childTool = await client.waitFor(
      (message) => message.type === "subagentToolStart" && message.toolId === "call_child_grep",
      "child subagent tool start",
    );
    assert(
      childTool.parentToolId === "call_subagent",
      "child tool must be bound to the subtask part",
    );

    mock.emit("session.tool.success", {
      sessionID: "ses_child",
      assistantMessageID: "msg_child_1",
      id: "call_child_grep",
      content: [{ type: "text", text: "found" }],
    });
    await client.waitFor(
      (message) => message.type === "subagentToolDone" && message.toolId === "call_child_grep",
      "child subagent tool done",
    );

    // The subagent tool result identifies the child session; the adapter turns
    // that into an idle event so the parent task finishes and its subagent
    // character is cleared.
    mock.emit("session.tool.success", {
      sessionID: "ses_root",
      assistantMessageID: "msg_root_2",
      id: "call_subagent",
      content: [{ type: "text", text: "explored" }],
      metadata: { sessionID: "ses_child" },
    });
    await client.waitFor(
      (message) => message.type === "subagentClear" && message.parentToolId === "call_subagent",
      "subagent clear after subagent tool success",
    );
    await client.waitFor(
      (message) => message.type === "agentToolDone" && message.toolId === "call_subagent",
      "subtask tool done after subagent tool success",
    );

    mock.emit("session.idle", { sessionID: "ses_root" });
    await client.waitFor(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "waiting",
      "root agent waiting after idle",
    );

    // Duplicate idle events must not spam the UI with repeated status messages.
    const waitingCountBefore = client.count(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "waiting",
    );
    mock.emit("session.idle", { sessionID: "ses_root" });
    await sleep(400);
    const waitingCountAfter = client.count(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "waiting",
    );
    assert(
      waitingCountAfter === waitingCountBefore,
      `duplicate idle events must not repeat the waiting status (before=${waitingCountBefore}, after=${waitingCountAfter})`,
    );

    // ── Close hides the character without deleting the v2 session ───────────
    const sessionCountBeforeClose = mock.sessions.size;
    client.send({ type: "closeAgent", id: rootAgent });
    await client.waitFor(
      (message) => message.type === "agentClosed" && message.id === rootAgent,
      "agentClosed after closeAgent",
    );
    await sleep(300);
    assert(mock.sessions.has("ses_root"), "closing a character must not delete the OpenCode session");
    assert(
      !mock.deletedSessions.includes("ses_root"),
      `closeAgent must not call DELETE /api/session (deleted: ${mock.deletedSessions.join(",")})`,
    );
    assert(mock.sessions.size === sessionCountBeforeClose, "closeAgent must keep session count unchanged");

    const statusAfterClose = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/status`)
    ).json()) as StatusResponse;
    assert(
      !statusAfterClose.agents.some((agent) => agent.id === rootAgent),
      "closed agent must disappear from /api/status",
    );
    assert(statusAfterClose.opencode.connected === true, "OpenCode source should remain connected");

    // ── + Agent creates a new v2 session with a location ────────────────────
    const sessionCountBeforeCreate = mock.sessions.size;
    const sessionIdsBeforeCreate = new Set(mock.sessions.keys());
    client.send({ type: "openAgentSession" });
    const createdAgent = await client.waitFor(
      (message) => message.type === "agentCreated" && message.id !== rootAgent,
      "agentCreated from + Agent",
    );
    const createdId = createdAgent.id as number;
    await sleep(300);
    assert(
      mock.sessions.size === sessionCountBeforeCreate + 1,
      "openAgentSession must create exactly one OpenCode v2 session",
    );
    const createdSession = [...mock.sessions.values()].find(
      (session) => !sessionIdsBeforeCreate.has(session.id),
    );
    assert(createdSession !== undefined, "created v2 session should exist in the mock");
    assert(
      typeof createdSession.title === "string" && createdSession.title.startsWith("Pixel Agent — project"),
      `created session title should start with Pixel Agent — project (got ${String(createdSession.title)})`,
    );
    assert(
      createdSession.location?.directory === projectDir,
      `created session should use the requested directory (got ${String(createdSession.location?.directory)})`,
    );
    assert(
      typeof createdAgent.folderName === "string" && createdAgent.folderName === "project",
      `created agent folder should be project (got ${String(createdAgent.folderName)})`,
    );

    // ── Restart restores agents and keeps hidden sessions hidden ────────────
    await client.close();
    client = null;
    await server.stop();

    const restartPort = await getFreePort();
    const restarted = startPixelServer(restartPort, baseEnv);
    try {
      await waitForHttpReady(restarted);
      client = await connectClient(restarted.port);
      client.send({ type: "webviewReady" });

      await client.waitFor(
        (message) => message.type === "sourceStatus" && message.connected === true,
        "connected sourceStatus after restart",
      );

      const expectedIds = [createdId];
      const restoreDeadline = Date.now() + 10_000;
      let restoredIds: number[] = [];
      while (Date.now() < restoreDeadline) {
        const known = [...collectKnownAgentIds(client)].sort((a, b) => a - b);
        if (known.length >= expectedIds.length) {
          restoredIds = known;
          break;
        }
        await sleep(100);
      }
      // Give hydration a moment to settle so extra agents would show up.
      await sleep(700);
      const settledIds = [...collectKnownAgentIds(client)].sort((a, b) => a - b);
      assert(
        JSON.stringify(settledIds) === JSON.stringify(expectedIds),
        `restart should restore exactly [${expectedIds.join(", ")}] (got [${settledIds.join(", ")}])`,
      );
      assert(
        !settledIds.includes(rootAgent),
        "an agent hidden by closeAgent must not return after a restart",
      );
      assert(
        !client.messages.some(
          (message) => message.type === "agentCreated" && message.id === rootAgent,
        ),
        "restart must not emit agentCreated for a hidden session",
      );

      const restartedStatus = (await (
        await fetch(`http://127.0.0.1:${restarted.port}/api/status`)
      ).json()) as StatusResponse;
      assert(
        restartedStatus.opencode.apiVersion === "v2",
        "/api/status after restart should report apiVersion v2",
      );
      const restartedAgentIds = restartedStatus.agents.map((agent) => agent.id).sort((a, b) => a - b);
      assert(
        JSON.stringify(restartedAgentIds) === JSON.stringify(expectedIds),
        `/api/status after restart should list [${expectedIds.join(", ")}] (got [${restartedAgentIds.join(", ")}])`,
      );
      assert(mock.deletedSessions.length === 0, "restart flow must never delete OpenCode sessions");

      console.log("OpenCode v2 integration test passed.");
      console.log(`  mock server: ${mock.baseUrl} (Basic auth ${mock.username})`);
      console.log(`  pixel server: http://127.0.0.1:${server.port} (restarted on ${restarted.port})`);
      console.log(
        `  agents seen: root=${rootAgent}, created=${createdId}; restored=${settledIds.join(",")}`,
      );
      console.log(`  OpenCode v2 sessions kept: ${mock.sessions.size}`);
    } finally {
      await client?.close();
      client = null;
      await restarted.stop();
    }
  } finally {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    await server.stop().catch(() => {});
    await mock.close().catch(() => {});
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* Windows may keep a file handle briefly */
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
