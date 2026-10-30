import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Prod runs several replicas with no sticky sessions, so the browser's
 * `/oauth/start`, `/oauth/authorize` and `/oauth/complete` can each land on a
 * different one. Each "replica" here is a fresh module graph (its own
 * in-memory session store), and all of them share one fake Convex — the only
 * thing real replicas share. The run starts on replica 1; the code and the
 * result go through replica 2.
 */

type Row = {
  owner: string;
  status: string;
  code?: string;
  state?: string;
  resultJson?: string;
  error?: string;
};

const fakeConvex = vi.hoisted(() => ({ rows: new Map<string, Row>() }));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    private owner = "";
    setAuth(token: string) {
      this.owner = token;
    }
    async mutation(name: string, args: any) {
      const row = fakeConvex.rows.get(args.sessionId);
      if (name === "conformanceOAuthRendezvous:create") {
        fakeConvex.rows.set(args.sessionId, {
          owner: this.owner,
          status: "awaiting_code",
        });
        return { sessionId: args.sessionId, expiresAt: Date.now() + 600_000 };
      }
      if (name === "conformanceOAuthRendezvous:submitCode") {
        if (!row || row.owner !== this.owner) {
          return { ok: false, reason: "not_found" };
        }
        if (row.status !== "awaiting_code")
          return { ok: false, reason: "not_pending" };
        Object.assign(row, {
          status: "code_submitted",
          code: args.code,
          state: args.state,
        });
        return { ok: true };
      }
      throw new Error(`unexpected mutation ${name}`);
    }
    async query(name: string, args: any) {
      if (name !== "conformanceOAuthRendezvous:get") {
        throw new Error(`unexpected query ${name}`);
      }
      const row = fakeConvex.rows.get(args.sessionId);
      if (!row || row.owner !== this.owner) return null;
      return {
        status: row.status,
        ...(row.resultJson ? { resultJson: row.resultJson } : {}),
        ...(row.error ? { error: row.error } : {}),
      };
    }
  },
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  // Stands in for the OAuth runner: asks for user authorization through the
  // real remote-browser controller, then passes only with the right code.
  class CodeCheckingOAuthConformanceTest {
    constructor(
      _config: unknown,
      private readonly deps: {
        createInteractiveAuthorizationSession: () => Promise<{
          authorize(input: {
            authorizationUrl: string;
          }): Promise<{ code: string }>;
        }>;
      },
    ) {}

    async run() {
      const session = await this.deps.createInteractiveAuthorizationSession();
      const { code } = await session.authorize({
        authorizationUrl: "https://auth.example/authorize",
      });
      return {
        passed: code === "good-code",
        outcome: code === "good-code" ? "passed" : "failed",
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        serverUrl: "https://mcp.example.test/mcp",
        summary: "done",
        durationMs: 1,
        steps: [],
      };
    }
  }
  return { ...actual, OAuthConformanceTest: CodeCheckingOAuthConformanceTest };
});

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        return c.json(await handler(), 200);
      } catch (error: any) {
        return c.json(
          { code: error?.code ?? "INTERNAL_ERROR", message: error?.message },
          error?.status ?? 500,
        );
      }
    },
    projectServerSchema: z.object({}).passthrough(),
    authorizeServer: async () => ({
      serverConfig: {
        transportType: "http",
        url: "https://mcp.example.test/mcp",
      },
    }),
    toHttpConfig: () => ({}),
  };
});

// Fast loops so the round trip takes milliseconds.
vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  CONFORMANCE_OAUTH_POLL_INTERVAL_MS: 5,
  CONFORMANCE_OAUTH_POLL_JITTER_MS: 0,
  CONFORMANCE_OAUTH_COMPLETE_INTERVAL_MS: 5,
}));

