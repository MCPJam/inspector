/**
 * MJ-001, persisted conformance runs: every suite dials through the hosted
 * egress guard whoever started the run, a target the guard refuses is never
 * dialled at all, and the stored report says no more about a refused target
 * than the verdict.
 *
 * These go through the REAL executor and the REAL SDK suites — only Convex is
 * stubbed — because the hole was in the seam between them: the executor
 * handed the SDK a server config and the protocol suite dropped its fetch. A
 * suite that mocks `runConformance` cannot see that.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createConvexClientMock } = vi.hoisted(() => ({
  createConvexClientMock: vi.fn(),
}));

vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClientMock(...args),
}));

// The SDK's DNS-pinned transport resolves with `node:dns`'s `lookup`. These
// tests never want a real resolver, so every lookup fails the way an unknown
// name does; the cases that need a hostname to classify inject a resolver
// into the guard instead.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (
    hostname: string,
    options: unknown,
    callback?: (error: Error | null) => void,
  ) => {
    const done = (typeof options === "function" ? options : callback) as (
      error: Error | null,
    ) => void;
    process.nextTick(() =>
      done(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: "ENOTFOUND",
        }),
      ),
    );
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;
const PUBLIC_ADDRESS = "93.184.216.34";

/**
 * `HOSTED_MODE` is read once, when `config.ts` is first imported, and every
 * guard on this path no-ops outside it — so each case loads a fresh module
 * graph with hosted mode on.
 */
async function loadHosted() {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  vi.resetModules();
  const [executor, guard] = await Promise.all([
    import("../conformance-run-executor.js"),
    import("../../utils/hosted-egress-guard.js"),
  ]);
  return { ...executor, ...guard };
}

/** Every report the run persisted, as the JSON it was stored as. */
function convexClient() {
  const stored: Array<{ suiteKind: string; json: string }> = [];
  const mutation = vi.fn(async (fn: string) => {
    if (fn === "conformanceRuns:startRun") return { runId: "run_1" };
    if (fn === "conformanceRuns:finalizeRun") {
      return { outcome: "failed", score: 0 };
    }
    return {};
  });
  const action = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "conformanceRuns:upsertReportAction") {
      stored.push({
        suiteKind: String(args.suiteKind),
        json: JSON.stringify(args.report),
      });
    }
    return undefined;
  });
  createConvexClientMock.mockReturnValue({ mutation, action });
  return { stored, mutation };
}

const servers: http.Server[] = [];

/**
 * A target on loopback that counts TCP CONNECTIONS, not requests: the run
 * addresses it over https and it speaks plain http, so an unguarded dial would
 * fail its handshake without ever reaching a request handler. The connection
 * is what the guard must prevent, so it is what gets counted.
 */
