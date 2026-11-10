import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createMockOpenCodeServer } from "./mock-opencode-server.js";

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

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "pixel-agents-opencode-"));
  const projectDir = join(tempRoot, "project");
  const persistDir = join(tempRoot, "persist");
  const mock = await createMockOpenCodeServer({
    directory: projectDir,
    initialSessions: [
      {
        id: "ses_root",
        title: "Root session",
        directory: projectDir,
        time: { created: Date.now(), updated: Date.now() },
      },
    ],
  });

  const baseEnv: NodeJS.ProcessEnv = {
    PIXEL_AGENTS_SOURCE: "opencode",
    OPENCODE_URL: mock.baseUrl,
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

    client = await connectClient(server.port);
    client.send({ type: "webviewReady" });

    const connectedStatus = await client.waitFor(
      (message) => message.type === "sourceStatus" && message.connected === true,
      "connected sourceStatus",
    );
    assert(connectedStatus.source === "opencode", "sourceStatus should report opencode");

    // Hydration may complete before or after the WebSocket connects.
    const rootDeadline = Date.now() + 10_000;
    let rootAgentId: number | null = null;
    while (Date.now() < rootDeadline && rootAgentId === null) {
      rootAgentId = collectKnownAgentIds(client).values().next().value ?? null;
      await sleep(100);
    }
    assert(rootAgentId !== null, "root OpenCode session should become a character");
    const rootAgent: number = rootAgentId;

    // ── Root tool + subtask part before child session (part-first ordering) ──
    mock.emit({
      type: "session.status",
      properties: { sessionID: "ses_root", status: { type: "busy" } },
    });
    await client.waitFor(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "active",
      "root agent active",
    );

    mock.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_read",
          sessionID: "ses_root",
          messageID: "msg_root_1",
          type: "tool",
          callID: "call_read",
          tool: "read",
          state: { status: "running", input: { file_path: "/tmp/foo.ts" } },
        },
      },
    });
    const readTool = await client.waitFor(
      (message) => message.type === "agentToolStart" && message.toolId === "call_read",
      "root Read tool start",
    );
    assert(readTool.id === rootAgent, "Read tool belongs to root agent");
    assert(readTool.status === "Reading foo.ts", `Unexpected read status: ${String(readTool.status)}`);

    mock.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_task",
          sessionID: "ses_root",
          messageID: "msg_root_1",
          type: "subtask",
          description: "Explore repo",
          prompt: "Explore the repo",
          agent: "general",
        },
      },
    });
    const taskTool = await client.waitFor(
      (message) => message.type === "agentToolStart" && message.toolId === "prt_task",
      "root subtask tool start",
    );
    assert(
      typeof taskTool.status === "string" && taskTool.status.startsWith("Subtask:"),
      "subtask status should start with Subtask:",
    );

    mock.emit({
      type: "session.created",
      properties: {
        info: {
          id: "ses_child",
          title: "Explore repo",
          parentID: "ses_root",
          directory: projectDir,
        },
      },
    });
    await sleep(600);
    const subtaskStartsForRoot = client.count(
      (message) =>
        message.type === "agentToolStart" &&
        message.id === rootAgent &&
        typeof message.status === "string" &&
        message.status.startsWith("Subtask:"),
    );
    assert(
      subtaskStartsForRoot === 1,
      `subtask part + child session must create exactly one subagent (got ${subtaskStartsForRoot})`,
    );

    mock.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_child_tool",
          sessionID: "ses_child",
          messageID: "msg_child_1",
          type: "tool",
          callID: "call_child_grep",
          tool: "grep",
          state: { status: "running", input: { pattern: "needle" } },
        },
      },
    });
    const childTool = await client.waitFor(
      (message) => message.type === "subagentToolStart" && message.toolId === "call_child_grep",
      "child subagent tool start",
    );
    assert(childTool.parentToolId === "prt_task", "child tool must be bound to the subtask part");

    mock.emit({ type: "session.idle", properties: { sessionID: "ses_child" } });
    await client.waitFor(
      (message) => message.type === "subagentClear" && message.parentToolId === "prt_task",
      "subagent clear after child idle",
    );
    await client.waitFor(
      (message) => message.type === "agentToolDone" && message.toolId === "prt_task",
      "subtask tool done after child idle",
    );

    mock.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_read",
          sessionID: "ses_root",
          messageID: "msg_root_1",
          type: "tool",
          callID: "call_read",
          tool: "read",
          state: { status: "completed", input: { file_path: "/tmp/foo.ts" } },
        },
      },
    });
    await client.waitFor(
      (message) => message.type === "agentToolDone" && message.toolId === "call_read",
      "root Read tool done",
    );

    mock.emit({ type: "session.idle", properties: { sessionID: "ses_root" } });
    await client.waitFor(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "waiting",
      "root agent waiting after idle",
    );

    // Duplicate idle events must not spam the UI with repeated status messages.
    const waitingCountBefore = client.count(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "waiting",
    );
    mock.emit({ type: "session.idle", properties: { sessionID: "ses_root" } });
    await sleep(400);
    const waitingCountAfter = client.count(
      (message) => message.type === "agentStatus" && message.id === rootAgent && message.status === "waiting",
    );
    assert(
      waitingCountAfter === waitingCountBefore,
      `duplicate idle events must not repeat the waiting status (before=${waitingCountBefore}, after=${waitingCountAfter})`,
    );

    // ── Child session before subtask part (child-first ordering) ─────────────
    mock.emit({
      type: "session.created",
      properties: {
        info: {
          id: "ses_root_2",
          title: "Second root",
          directory: projectDir,
          time: { created: Date.now(), updated: Date.now() },
        },
      },
    });
    const root2Created = await client.waitFor(
      (message) => message.type === "agentCreated" && message.folderName === "project",
      "second root agent created",
    );
    const root2Id = root2Created.id as number;
    assert(root2Id !== rootAgent, "second root must have a different agent id");

    mock.emit({
      type: "session.created",
      properties: {
        info: { id: "ses_child_2", title: "Child first", parentID: "ses_root_2", directory: projectDir },
      },
    });
    const syntheticTask = await client.waitFor(
      (message) =>
        message.type === "agentToolStart" &&
        message.id === root2Id &&
        message.toolId === "ses_child_2" &&
        typeof message.status === "string" &&
        message.status.startsWith("Subtask:"),
      "synthetic task for child-first ordering",
    );
    assert(syntheticTask.toolId === "ses_child_2", "child-first task should use the child session id");

    mock.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_task_2",
          sessionID: "ses_root_2",
          messageID: "msg_root_2",
          type: "subtask",
          description: "Child first",
          prompt: "Child first",
          agent: "general",
        },
      },
    });
    await sleep(600);
    const subtaskStartsForRoot2 = client.count(
      (message) =>
        message.type === "agentToolStart" &&
        message.id === root2Id &&
        typeof message.status === "string" &&
        message.status.startsWith("Subtask:"),
    );
    assert(
      subtaskStartsForRoot2 === 1,
      `child-first subtask must be claimed without a duplicate (got ${subtaskStartsForRoot2})`,
    );

    mock.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_child_2_tool",
          sessionID: "ses_child_2",
          messageID: "msg_child_2",
          type: "tool",
          callID: "call_child_2",
          tool: "bash",
          state: { status: "running", input: { command: "npm test" } },
        },
      },
    });
    const child2Tool = await client.waitFor(
      (message) => message.type === "subagentToolStart" && message.toolId === "call_child_2",
      "child-first subagent tool start",
    );
    assert(child2Tool.parentToolId === "ses_child_2", "child-first tool must use the synthetic task id");

    mock.emit({ type: "session.idle", properties: { sessionID: "ses_child_2" } });
    await client.waitFor(
      (message) => message.type === "subagentClear" && message.parentToolId === "ses_child_2",
      "child-first subagent clear",
    );

    // ── Close hides the character without deleting the OpenCode session ──────
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
      `closeAgent must not call DELETE /session (deleted: ${mock.deletedSessions.join(",")})`,
    );
    assert(mock.sessions.size === sessionCountBeforeClose, "closeAgent must keep session count unchanged");

    const statusAfterClose = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/status`)
    ).json()) as { agents: Array<{ id: number }>; opencode: { connected: boolean; agentCount: number } };
    assert(
      !statusAfterClose.agents.some((agent) => agent.id === rootAgent),
      "closed agent must disappear from /api/status",
    );
    assert(statusAfterClose.opencode.connected === true, "OpenCode source should remain connected");

    // ── + Agent creates a new OpenCode session ───────────────────────────────
    const sessionCountBeforeCreate = mock.sessions.size;
    client.send({ type: "openAgentSession" });
    const createdAgent = await client.waitFor(
      (message) => message.type === "agentCreated" && message.id !== rootAgent && message.id !== root2Id,
      "agentCreated from + Agent",
    );
    const createdId = createdAgent.id as number;
    await sleep(300);
    assert(
      mock.sessions.size === sessionCountBeforeCreate + 1,
      "openAgentSession must create exactly one OpenCode session",
    );
    assert(
      typeof createdAgent.folderName === "string" && createdAgent.folderName === "project",
      `created agent folder should be project (got ${String(createdAgent.folderName)})`,
    );

    const finalStatus = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/status`)
    ).json()) as {
      agents: Array<{ id: number }>;
      opencode: { connected: boolean; agentCount: number };
    };
    assert(finalStatus.opencode.agentCount >= 2, "status should count remaining agents");

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

      const expectedIds = [root2Id, createdId].sort((a, b) => a - b);
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
          (message) =>
            message.type === "agentCreated" &&
            message.id === rootAgent,
        ),
        "restart must not emit agentCreated for a hidden session",
      );

      const restartedStatus = (await (
        await fetch(`http://127.0.0.1:${restarted.port}/api/status`)
      ).json()) as {
        agents: Array<{ id: number }>;
        opencode: { connected: boolean; agentCount: number };
      };
      const restartedAgentIds = restartedStatus.agents.map((agent) => agent.id).sort((a, b) => a - b);
      assert(
        JSON.stringify(restartedAgentIds) === JSON.stringify(expectedIds),
        `/api/status after restart should list [${expectedIds.join(", ")}] (got [${restartedAgentIds.join(", ")}])`,
      );
      assert(mock.deletedSessions.length === 0, "restart flow must never delete OpenCode sessions");

      console.log("OpenCode integration test passed.");
      console.log(`  mock server: ${mock.baseUrl}`);
      console.log(`  pixel server: http://127.0.0.1:${server.port} (restarted on ${restarted.port})`);
      console.log(
        `  agents seen: root=${rootAgent}, root2=${root2Id}, created=${createdId}; restored=${settledIds.join(",")}`,
      );
      console.log(`  OpenCode sessions kept: ${mock.sessions.size}`);
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
