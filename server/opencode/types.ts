// Types shared by the OpenCode v1 HTTP/SSE API and the v2 `/api` surface used
// by OpenCode Desktop and recent `opencode serve` builds.

export interface OpenCodeEventPayload {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeGlobalEvent {
  directory?: string;
  payload: OpenCodeEventPayload;
}

export interface OpenCodeSessionTime {
  created?: number;
  updated?: number;
  completed?: number;
}

export interface OpenCodeSession {
  id: string;
  title: string;
  directory?: string;
  parentID?: string;
  projectID?: string;
  workspaceID?: string;
  time?: OpenCodeSessionTime;
}

export type OpenCodeSessionStatusType = "idle" | "busy" | "retry";

export interface OpenCodeSessionStatus {
  type: OpenCodeSessionStatusType;
  attempt?: number;
  message?: string;
  next?: number;
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time?: { created?: number; completed?: number };
  parentID?: string;
  error?: unknown;
}

export interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  callID?: string;
  tool?: string;
  description?: string;
  prompt?: string;
  agent?: string;
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenCodeMessageWithParts {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodeToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Server-side character state for one top-level OpenCode session.
 * Mirrors the fields used by the original pixel-agents webview protocol.
 */
export interface OpenCodeTrackedAgent {
  id: number;
  sessionId: string;
  projectDir: string;
  projectName: string;
  sessionTitle: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  /** parentToolId -> active sub-tool IDs */
  activeSubagentToolIds: Map<string, Set<string>>;
  /** parentToolId -> (subToolId -> toolName) */
  activeSubagentToolNames: Map<string, Map<string, string>>;
  /** parentToolId -> (subToolId -> display status) */
  activeSubagentToolStatuses: Map<string, Map<string, string>>;
  isWaiting: boolean;
  permissionSent: boolean;
  lastActivityTime: number;
  /** Task tools created from subtask parts that are not yet bound to a child session. */
  pendingSubtaskToolIds: string[];
  /** Subtask part IDs already observed for this agent. */
  seenSubtaskPartIds: Set<string>;
  /** Child sessions created for this agent that still need to be matched to a subtask part. */
  unclaimedChildSessionIds: string[];
}

export interface PersistedOpenCodeAgent {
  id: number;
  sessionId: string;
  projectDir: string;
  projectName: string;
  sessionTitle: string;
}

export interface PersistedOpenCodeState {
  version: 1;
  agents: PersistedOpenCodeAgent[];
  hiddenSessionIds: string[];
  nextAgentId: number;
}

export type OpenCodeDiscoveryMode = "recent" | "all" | "off";

export interface OpenCodeSourceStatus {
  source: "opencode";
  connected: boolean;
  serverUrl: string | null;
  message: string;
  agentCount: number;
  discovery: OpenCodeDiscoveryMode;
  autoStartedServer: boolean;
  apiVersion?: "v1" | "v2";
}

// ── OpenCode v2 (`/api`) ─────────────────────────────────────────────────────

export interface OpenCodeV2Location {
  directory?: string;
}

export interface OpenCodeV2SessionTime {
  created: number;
  updated: number;
  busy?: number;
  idle?: number;
  viewed?: number;
  archived?: number;
}

export interface OpenCodeV2Session {
  id: string;
  parentID?: string;
  projectID?: string;
  agent?: string;
  title?: string;
  cost?: number;
  tokens?: unknown;
  outcome?: string;
  time: OpenCodeV2SessionTime;
  permissions?: unknown[];
  location?: OpenCodeV2Location;
}

export interface OpenCodeV2ToolState {
  status?: string;
  input?: unknown;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  metadata?: Record<string, unknown>;
  error?: unknown;
}

export interface OpenCodeV2ToolPart {
  type: "tool";
  id: string;
  name: string;
  executed?: boolean;
  state?: OpenCodeV2ToolState;
  time?: { created?: number; ran?: number; completed?: number };
}

export interface OpenCodeV2TextPart {
  type: "text";
  text: string;
}

export interface OpenCodeV2ReasoningPart {
  type: "reasoning";
  text: string;
}

export type OpenCodeV2AssistantPart = OpenCodeV2ToolPart | OpenCodeV2TextPart | OpenCodeV2ReasoningPart;

export interface OpenCodeV2Message {
  id: string;
  type: string;
  time?: { created?: number; streamed?: number; completed?: number };
  agent?: string;
  model?: unknown;
  content?: OpenCodeV2AssistantPart[];
  text?: string;
  description?: string;
  outcome?: string;
}

export interface OpenCodeV2Event {
  id?: string;
  created?: number;
  type: string;
  data?: Record<string, unknown>;
  location?: OpenCodeV2Location;
  durable?: unknown;
  metadata?: Record<string, unknown>;
}

export interface OpenCodeV2Permission {
  id: string;
  sessionID: string;
  action?: string;
  resources?: string[];
  message?: string;
}

export interface ChildSessionBinding {
  agentId: number;
  parentToolId: string;
  /** True when this session is a direct child of the root session. */
  direct: boolean;
  /** True when the Task tool was created from the child session (its ID is the tool ID). */
  synthetic: boolean;
  /** True when a subtask part has been matched to this child session. */
  claimed: boolean;
}
