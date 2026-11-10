const SSE_RECONNECT_MIN_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SseSubscription {
  dispose: () => void;
}

export interface SseHandlers {
  onError?: (error: unknown) => void;
  onOpen?: () => void;
}

/**
 * Minimal SSE client with automatic reconnects. OpenCode v1 and v2 both send
 * one JSON object per `data:` line and use comment lines as heartbeats.
 */
export function subscribeSse(
  url: string,
  init: RequestInit,
  onEvent: (value: unknown) => void,
  handlers: SseHandlers = {},
): SseSubscription {
  const controller = new AbortController();
  const decoder = new TextDecoder();
  let reconnectAttempt = 0;

  const run = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok || !response.body) {
          throw new Error(`OpenCode SSE failed: ${response.status} ${response.statusText}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          throw new Error(`OpenCode SSE returned ${contentType || "an unknown content type"}`);
        }
        reconnectAttempt = 0;
        handlers.onOpen?.();

        const reader = response.body.getReader();
        let buffer = "";
        while (!controller.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLines = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length > 0) {
              try {
                onEvent(JSON.parse(dataLines.join("\n")));
              } catch (error) {
                handlers.onError?.(error);
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
        if (controller.signal.aborted) return;
        handlers.onError?.(new Error("OpenCode event stream closed"));
      } catch (error) {
        if (controller.signal.aborted) return;
        handlers.onError?.(error);
      }

      reconnectAttempt += 1;
      const wait = Math.min(SSE_RECONNECT_MAX_MS, SSE_RECONNECT_MIN_MS * 2 ** (reconnectAttempt - 1));
      try {
        await delay(wait);
      } catch {
        return;
      }
    }
  };

  void run();
  return { dispose: () => controller.abort() };
}
