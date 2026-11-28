/**
 * A 2025-era server that keeps to the lifecycle, as a plain function from a
 * request to an answer: a unit test uses it as a scripted `fetch`, an
 * integration test puts it behind a socket.
 *
 * `strict` makes it refuse what a client is not supposed to send yet. "After
 * successful initialization, the client MUST send an `initialized`
 * notification", and until it arrives the session is not ready: every request
 * but `ping` is answered HTTP 400. Real SDK servers behave this way.
 */

export interface LifecycleServerOptions {
  /** Refuse requests on a session whose `initialized` has not arrived. */
  strict?: boolean;
  /** Capabilities the `initialize` answer declares. Tools by default. */
  capabilities?: Record<string, unknown>;
  /** Answer `initialize` without a session id, like a stateless server. */
  stateless?: boolean;
  /** How `initialize` is answered. A normal result by default. */
  initialize?: "ok" | "http-400" | "http-401" | "http-500-bare" | "rpc-error";
  /**
   * Refuse `initialize` because of its protocol version, with this status and
   * JSON-RPC code, naming these versions as supported. `-32022` is the 2026
   * code; `-32602` with `supported` and `requested` is the 2025 example.
   */
  refuseVersion?: { status: number; code: number; supported: string[] };
  /** How `notifications/initialized` is answered. 202 with no body by default. */
  initialized?:
    | "accepted"
    | "accepted-with-body"
    | "ok-200"
    | "ok-200-json"
    | "http-400"
    | "http-503"
    | "unreachable";
  /** Answer `tools/list` (and `ping`) as an event stream instead of JSON. */
  sse?: boolean;
  /** Answer `ping` as JSON even when `sse` is on. */
  pingAsJson?: boolean;
}

export interface LifecycleRequest {
  /** HTTP method. */
  httpMethod: string;
  /** JSON-RPC method, for a POST with a body. */
  method?: string;
  id?: unknown;
  sessionId?: string;
  protocolVersion?: string;
}

export interface LifecycleAnswer {
  status: number;
  headers?: Record<string, string>;
  /** JSON body, when there is one. */
  body?: Record<string, unknown>;
  /** Send `body` as one event-stream frame. */
  sse?: boolean;
}

/** Thrown for a request the server does not answer at all. */
export class Unreachable extends Error {
  constructor() {
    super("connection reset");
    this.name = "Unreachable";
  }
}

/** One line per request, in arrival order. */
export type LifecycleLog = string[];

const SESSION = "session-1";

export function createLifecycleServer(
  options: LifecycleServerOptions,
  log: LifecycleLog
): (request: LifecycleRequest) => LifecycleAnswer {
  /** Sessions whose `initialized` notification has arrived. */
  const ready = new Set<string>();
  /** How many `initialized` notifications arrived, across sessions. */
  let stateless = 0;

  return (request) => {
    if (request.httpMethod !== "POST") {
      log.push(request.httpMethod);
      return { status: 405 };
    }
    const method = request.method ?? "";
    log.push(`POST ${method}`);
    const error = (
      status: number,
      code: number,
      message: string
    ): LifecycleAnswer => ({
      status,
      body: {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code, message },
      },
    });
    const result = (
      payload: Record<string, unknown>,
      asStream = options.sse === true
    ): LifecycleAnswer => ({
      status: 200,
      body: { jsonrpc: "2.0", id: request.id, result: payload },
      ...(asStream ? { sse: true } : {}),
    });

    if (method === "initialize" && options.refuseVersion) {
      const { status, code, supported } = options.refuseVersion;
      return {
        status,
        body: {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code,
            message: "Unsupported protocol version",
            data: { supported, requested: request.protocolVersion },
          },
        },
      };
    }
    if (method === "initialize") {
      if (options.initialize === "http-400") {
        return error(400, -32600, "Invalid Request");
      }
      // No JSON-RPC body: what a proxy in front of a dead server sends.
      if (options.initialize === "http-500-bare") return { status: 500 };
      // The authorization layer in front of the server, asking for a login.
      if (options.initialize === "http-401") return { status: 401 };
      if (options.initialize === "rpc-error") {
        return error(200, -32603, "Internal error");
      }
      return {
        ...result(
          {
            protocolVersion: request.protocolVersion ?? "2025-11-25",
            capabilities: options.capabilities ?? { tools: {} },
            serverInfo: { name: "lifecycle-fixture", version: "1" },
          },
          false
        ),
        headers: options.stateless ? {} : { "Mcp-Session-Id": SESSION },
      };
    }

    const session = request.sessionId ?? (options.stateless ? "" : undefined);

    if (method === "notifications/initialized") {
      if (options.initialized === "unreachable") throw new Unreachable();
      if (options.initialized === "http-400") return { status: 400 };
      if (options.initialized === "http-503") return { status: 503 };
      if (session !== undefined) ready.add(session);
      stateless += 1;
      if (options.initialized === "accepted-with-body") {
        return { status: 202, body: { jsonrpc: "2.0", result: {} } };
      }
      if (options.initialized === "ok-200") return { status: 200 };
      if (options.initialized === "ok-200-json") {
        // Not a JSON-RPC message at all: a schema violation on the wire.
        return { status: 200, body: { ok: true } };
      }
      return { status: 202 };
    }

    if (
      options.strict &&
      method !== "ping" &&
      (session === undefined || !ready.has(session))
    ) {
      return error(
        400,
        -32600,
        "Received a request before the initialized notification"
      );
    }

    switch (method) {
      case "ping":
        return result({}, options.sse === true && !options.pingAsJson);
      case "tools/list":
        return result({ tools: [] });
      case "prompts/list":
        return result({ prompts: [] });
      case "resources/list":
        return result({ resources: [] });
      default:
        return error(200, -32601, `Method not found: ${method}`);
    }
  };
}

/** The lifecycle server as a scripted `fetch`. */
export function lifecycleServerFetch(
  options: LifecycleServerOptions,
  log: LifecycleLog,
  /** Each request's headers, in arrival order, for a test that reads them. */
  seenHeaders: Headers[] = []
): typeof fetch {
  const server = createLifecycleServer(options, log);
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers);
    const httpMethod = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const answer = server({
      httpMethod,
      method: body?.method,
      id: body?.id,
      sessionId: headers.get("mcp-session-id") ?? undefined,
      protocolVersion:
        body?.method === "initialize"
          ? body.params?.protocolVersion
          : (headers.get("mcp-protocol-version") ?? undefined),
    });
    return toResponse(answer);
  };
}

/** Turn an answer into a `Response`, as JSON or as one event-stream frame. */
export function toResponse(answer: LifecycleAnswer): Response {
  if (answer.body === undefined) {
    return new Response(null, {
      status: answer.status,
      headers: answer.headers,
    });
  }
  if (answer.sse) {
    return new Response(`data: ${JSON.stringify(answer.body)}\n\n`, {
      status: answer.status,
      headers: { "Content-Type": "text/event-stream", ...answer.headers },
    });
  }
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "Content-Type": "application/json", ...answer.headers },
  });
}
