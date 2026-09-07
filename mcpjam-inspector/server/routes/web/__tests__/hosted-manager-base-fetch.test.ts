/**
 * MJ-001, the structural half: a hosted manager carries a guarded transport
 * fetch, and the guard actually refuses.
 *
 * WHY BOTH ASSERTIONS. `baseFetch !== undefined` would have passed for any
 * function at all, including `globalThis.fetch` assigned by a refactor that
 * meant to be helpful. So each case also drives the captured fetch at a private
 * address and requires a refusal. A fetch that does not refuse is the bug,
 * whatever the field says.
 *
 * SCOPE. This covers the two factories a test can drive without standing up a
 * route: `createAuthorizedManager` (behind every `/api/web/*` MCP operation,
 * including `/servers/validate`) and `buildReplayManager` (eval replay). The
 * two agent surfaces construct theirs inside streaming route handlers; they are
 * held by `scripts/check-hosted-manager-base-fetch.mjs`, which counts
 * constructions against guard injections per file and so cannot be satisfied by
 * guarding one of a file's two managers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { managerConstructions } = vi.hoisted(() => ({
  managerConstructions: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  class RecordingManager {
    constructor(
      _configs: Record<string, unknown>,
      options?: Record<string, unknown>
    ) {
      managerConstructions.push(options);
    }
    setElicitationCallback() {}
    setMrtrInputCollector() {}
    async disconnectAllServers() {}
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

async function withHostedMode<T>(hosted: boolean, run: () => Promise<T>) {
  const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  managerConstructions.length = 0;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
    else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
    vi.resetModules();
  }
}

/** The private targets a hosted manager must never be able to dial. */
const PRIVATE_TARGETS = [
  "http://127.0.0.1:6274/mcp",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5/mcp",
];

async function expectGuardedFetch(options: Record<string, unknown> | undefined) {
  expect(options).toBeDefined();
  const baseFetch = options?.baseFetch;
  expect(typeof baseFetch).toBe("function");
  expect(baseFetch).not.toBe(globalThis.fetch);

  const { BlockedEgressTargetError } = await import(
    "../../../utils/hosted-egress-guard.js"
  );
  for (const target of PRIVATE_TARGETS) {
    await expect(
      (baseFetch as typeof fetch)(target)
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  }
}

describe("createAuthorizedManager", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        return new Response(
          JSON.stringify({
            results: {
              s1: {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://mcp.example.test/mcp",
                  useOAuth: false,
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl) {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("guards the manager it builds for an authorized batch", async () => {
    await withHostedMode(true, async () => {
      const { createAuthorizedManager } = await import("../auth.js");
      await createAuthorizedManager(
        { authMethod: "jwt" } as never,
        "bearer-token",
        "p1",
        ["s1"],
        5_000
      );
      expect(managerConstructions).toHaveLength(1);
      await expectGuardedFetch(managerConstructions[0]);
    });
  });

  it("guards the empty-batch manager too", async () => {
    // The early return builds a manager with no servers, which a caller can
    // still attach one to through `connectToServer` — `baseFetch` resolves at
    // transport-build time, so leaving it off here would have made this branch
    // the one way to get an unguarded hosted manager.
    await withHostedMode(true, async () => {
      const { createAuthorizedManager } = await import("../auth.js");
      await createAuthorizedManager(
        { authMethod: "jwt" } as never,
        "bearer-token",
        "p1",
        [],
        5_000
      );
      expect(managerConstructions).toHaveLength(1);
      await expectGuardedFetch(managerConstructions[0]);
    });
  });

  it("still dials loopback in local mode", async () => {
    // `routes/web/**` is mounted on the desktop app too, where reaching the
    // developer's own server is the entire product.
    await withHostedMode(false, async () => {
      const { createAuthorizedManager } = await import("../auth.js");
      await createAuthorizedManager(
        { authMethod: "jwt" } as never,
        "bearer-token",
        "p1",
        [],
        5_000
      );
      const baseFetch = managerConstructions[0]?.baseFetch as typeof fetch;
      expect(typeof baseFetch).toBe("function");

      const spy = vi.fn(async () => new Response("{}"));
      const saved = global.fetch;
      global.fetch = spy as unknown as typeof fetch;
      try {
        const response = await baseFetch("http://127.0.0.1:6274/mcp");
        expect(response.status).toBe(200);
      } finally {
        global.fetch = saved;
      }
    });
  });
});

describe("buildReplayManager", () => {
  it("guards the eval replay manager", async () => {
    await withHostedMode(true, async () => {
      const { buildReplayManager } = await import(
        "../../../services/evals/route-helpers.js"
      );
      buildReplayManager({
        runId: "r1",
        suiteId: "s1",
        servers: [
          { serverId: "s1", url: "https://mcp.example.test/mcp" } as never,
        ],
      });
      expect(managerConstructions).toHaveLength(1);
      await expectGuardedFetch(managerConstructions[0]);
    });
  });
});

describe("the doctor's connect leg", () => {
  /**
   * BELT, not braces. `runHostedDoctor` also runs `assertHostedDoctorTarget`
   * before either leg, so in the route a loopback URL never reaches this code.
   * This drives `runServerDoctor` directly, without that pre-check, because the
   * finding was precisely that the pre-check was the ONLY thing standing there:
   * `runServerDoctor` records a failed probe and connects anyway, and its
   * connection took no guard. If the config's `baseFetch` ever stops reaching
   * the transport, this fails and the route's 400 hides it.
   */
  it("never opens a socket to a loopback target", async () => {
    await withHostedMode(true, async () => {
      vi.doUnmock("@mcpjam/sdk");
      vi.resetModules();
      const http = await import("node:http");
      const { runServerDoctor } = await import("@mcpjam/sdk");
      const { hostedMcpBaseFetch } = await import(
        "../../../utils/hosted-mcp-base-fetch.js"
      );

      let requestsReceived = 0;
      const server = http.createServer((_req, res) => {
        requestsReceived += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", environment: "prod" }));
      });
      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve((server.address() as { port: number }).port);
        });
      });

      try {
        const guarded = hostedMcpBaseFetch();
        const result = await runServerDoctor({
          config: {
            url: `http://127.0.0.1:${port}/mcp`,
            timeout: 5_000,
            baseFetch: guarded,
          },
          target: { kind: "http", scope: "hosted" },
          timeout: 5_000,
          fetchFn: guarded,
        });

        expect(result.status).toBe("error");
        // The only assertion that cannot be satisfied by a cosmetic change.
        expect(requestsReceived).toBe(0);
      } finally {
        await new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        });
      }
    });
  });
});