/** The service-token legs, served from the same fake Convex. */
function stubConvexHttp() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      const row = fakeConvex.rows.get(body.sessionId);
      const json = (value: unknown) =>
        ({ ok: true, json: async () => value }) as any;
      if (path === "/conformance-oauth/poll") {
        return json({
          ok: true,
          rendezvous: row
            ? {
                status: row.status,
                ...(row.status === "code_submitted"
                  ? { code: row.code, state: row.state }
                  : {}),
              }
            : null,
        });
      }
      if (path === "/conformance-oauth/ack") {
        if (row)
          Object.assign(row, {
            status: "running",
            code: undefined,
            state: undefined,
          });
        return json({ ok: true, acked: true });
      }
      if (path === "/conformance-oauth/finish") {
        if (
          row &&
          ["awaiting_code", "code_submitted", "running"].includes(row.status)
        ) {
          Object.assign(row, {
            status: body.resultJson ? "complete" : "failed",
            resultJson: body.resultJson,
            error: body.error,
          });
        }
        return json({ ok: true, finished: true });
      }
      throw new Error(`unexpected fetch ${path}`);
    }),
  );
}

type Replica = {
  router: (typeof import("../conformance.js"))["default"];
  stop: () => Promise<void>;
};
const replicas: Replica[] = [];

/** A fresh module graph: its own in-memory sessions, like another process. */
async function startReplica(): Promise<Replica> {
  vi.resetModules();
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
  const { default: router } = await import("../conformance.js");
  const rendezvous =
    await import("../../../services/conformance-oauth-rendezvous.js");
  const sessions =
    await import("../../../services/conformance-oauth-sessions.js");
  const replica = {
    router,
    stop: async () => {
      await rendezvous.stopLiveConformanceOAuthRuns();
      sessions.clearAllSessions();
    },
  };
  replicas.push(replica);
  return replica;
}

async function post(
  replica: Replica,
  path: string,
  body: Record<string, unknown>,
  bearer = "user-a",
) {
  const res = await replica.router.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function startRun(replica: Replica) {
  const started = await post(replica, "/oauth/start", {
    projectId: "p1",
    serverId: "s1",
    callbackOrigin: "https://app.example.test",
  });
  expect(started.status).toBe(200);
  expect(started.body.phase).toBe("authorization_needed");
  return started.body.sessionId as string;
}

beforeEach(() => {
  fakeConvex.rows.clear();
  stubConvexHttp();
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex-http.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-token-0123456789";
});

afterEach(async () => {
  for (const replica of replicas.splice(0)) await replica.stop();
  vi.unstubAllGlobals();
});

describe("hosted OAuth conformance across replicas", () => {
  it("finishes a run whose code and result go through another replica", async () => {
    const replica1 = await startReplica();
    const replica2 = await startReplica();

    const sessionId = await startRun(replica1);

    const authorized = await post(replica2, "/oauth/authorize", {
      sessionId,
      code: "good-code",
    });
    expect(authorized).toEqual({ status: 200, body: { success: true } });

    const completed = await post(replica2, "/oauth/complete", { sessionId });
    expect(completed.status).toBe(200);
    expect(completed.body.phase).toBe("complete");
    expect(completed.body.result.passed).toBe(true);

    // The code was scrubbed once the run had it.
    expect(fakeConvex.rows.get(sessionId)?.code).toBeUndefined();
  });

  it("refuses another user's code", async () => {
    const replica1 = await startReplica();
    const replica2 = await startReplica();
    const sessionId = await startRun(replica1);

    const authorized = await post(
      replica2,
      "/oauth/authorize",
      { sessionId, code: "good-code" },
      "user-b",
    );
    expect(authorized.status).toBe(404);
    expect(authorized.body.message).toBe(
      "Authorization took too long. Run the checks again.",
    );
  });

  it("without the rendezvous, another replica can't find the run (the prod bug)", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    const replica1 = await startReplica();
    const replica2 = await startReplica();
    const sessionId = await startRun(replica1);

    const authorized = await post(replica2, "/oauth/authorize", {
      sessionId,
      code: "good-code",
    });
    expect(authorized.status).toBe(404);
    expect(authorized.body.message).toBe(
      "Authorization took too long. Run the checks again.",
    );
  });
});
