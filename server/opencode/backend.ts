import type {
  OpenCodeGlobalEvent,
  OpenCodeMessageWithParts,
  OpenCodeSession,
  OpenCodeSessionStatus,
} from "./types.js";

export type OpenCodeApiVersion = "v1" | "v2";

export interface OpenCodeBasicAuth {
  username: string;
  password: string;
}

/**
 * Normalized surface used by OpenCodeSource. Both the v1 HTTP API and the v2
 * Desktop/`opencode serve` API are adapted to this interface.
 */
export interface OpenCodeBackend {
  readonly baseUrl: string;
  readonly apiVersion: OpenCodeApiVersion;
  health(): Promise<boolean>;
  listSessions(): Promise<OpenCodeSession[]>;
  getSession(sessionId: string): Promise<OpenCodeSession>;
  createSession(title?: string, directory?: string): Promise<OpenCodeSession>;
  getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>>;
  getSessionMessages(sessionId: string): Promise<OpenCodeMessageWithParts[]>;
  getSessionChildren(sessionId: string): Promise<OpenCodeSession[]>;
  buildAttachCommand(sessionId: string, cwd?: string): string;
  subscribe(
    onEvent: (event: OpenCodeGlobalEvent) => void,
    handlers?: {
      onError?: (error: unknown) => void;
      onOpen?: () => void;
    },
  ): { dispose: () => void };
}

export function encodeBasicAuth(auth: OpenCodeBasicAuth): string {
  return Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64");
}

export function basicAuthHeaders(auth?: OpenCodeBasicAuth | null): Record<string, string> {
  if (!auth) return {};
  return { authorization: `Basic ${encodeBasicAuth(auth)}` };
}
