/**
 * Client state for the WebMCP Inspector: one browser session, its live tool
 * registry, and its activity timeline.
 *
 * The server is the source of truth for all three. This store holds what the
 * SSE stream has told it, which is why every server message that carries tools
 * carries the FULL set rather than a delta — a reconnecting client can adopt a
 * snapshot without reasoning about what it missed.
 */
import { create } from "zustand";
import { addTokenToUrl, getAuthHeaders } from "@/lib/session-token";
import type {
  WebMcpActivityEntry,
  WebMcpCommand,
  WebMcpEvent,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

const BASE = "/api/mcp/webmcp";
/** Timeline entries kept in memory. Older ones scroll out of usefulness. */
const MAX_ACTIVITY = 500;

export interface WebMcpRequestError {
  message: string;
  /** Server-assigned code, e.g. `webmcp-unsupported`, so the UI can explain. */
  code?: string;
}

export interface PendingInvocation {
  invokeId: string;
  toolKey: string;
  startedAt: number;
}

/** The settled outcome of one invocation, as a caller awaiting it sees it. */
export interface PageToolInvocationResult {
  state: "succeeded" | "failed" | "cancelled" | "timeout";
  output?: unknown;
  outputTruncated?: boolean;
  errorMessage?: string;
}

/** How long to wait for a settle event before giving up on the stream. */
const INVOCATION_WAIT_TIMEOUT_MS = 90_000;

interface WebMcpInspectorState {
  session: WebMcpSessionPublic | undefined;
  tools: WebMcpToolDescriptor[];
  activity: WebMcpActivityEntry[];
  pending: PendingInvocation[];
  /** True between "user asked to open" and the server answering. */
  starting: boolean;
  error: WebMcpRequestError | undefined;
  lastScreenshot: string | undefined;
  /**
   * Whether chat turns may use this page's tools. Off by default and reset when
   * a session closes: a chat should never silently acquire tools because a
   * browser was left open somewhere else in the app.
   */
  chatEnabled: boolean;
  setChatEnabled(enabled: boolean): void;

  startSession(url: string): Promise<void>;
  closeSession(): Promise<void>;
  sendCommand(command: WebMcpCommand): Promise<unknown>;
  invokeTool(toolKey: string, input: Record<string, unknown>): Promise<void>;
  /**
   * Invoke and wait for the result, for callers that need the value rather
   * than the timeline — chat, which must hand the model back what it asked for.
   */
  invokeToolForResult(
    toolKey: string,
    input: Record<string, unknown>,
  ): Promise<PageToolInvocationResult>;
  cancelInvocation(invokeId: string): Promise<void>;
  captureScreenshot(): Promise<void>;
  clearError(): void;
  /**
   * Re-attach the event stream to the session that is still running, e.g. after
   * the surface unmounts and mounts again. Idempotent for the same session.
   */
  reconnect(): void;
  /** Test seam; also used when the surface unmounts. */
  disconnect(): void;
}

/**
 * One EventSource per session, module-scoped rather than per-component: the
 * workspace renders several panels off this store, and a stream per panel would
 * multiply both the connections and the replayed history.
 */
let source: EventSource | undefined;
let sourceSessionId: string | undefined;

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: WebMcpRequestError }> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...getAuthHeaders(),
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: {
          message:
            typeof body?.error === "string"
              ? body.error
              : "The WebMCP Inspector request failed.",
          code: typeof body?.code === "string" ? body.code : undefined,
        },
      };
    }
    return { ok: true, data: body as T };
  } catch (error) {
    return {
      ok: false,
      error: {
        message:
          error instanceof Error
            ? error.message
            : "Could not reach the WebMCP Inspector.",
      },
    };
  }
}

/**
 * Callers awaiting a specific invocation, keyed by invokeId.
 *
 * The settle arrives on the SSE stream rather than as an HTTP response — the
 * invoke request answers as soon as the call is queued — so a caller that needs
 * the value parks here and the stream handler resolves it.
 */
const invocationWaiters = new Map<
  string,
  (result: PageToolInvocationResult) => void
>();

/**
 * Activity ids already applied.
 *
 * EventSource reconnects on its own, and every reconnect replays the ring, so
 * the same entries arrive more than once. Appending them blindly would show the
 * timeline doubled, hand React duplicate keys, and — worse — re-add an
 * `invocation_started` whose `invocation_settled` has scrolled out of the replay
 * window, leaving a tool stuck showing "Running…" with Invoke disabled.
 */
let seenActivityIds = new Set<string>();

