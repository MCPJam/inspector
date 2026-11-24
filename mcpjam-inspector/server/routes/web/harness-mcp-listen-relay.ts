/**
 * `subscriptions/listen` (MCP 2026-07-28), relayed to the upstream server.
 *
 * The bridge's passthrough answers a request once the upstream request ends,
 * and a listen ends only when its subscription does. Passed through, a listen
 * would hold back the upstream's acknowledgment, which the spec says comes
 * first, and every notification after it, for the life of the subscription:
 * a client that waits for the acknowledgment before listing tools stalls for
 * as long (Claude Code gives up on its configuration after 30 s).
 *
 * This opens the listen upstream on a manager of its own and writes the
 * upstream's answers to the harness as they arrive: the acknowledgment, with
 * the filter the upstream honors, then each change notification it sends,
 * stamped with the harness's own listen id. The stream ends when the
 * harness cancels it (closing the stream, or `notifications/cancelled` for
 * its id), when the upstream ends the subscription, when the turn it belongs
 * to is no longer authorized (checked live, on every keep-alive), or at the
 * proxy's stream cap. Whichever comes first closes the upstream listen and
 * disconnects the manager, once. One caller (a token, on one server) holds at
 * most `MAX_LISTENS_PER_CALLER` listens on an instance at once.
 *
 * An upstream on a 2025-era connection has no listen: its acknowledgment
 * honors nothing.
 *
 * The proxy also answers the handshake from the server's real connection
 * (the bridge's `awaitConnect`). Otherwise a request's new manager is still
 * connecting when the handshake arrives, so the harness gets method-not-found
 * for `server/discover`, falls back to the 2025 handshake and never listens.
 * The two go together: the real handshake without the relay would take every
 * turn into the stall.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

export const LISTEN_METHOD = "subscriptions/listen";

type JsonRpcId = string | number;

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** The filter keys this relay forwards, and the notification each one names. */
const CHANGE_NOTIFICATIONS = {
  toolsListChanged: "notifications/tools/list_changed",
  promptsListChanged: "notifications/prompts/list_changed",
  resourcesListChanged: "notifications/resources/list_changed",
  resourceSubscriptions: "notifications/resources/updated",
} as const;

type ChangeKey = keyof typeof CHANGE_NOTIFICATIONS;
type ListenFilter = {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
};

type ManagedClient = NonNullable<
  ReturnType<MCPClientManager["getManagedClient"]>
>;
type ListenHandle = Awaited<ReturnType<NonNullable<ManagedClient["listen"]>>>;
type NotificationHandler = Parameters<
  MCPClientManager["addNotificationHandler"]
>[2];

/**
 * The part of a listen request's filter this relay can carry upstream. Task
 * ids are dropped: a task-filtered listen needs the tasks extension's
 * declaration, and the relay never makes one.
 */
export function relayableFilter(params: unknown): ListenFilter {
  const raw =
    params && typeof params === "object"
      ? (params as { notifications?: unknown }).notifications
      : undefined;
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const filter: ListenFilter = {};
  if (source.toolsListChanged === true) filter.toolsListChanged = true;
  if (source.promptsListChanged === true) filter.promptsListChanged = true;
  if (source.resourcesListChanged === true) filter.resourcesListChanged = true;
  if (Array.isArray(source.resourceSubscriptions)) {
    const uris = source.resourceSubscriptions.filter(
      (uri): uri is string => typeof uri === "string",
    );
    if (uris.length > 0) filter.resourceSubscriptions = uris;
  }
  return filter;
}

/** The notification methods a filter asks for. */
function requestedMethods(filter: ListenFilter): string[] {
  return (Object.keys(CHANGE_NOTIFICATIONS) as ChangeKey[])
    .filter((key) => {
      const value = filter[key];
      return Array.isArray(value) ? value.length > 0 : value === true;
    })
    .map((key) => CHANGE_NOTIFICATIONS[key]);
}

function isLegacyConnection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("requires a 2026-07-28-era connection");
}

/** Closing a listen that is going away anyway: worth a debug line, no more. */
function upstreamCloseFailed(error: unknown): void {
  logger.debug("[harness-mcp] relayed listen: upstream close failed", {
    error: error instanceof Error ? error.name : "unknown",
  });
}

