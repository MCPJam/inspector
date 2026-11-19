/**
 * `subscriptions/listen` on the harness MCP proxy (MCP 2026-07-28).
 *
 * The spec says the server MUST send `notifications/subscriptions/acknowledged`
 * as the first message of the listen stream. The proxy is stateless and relays
 * no server-to-client notifications (the legacy GET stream is a keep-alive for
 * the same reason), so it honours no notification type: it acknowledges with an
 * empty filter at once, keeps the stream open, and ends it gracefully at the
 * stream cap. Forwarding the listen upstream instead held the acknowledgment
 * until the upstream subscription ended, and a client that waits for it before
 * listing tools stalled for tens of seconds.
 */

export const LISTEN_METHOD = "subscriptions/listen";

/** `MCPJAM_HARNESS_LISTEN_ACK=1` answers listen here; read per call. */
export function harnessListenAckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_LISTEN_ACK === "1";
}

type JsonRpcId = string | number;

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function sseMessage(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

const KEEPALIVE_MS = 15_000;

/** The listen response: the acknowledgment, keep-alives, then a graceful end. */
export function acknowledgedListenStream(id: JsonRpcId, maxMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const subscription = { "io.modelcontextprotocol/subscriptionId": id };
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let end: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (keepalive) clearInterval(keepalive);
    if (end) clearTimeout(end);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sseMessage({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: { _meta: subscription, notifications: {} },
          }),
        ),
      );
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // The client closed the stream: that is its cancellation.
          stop();
        }
      }, KEEPALIVE_MS);
      end = setTimeout(() => {
        stop();
        try {
          controller.enqueue(encoder.encode(sseMessage({ jsonrpc: "2.0", id, result: { _meta: subscription } })));
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }, maxMs);
    },
    cancel() {
      stop();
    },
  });
}

export const DISCOVER_METHOD = "server/discover";

/**
 * `MCPJAM_HARNESS_MCP_LEGACY_DOWNSTREAM=1`: the proxy answers `server/discover`
 * as a server without 2026-07-28 support would, method not found, so the
 * harness client always takes the `initialize` handshake this stateless proxy
 * serves in full. Its own connection upstream still negotiates on its own.
 * Read per call.
 */
export function harnessLegacyDownstreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_MCP_LEGACY_DOWNSTREAM === "1";
}

export function methodNotFound(id: JsonRpcId | null, method: string) {
  return { jsonrpc: "2.0" as const, id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/**
 * `MCPJAM_HARNESS_MCP_LEAN_DISCOVERY=1`: a discovery request (the handshake,
 * ping and the list methods) is authorized against its live turn once, as every
 * request is, and skips the re-checks after connecting and after answering,
 * which exist so a tool's result never reaches a later turn; a list carries no
 * such result. `notifications/initialized` is answered once authorized: the
 * proxy keeps its own connection upstream and has no use for it. Read per call.
 */
export function harnessLeanDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_MCP_LEAN_DISCOVERY === "1";
}

const DISCOVERY_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

export function isDiscoveryMethod(method: unknown): boolean {
  return typeof method === "string" && DISCOVERY_METHODS.has(method);
}

export const INITIALIZED_NOTIFICATION = "notifications/initialized";
