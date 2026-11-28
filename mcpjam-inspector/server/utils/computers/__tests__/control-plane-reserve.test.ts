import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureComputerReady, reserveComputer } from "../control-plane-client.js";
import type { ExecutionScope } from "../../execution-scope.js";

/**
 * Phase 3: reserveComputer sends the opaque executionScope when present (so the
 * backend re-resolves live access + applies per-swarm isolation/caps), else the
 * legacy { projectId } body. Backward-compatible: a pre-Phase-3 caller (no
 * executionScope) is byte-identical to before.
 */
describe("reserveComputer body (Phase 3 executionScope)", () => {
  const realFetch = global.fetch;
  let previousConvexHttpUrl: string | undefined;
  let bodies: unknown[];

  beforeEach(() => {
    previousConvexHttpUrl = process.env.CONVEX_HTTP_URL;
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    bodies = [];
    global.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ computerId: "c1", status: "ready", provider: "e2b" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (previousConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = previousConvexHttpUrl;
    }
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("sends { projectId } when no executionScope (legacy path)", async () => {
    await reserveComputer({ bearer: "t", projectId: "p1" });
    expect(bodies[0]).toEqual({ projectId: "p1" });
  });

  it("sends { executionScope } for a project scope (no leaked projectId)", async () => {
    const executionScope: ExecutionScope = { kind: "project", projectId: "p1" };
    await reserveComputer({ bearer: "t", projectId: "p1", executionScope });
    expect(bodies[0]).toEqual({ executionScope });
  });

  it("forwards the swarm executionScope verbatim", async () => {
    const executionScope: ExecutionScope = {
      kind: "swarm",
      swarmId: "cb1",
      accessVersion: 7,
      projectId: "p1",
      workspaceId: "ws1",
    };
    await reserveComputer({ bearer: "t", projectId: "p1", executionScope });
    expect(bodies[0]).toEqual({ executionScope });
  });
});

describe("ensureComputerReady", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("reads a renewing bearer before each reserve call while it waits", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
    const statuses = ["provisioning", "ready"];
    const sent: string[] = [];
    global.fetch = vi.fn(async (_url: unknown, init: { headers: unknown }) => {
      sent.push(JSON.stringify(init.headers));
      return new Response(
        JSON.stringify({ computerId: "c1", status: statuses.shift(), provider: "e2b" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const tokens = ["job-token-1", "job-token-2"];
    const ready = await ensureComputerReady({
      bearer: () => tokens.shift()!,
      projectId: "p1",
      pollIntervalMs: 0,
    });
    expect(ready.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Bearer job-token-1");
    expect(sent[1]).toContain("Bearer job-token-2");
  });
});