async function loopbackTarget(): Promise<{
  url: string;
  connections: () => number;
}> {
  let connections = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.on("connection", () => {
    connections += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/mcp`,
    connections: () => connections,
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
  vi.resetModules();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("a persisted run in hosted mode", () => {
  it("refuses a private target before any suite dials it, raw-socket probes included", async () => {
    // A bare `{ url }` is what the benchmark and GitHub-check workers used to
    // pass. For a loopback target the protocol suite's host-header checks go
    // straight to `node:http`, past any fetch, so only refusing the target up
    // front keeps them from connecting.
    const { executePersistedConformanceRun } = await loadHosted();
    const { stored, mutation } = convexClient();
    const target = await loopbackTarget();

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: { url: target.url },
      source: "benchmark",
      target: { kind: "server", serverId: "s1", serverUrl: target.url },
    });

    expect(target.connections()).toBe(0);
    expect(result.runId).toBe("run_1");
    expect(mutation.mock.calls.map(([fn]) => fn)).toContain(
      "conformanceRuns:finalizeRun",
    );
    expect(stored.map((entry) => entry.suiteKind).sort()).toEqual([
      "apps",
      "protocol",
      "tasks",
    ]);
    for (const { json } of stored) {
      expect(json).toMatch(
        /Server URL points at a private or internal address/,
      );
      expect(json).toContain('"skipReason":"could-not-run"');
    }
  }, 60_000);

  it("refuses a public target's redirect inward at the hop, and stores only the verdict", async () => {
    const {
      executePersistedConformanceRun,
      createGuardedFetch,
      setEgressHostResolverForTests,
    } = await loadHosted();
    const { stored } = convexClient();

    const resolver = async (hostname: string) =>
      hostname === "internal.example.test" ? ["10.1.2.3"] : [PUBLIC_ADDRESS];
    // The executor's own up-front judgement of the starting URL.
    setEgressHostResolverForTests(resolver);

    const INTERNAL_BODY_MARKER = "internal-service-response-body";
    const internalDialled: string[] = [];
    const network = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://public.example.test/")) {
        // Every request the suites make is answered with a method-preserving
        // redirect to a name that resolves privately.
        return new Response(null, {
          status: 307,
          headers: { Location: "https://internal.example.test/admin" },
        });
      }
      internalDialled.push(url);
      return Response.json({ marker: INTERNAL_BODY_MARKER });
    }) as unknown as typeof fetch;

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: {
        url: "https://public.example.test/mcp",
        // The caller's own guard, re-checking every hop with the same
        // resolver, so the chain runs without a network.
        baseFetch: createGuardedFetch({
          hosted: true,
          baseFetch: network,
          resolver,
        }),
      },
      source: "api",
      target: { kind: "server", serverId: "s1" },
    });

    expect(network).toHaveBeenCalled();
    expect(internalDialled).toEqual([]);
    expect(stored).toHaveLength(3);
    const all = stored.map((entry) => entry.json).join("\n");
    expect(all).toMatch(
      /hostname \\"internal\.example\.test\\" resolves to a private or internal address/,
    );
    // The guard keeps the resolved address on `cause`, for the logs. The
    // report serializer copies `cause`, so it must not survive the transport.
    expect(all).not.toMatch(/10\.1\.2\.3|resolved address/);
    expect(all).not.toContain(INTERNAL_BODY_MARKER);
  }, 60_000);

  it("never reaches for the global fetch when the caller passed a bare { url }", async () => {
    const { executePersistedConformanceRun, setEgressHostResolverForTests } =
      await loadHosted();
    const { stored } = convexClient();
    setEgressHostResolverForTests(async () => [PUBLIC_ADDRESS]);
    const globalFetch = vi.fn(async () => {
      throw new Error("the global fetch must not be dialled");
    });
    globalThis.fetch = globalFetch as unknown as typeof fetch;

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: { url: "https://public.example.test/mcp" },
      source: "github_app",
      target: { kind: "external", serverRef: "acme/widgets" },
    });

    // Every suite went through the executor's default transport — the pinned
    // one, whose lookup fails here — and none fell back to the global fetch.
    expect(globalFetch).not.toHaveBeenCalled();
    expect(stored).toHaveLength(3);
    const all = stored.map((entry) => entry.json).join("\n");
    expect(all).toContain(
      "The inspector could not establish a connection to this server.",
    );
    expect(all).not.toMatch(/ENOTFOUND|getaddrinfo|could not resolve/i);
  }, 60_000);
});

describe("guardPersistedConformanceTransport", () => {
  it("defaults the MCP and OAuth transports to the hosted guard", async () => {
    const { guardPersistedConformanceTransport, BlockedEgressTargetError } =
      await loadHosted();
    const guarded = guardPersistedConformanceTransport({
      server: { url: "https://connector.example.test/mcp" },
      oauth: {
        serverUrl: "https://connector.example.test/mcp",
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
        auth: { mode: "client_credentials", clientId: "c", clientSecret: "s" },
      } as never,
    });

    const transports = [
      (guarded.server as { baseFetch?: typeof fetch }).baseFetch,
      guarded.server.fetchFn,
      guarded.oauth?.fetchFn,
    ];
    for (const transport of transports) {
      expect(typeof transport).toBe("function");
      const refused = await transport!("https://127.0.0.1:6274/mcp").catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(BlockedEgressTargetError);
      expect((refused as Error).cause).toBeUndefined();
    }
  });

  it("keeps a transport the caller chose, for the probes as well as the client", async () => {
    const { guardPersistedConformanceTransport } = await loadHosted();
    const chosen = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const guarded = guardPersistedConformanceTransport({
      server: { url: "https://connector.example.test/mcp", baseFetch: chosen },
    });

    await (guarded.server as { baseFetch: typeof fetch }).baseFetch(
      "https://connector.example.test/mcp",
    );
    await guarded.server.fetchFn!("https://connector.example.test/mcp");
    expect(chosen).toHaveBeenCalledTimes(2);
    expect(guarded.oauth).toBeUndefined();
  });
});

describe("persistedConformanceTargetRefusal", () => {
  it("is a no-op outside hosted mode, where reaching localhost is the point", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "false";
    vi.resetModules();
    const { persistedConformanceTargetRefusal } = await import(
      "../conformance-run-executor.js"
    );
    await expect(
      persistedConformanceTargetRefusal({ url: "http://127.0.0.1:6274/mcp" }),
    ).resolves.toBeNull();
  });

  it("reports a resolver failure as the uniform message, not the resolver's text", async () => {
    const { persistedConformanceTargetRefusal, setEgressHostResolverForTests } =
      await loadHosted();
    setEgressHostResolverForTests(async () => {
      throw new Error("queryA ESERVFAIL flaky.example.test");
    });
    await expect(
      persistedConformanceTargetRefusal({
        url: "https://flaky.example.test/mcp",
      }),
    ).resolves.toBe(
      "The inspector could not establish a connection to this server.",
    );
  });
});
