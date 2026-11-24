import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { McpHandlerRequestOptions } from "@modelcontextprotocol/server";
import type { MockRealServer } from "./real-server.js";

/**
 * The sessions a 2025-era caller needs for a mock that asks questions: the
 * server SDK sends the question to the client on the session's connection and
 * waits for the answer, so the session must outlive one HTTP request. The map
 * lives in the process that serves the route. A caller that lands on another
 * replica meets a 404 and starts over, so this holds for callers in the same
 * process and is not guaranteed for the rest. A 2026-07-28 caller needs none.
 */

export interface MockSessionMapOptions {
  /** Sessions held at once, over all keys. Default 200. */
  maxSessions?: number;
  /** Sessions one key (a caller and a mock version) may hold. Default 8. */
  maxPerKey?: number;
  /** A session idle this long is closed. Default 5 minutes. */
  idleMs?: number;
  now?: () => number;
}

interface Session {
  id: string;
  key: string;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  swap: SwappableReal;
  lastUsedAt: number;
  /** Requests being served; a session is never closed under one. */
  busy: number;
}

export interface MockSessionMap {
  /** Serves one 2025-era request for `key`, creating the session on `initialize`. */
  handle(
    key: string,
    request: Request,
    real: MockRealServer,
    build: (swap: MockRealServer) => Promise<Server>,
    options?: McpHandlerRequestOptions
  ): Promise<Response>;
  size(): number;
  /** Closes idle sessions now; also runs on every request. */
  sweep(): Promise<void>;
  closeAll(): Promise<void>;
}

/** The real server of a session: the session outlives the request that opened it, so the connection behind it is swapped in on every request. */
class SwappableReal implements MockRealServer {
  constructor(private current: MockRealServer) {}
  use(real: MockRealServer) {
    this.current = real;
  }
  describe: MockRealServer["describe"] = (o) => this.current.describe(o);
  listTools: MockRealServer["listTools"] = (o) => this.current.listTools(o);
  callTool: MockRealServer["callTool"] = (c) => this.current.callTool(c);
  request: MockRealServer["request"] = (r, o) => this.current.request(r, o);
  onListChanged: MockRealServer["onListChanged"] = (h) =>
    this.current.onListChanged(h);
}

function sessionError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message, data: { mockCode: "mock_session_lost" } },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

export function createMockSessionMap(
  options: MockSessionMapOptions = {}
): MockSessionMap {
  const maxSessions = options.maxSessions ?? 200;
  const maxPerKey = options.maxPerKey ?? 8;
  const idleMs = options.idleMs ?? 300_000;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const close = async (session: Session) => {
    sessions.delete(session.id);
    await session.server.close();
  };
  const oldestIdle = (key?: string) =>
    [...sessions.values()]
      .filter((s) => s.busy === 0 && (key === undefined || s.key === key))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];

  const sweep = async () => {
    const stale = [...sessions.values()].filter(
      (s) => s.busy === 0 && now() - s.lastUsedAt > idleMs
    );
    await Promise.all(stale.map(close));
  };

  /** Makes room for one more session of `key`, or says there is none. */
  async function makeRoom(key: string): Promise<boolean> {
    const own = [...sessions.values()].filter((s) => s.key === key).length;
    if (own >= maxPerKey) {
      const victim = oldestIdle(key);
      if (!victim) return false;
      await close(victim);
    }
    if (sessions.size >= maxSessions) {
      const victim = oldestIdle();
      if (!victim) return false;
      await close(victim);
    }
    return true;
  }

  return {
    size: () => sessions.size,
    sweep,
    async closeAll() {
      await Promise.all([...sessions.values()].map(close));
    },
    async handle(key, request, real, build, fetchOptions) {
      await sweep();
      const id = request.headers.get("mcp-session-id");
      if (id) {
        const session = sessions.get(id);
        // Another caller's session id reads as no session at all.
        if (!session || session.key !== key) {
          return sessionError(
            404,
            "This session is gone: the mock closed it after it sat idle, or it lives on another replica. Connect again to start a new one."
          );
        }
        session.swap.use(real);
        session.busy += 1;
        try {
          return await session.transport.handleRequest(request, fetchOptions);
        } finally {
          session.busy -= 1;
          session.lastUsedAt = now();
        }
      }
      if (!(await makeRoom(key))) {
        return sessionError(
          429,
          "This mock holds as many open sessions as it allows. Close one you no longer use, or wait a few minutes, then connect again."
        );
      }
      const swap = new SwappableReal(real);
      const server = await build(swap);
      let session: Session | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId) => {
          session = {
            id: sessionId,
            key,
            server,
            transport,
            swap,
            lastUsedAt: now(),
            busy: 1,
          };
          sessions.set(sessionId, session);
        },
        onsessionclosed: (sessionId) => {
          sessions.delete(sessionId);
        },
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, fetchOptions);
      } finally {
        if (session) {
          session.busy -= 1;
          session.lastUsedAt = now();
        } else {
          // Not an initialize: nothing was registered, so nothing holds the server.
          await server.close();
        }
      }
    },
  };
}

/** The legacy leg of a mock that asks: `(request, real, options) => response` over one map and key. */
export function createLegacySessionHandler(
  map: MockSessionMap,
  key: string,
  build: (swap: MockRealServer) => Promise<Server>
) {
  return (
    request: Request,
    real: MockRealServer,
    options?: McpHandlerRequestOptions
  ) => map.handle(key, request, real, build, options);
}