export const useWebmcpInspectorStore = create<WebMcpInspectorState>(
  (set, get) => {
    function applyEvent(event: WebMcpEvent) {
      if (event.type === "session") {
        set({ session: event.session });
        return;
      }
      if (event.type === "tools") {
        set({ tools: event.tools });
        return;
      }
      const entry = event.entry;
      if (seenActivityIds.has(entry.id)) return;
      seenActivityIds.add(entry.id);
      set((state) => {
        const activity = [...state.activity, entry].slice(-MAX_ACTIVITY);
        let pending = state.pending;
        if (entry.kind === "invocation_started") {
          pending = [
            ...state.pending,
            {
              invokeId: entry.invokeId,
              toolKey: entry.toolKey,
              startedAt: entry.ts,
            },
          ];
        } else if (entry.kind === "invocation_settled") {
          pending = state.pending.filter(
            (item) => item.invokeId !== entry.invokeId,
          );
        }
        return { activity, pending };
      });

      if (entry.kind === "invocation_settled") {
        const waiter = invocationWaiters.get(entry.invokeId);
        if (waiter) {
          invocationWaiters.delete(entry.invokeId);
          waiter({
            state: entry.state,
            output: entry.output,
            outputTruncated: entry.outputTruncated,
            errorMessage: entry.errorMessage,
          });
        }
      }
    }

    function connect(sessionId: string) {
      if (source && sourceSessionId === sessionId) return;
      disconnectStream();
      sourceSessionId = sessionId;
      // The token rides in the query string because EventSource cannot send
      // headers, which is the same accommodation the traffic-log stream makes.
      source = new EventSource(
        addTokenToUrl(`${BASE}/sessions/${sessionId}/events?replay=200`),
      );
      source.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data);
          if (parsed?.type === "session_gone") {
            // The server restarted, or the session was reaped. Say so rather
            // than leaving a dead tab that looks live.
            set({
              error: {
                message:
                  typeof parsed.error === "string"
                    ? parsed.error
                    : "That browser session is gone.",
                code: "session-not-found",
              },
              session: undefined,
              tools: [],
              pending: [],
            });
            disconnectStream();
            return;
          }
          applyEvent(parsed as WebMcpEvent);
        } catch {
          /* a malformed frame is not worth tearing the stream down over */
        }
      };
      source.onerror = () => {
        // EventSource reconnects on its own, and replay plus full tool
        // snapshots make that safe; nothing to do but let it.
      };
    }

    function disconnectStream() {
      source?.close();
      source = undefined;
      sourceSessionId = undefined;
    }

    return {
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      lastScreenshot: undefined,
      chatEnabled: false,

      setChatEnabled(enabled) {
        set({ chatEnabled: enabled });
      },

      async startSession(url) {
        // A new session starts a new timeline, so the dedup set starts over
        // with it — otherwise it grows for the life of the tab.
        seenActivityIds = new Set();
        set({
          starting: true,
          error: undefined,
          activity: [],
          tools: [],
          pending: [],
        });
        const result = await request<WebMcpSessionPublic>("/sessions", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        if (!result.ok) {
          set({ starting: false, error: result.error });
          return;
        }
        set({ session: result.data, starting: false });
        connect(result.data.sessionId);
      },

      async closeSession() {
        const sessionId = get().session?.sessionId;
        disconnectStream();
        // Opting the next page in has to be a fresh decision: carrying the
        // choice across sessions would silently grant a DIFFERENT site's tools
        // to chat.
        set({
          session: undefined,
          tools: [],
          pending: [],
          chatEnabled: false,
        });
        if (sessionId) {
          const result = await request(`/sessions/${sessionId}`, {
            method: "DELETE",
          });
          // Surfaced rather than swallowed: the session is already cleared from
          // the UI, so a silent failure leaves a browser window open with no
          // "Close browser" button left to try again with.
          if (!result.ok) set({ error: result.error });
        }
      },

      reconnect() {
        const sessionId = get().session?.sessionId;
        if (sessionId) connect(sessionId);
      },

      async sendCommand(command) {
        const sessionId = get().session?.sessionId;
        if (!sessionId) return undefined;
        const result = await request<unknown>(
          `/sessions/${sessionId}/command`,
          {
            method: "POST",
            body: JSON.stringify(command),
          },
        );
        if (!result.ok) {
          set({ error: result.error });
          return undefined;
        }
        set({ error: undefined });
        return result.data;
      },

      async invokeTool(toolKey, input) {
        // The outcome arrives on the activity stream, not in this response:
        // the server answers as soon as the call is queued.
        await get().sendCommand({
          type: "invoke_tool",
          toolKey,
          input,
          source: "manual",
        });
      },

      async invokeToolForResult(toolKey, input) {
        const response = (await get().sendCommand({
          type: "invoke_tool",
          toolKey,
          input,
          source: "chat",
        })) as { invokeId?: string } | undefined;

        if (!response?.invokeId) {
          const message =
            get().error?.message ?? "The page tool could not be invoked.";
          return { state: "failed", errorMessage: message };
        }

        return new Promise<PageToolInvocationResult>((resolve) => {
          const invokeId = response.invokeId!;
          const timer = setTimeout(() => {
            // The server enforces its own per-invocation timeout, so reaching
            // this one means the settle event itself never arrived — a dropped
            // stream, or a server that went away. Either way the caller gets an
            // answer rather than waiting forever.
            if (!invocationWaiters.delete(invokeId)) return;
            resolve({
              state: "failed",
              errorMessage:
                "Lost track of this invocation — the connection to the browser session dropped.",
            });
          }, INVOCATION_WAIT_TIMEOUT_MS);

          invocationWaiters.set(invokeId, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
        });
      },

      async cancelInvocation(invokeId) {
        await get().sendCommand({ type: "cancel_invocation", invokeId });
      },

      async captureScreenshot() {
        const result = (await get().sendCommand({
          type: "capture_screenshot",
        })) as { screenshotBase64?: string } | undefined;
        set({ lastScreenshot: result?.screenshotBase64 });
      },

      clearError() {
        set({ error: undefined });
      },

      disconnect() {
        disconnectStream();
      },
    };
  },
);

/** Read the active session id without subscribing to the whole store. */
export function getActiveWebMcpSessionId(): string | undefined {
  return useWebmcpInspectorStore.getState().session?.sessionId;
}