function sse(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/** Listens in flight, by the key the harness's cancellation names them with. */
const relays = new Map<string, Set<() => void>>();
/** Listens in flight per caller: one token, on one server. */
const openByCaller = new Map<string, number>();

/** Listens one caller may hold open on this instance at once. */
export const MAX_LISTENS_PER_CALLER = 4;

/**
 * End the relayed listen `key` names, if one is open here. Two clients that
 * present the same token share keys; a cancellation either could have sent
 * ends neither, and each listen still ends when its client closes its stream.
 */
export function cancelRelayedListen(key: string): boolean {
  const open = relays.get(key);
  if (!open || open.size === 0) return false;
  if (open.size === 1) {
    for (const cancel of open) cancel();
  } else {
    logger.debug("[harness-mcp] relayed listen: ambiguous cancellation", {
      open: open.size,
    });
  }
  return true;
}

export function relayedListenCount(): number {
  let count = 0;
  for (const open of relays.values()) count += open.size;
  return count;
}

export function relayListenStream(args: {
  /** The harness's listen request id: every frame it receives carries it. */
  id: JsonRpcId;
  params: unknown;
  serverId: string;
  manager: MCPClientManager;
  /** Who holds the listen (one token, on one server), for the cap. */
  caller: string;
  /** Where a `notifications/cancelled` for `id` finds this listen. */
  cancelKey: string;
  maxMs: number;
  keepaliveMs?: number;
  /** A live check of the turn the listen belongs to; false ends the stream. */
  stillAuthorized?: () => Promise<boolean>;
  /** Runs before a change is forwarded, which the harness lists again on. */
  onChange?: () => void;
  /** Runs once the stream has ended, however it ended. */
  onEnd?: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let forwarded = 0;
  const subscription = { [SUBSCRIPTION_ID]: args.id };
  const filter = relayableFilter(args.params);
  const methods = requestedMethods(filter);
  const opening = new AbortController();
  let handle: ListenHandle | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const handlers: Array<[string, NotificationHandler]> = [];
  const cancelThis = () => end("harness-cancelled");
  // Counted here, with no wait after the check, so the cap holds under load.
  const full =
    (openByCaller.get(args.caller) ?? 0) >= MAX_LISTENS_PER_CALLER;
  if (!full) {
    openByCaller.set(args.caller, (openByCaller.get(args.caller) ?? 0) + 1);
    const open = relays.get(args.cancelKey) ?? new Set<() => void>();
    open.add(cancelThis);
    relays.set(args.cancelKey, open);
  }

  const write = (chunk: string) => {
    if (ended) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // The harness closed the stream; `cancel` ends the rest.
    }
  };

  const end = (cause: string, closing?: unknown) => {
    if (ended) return;
    if (closing !== undefined) write(sse(closing));
    ended = true;
    logger.debug("[harness-mcp] relayed listen ended", {
      cause,
      ms: Date.now() - startedAt,
      forwarded,
    });
    if (!full) {
      const open = relays.get(args.cancelKey);
      open?.delete(cancelThis);
      if (open?.size === 0) relays.delete(args.cancelKey);
      const held = (openByCaller.get(args.caller) ?? 1) - 1;
      if (held > 0) openByCaller.set(args.caller, held);
      else openByCaller.delete(args.caller);
    }
    if (keepalive) clearInterval(keepalive);
    if (cap) clearTimeout(cap);
    opening.abort();
    for (const [method, handler] of handlers) {
      args.manager.removeNotificationHandler(args.serverId, method, handler);
    }
    const upstream = handle;
    void Promise.resolve(upstream?.close())
      .catch((error: unknown) => upstreamCloseFailed(error))
      .finally(() => {
        args.onEnd?.();
      });
    try {
      controller.close();
    } catch {
      // Already closed by the harness.
    }
  };

  // The spec's graceful end. A 2026-07-28 result names its `resultType`.
  const graceful = {
    jsonrpc: "2.0",
    id: args.id,
    result: { _meta: subscription, resultType: "complete" },
  };

  const watchChanges = () => {
    for (const method of methods) {
      const handler: NotificationHandler = (notification) => {
        const params = notification.params ?? {};
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        // Only what arrives on a listen: a 2026-07-28 upstream stamps every
        // change it sends there with that listen's id.
        if (meta[SUBSCRIPTION_ID] === undefined) return;
        args.onChange?.();
        forwarded += 1;
        write(
          sse({
            jsonrpc: "2.0",
            method: notification.method,
            params: { ...params, _meta: { ...meta, ...subscription } },
          }),
        );
      };
      handlers.push([method, handler]);
      args.manager.addNotificationHandler(args.serverId, method, handler);
    }
  };

  const start = async () => {
    if (full) {
      end("too-many", {
        jsonrpc: "2.0",
        id: args.id,
        error: {
          code: -32000,
          message:
            "Too many subscriptions are open for this server. Close one, then listen again.",
        },
      });
      return;
    }
    let honored: ListenFilter = {};
    try {
      // The manager is new, so its connect may still be running. The handlers
      // go on once it is done: one added while it runs is never wired to the
      // client. The listen opens after them, so nothing it sends is missed.
      const client =
        methods.length > 0
          ? await args.manager.ensureManagedClient(args.serverId, {
              signal: opening.signal,
            })
          : undefined;
      if (ended) return;
      watchChanges();
      if (client?.listen) {
        handle = await client.listen(filter, { signal: opening.signal });
        if (ended) {
          void handle
            .close()
            .catch((error: unknown) => upstreamCloseFailed(error));
          return;
        }
        honored = relayableFilter({ notifications: handle.honoredFilter });
        void handle.closed.then((cause) => {
          if (cause === "graceful") end("upstream-ended", graceful);
          // A loss without a result: the harness re-listens if it wants to.
          else if (cause === "remote") end("upstream-lost");
        });
      }
    } catch (error) {
      if (ended) return;
      if (!isLegacyConnection(error)) {
        end("open-failed", {
          jsonrpc: "2.0",
          id: args.id,
          error: {
            code: -32603,
            message: "The server's subscription could not be opened.",
          },
        });
        return;
      }
    }
    write(
      sse({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: subscription, notifications: honored },
      }),
    );
    keepalive = setInterval(() => {
      write(": keepalive\n\n");
      if (!args.stillAuthorized) return;
      void args.stillAuthorized().then(
        (authorized) => {
          if (!authorized) end("turn-refused", graceful);
        },
        () => end("turn-check-failed", graceful),
      );
    }, args.keepaliveMs ?? 15_000);
    cap = setTimeout(() => end("cap", graceful), args.maxMs);
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      start().catch((error: unknown) => {
        reportRouteFailure("Could not open the upstream subscription.", error, {
          source: "harness.mcp.listen_relay",
          hop: "user_server_hop",
        });
        end("relay-failed", {
          jsonrpc: "2.0",
          id: args.id,
          error: {
            code: -32603,
            message: "The server's subscription could not be opened.",
          },
        });
      });
    },
    cancel() {
      end("harness-closed");
    },
  });
}
