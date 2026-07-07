import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startHarnessModelBroker,
  revokeHarnessModelBroker,
} from "../harness-model-broker";
import { buildBrokerDummyAuth } from "../registry";

// Inspector → Convex client for the E2B header-broker (start/revoke) + the dummy
// auth pointed at the proxy. The REAL lease is never handled by the inspector.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_URL === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = vi.fn(async (url: any, init: any) =>
    impl(String(url), init as RequestInit),
  ) as unknown as typeof fetch;
}

describe("buildBrokerDummyAuth", () => {
  it("claude-code → dummy anthropic auth pointed at the proxy (no real key)", () => {
    const auth = buildBrokerDummyAuth(
      "claude-code",
      "https://harness-model.mcpjam.com/web/harness/model-proxy/anthropic",
    );
    expect(auth.anthropic?.baseUrl).toBe(
      "https://harness-model.mcpjam.com/web/harness/model-proxy/anthropic",
    );
    expect(auth.anthropic?.authToken).toBeTruthy();
    expect(auth.anthropic?.apiKey).toBe("");
    expect(auth.gateway).toBeUndefined();
    expect(auth.openaiCompatible).toBeUndefined();
  });

  it("codex → dummy openaiCompatible auth pointed at the proxy", () => {
    const auth = buildBrokerDummyAuth(
      "codex",
      "https://harness-model.mcpjam.com/web/harness/model-proxy/openai/v1",
    );
    expect(auth.openaiCompatible?.baseUrl).toBe(
      "https://harness-model.mcpjam.com/web/harness/model-proxy/openai/v1",
    );
    expect(auth.openaiCompatible?.apiKey).toBeTruthy();
    expect(auth.anthropic).toBeUndefined();
    expect(auth.gateway).toBeUndefined();
  });
});

describe("startHarnessModelBroker", () => {
  it("POSTs the broker start payload and returns proxy info (never a lease)", async () => {
    let seenUrl = "";
    let seenBody: any = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        runId: "run_1",
        expiresAt: 123,
        protocol: "anthropic",
        proxyBaseUrl: "https://proxy/anthropic",
        delivery: "e2b-network-transform",
      });
    });

    const result = await startHarnessModelBroker({
      projectId: "p1",
      computerId: "c1",
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "raw-token",
    });

    expect(seenUrl).toBe(
      "https://convex.example.com/web/harness/model-broker/start",
    );
    expect(seenBody).toEqual({
      projectId: "p1",
      computerId: "c1",
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(result.ok).toBe(true);
    // No lease/jti/key anywhere in the result.
    expect(JSON.stringify(result)).not.toMatch(/lease|jti|apiKey/i);
    if (result.ok) {
      expect(result.proxyBaseUrl).toBe("https://proxy/anthropic");
      expect(result.runId).toBe("run_1");
    }
  });

  it("includes the executionScope in the body when present (guest/swarm path)", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        runId: "run_2",
        expiresAt: 456,
        protocol: "anthropic",
        proxyBaseUrl: "https://proxy/anthropic",
        delivery: "e2b-network-transform",
      });
    });
    const scope = {
      kind: "swarm" as const,
      swarmId: "cb_1",
      accessVersion: 3,
      projectId: "p1",
      workspaceId: "ws_1",
    };
    await startHarnessModelBroker({
      projectId: "p1",
      computerId: "c1",
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      runId: "run_2",
      executionScope: scope,
      bearer: "t",
    });
    expect(seenBody.executionScope).toEqual(scope);
    expect(seenBody.runId).toBe("run_2");
  });

  it("fails closed on a non-2xx response", async () => {
    mockFetch(() =>
      Response.json({ ok: false, error: "nope" }, { status: 403 }),
    );
    const result = await startHarnessModelBroker({
      projectId: "p1",
      computerId: "c1",
      harnessId: "codex",
      modelId: "openai/gpt-5",
      bearer: "t",
    });
    expect(result).toEqual({ ok: false, status: 403, error: "nope" });
  });

  it("fails closed when proxyBaseUrl is missing", async () => {
    mockFetch(() => Response.json({ ok: true, runId: "r" }));
    const result = await startHarnessModelBroker({
      projectId: "p1",
      computerId: "c1",
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "t",
    });
    expect(result.ok).toBe(false);
  });
});

describe("revokeHarnessModelBroker", () => {
  it("POSTs runId and returns ok on success", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({ ok: true, revoked: 1, networkCleared: true });
    });
    const result = await revokeHarnessModelBroker({
      runId: "run_1",
      computerId: "c1",
      projectId: "p1",
      bearer: "t",
    });
    expect(seenBody).toEqual({
      projectId: "p1",
      computerId: "c1",
      runId: "run_1",
    });
    expect(result).toEqual({ ok: true, revoked: 1, networkCleared: true });
  });

  it("is best-effort: a non-2xx returns { ok: false } without throwing", async () => {
    mockFetch(() => Response.json({ ok: false }, { status: 500 }));
    const result = await revokeHarnessModelBroker({ runId: "r", bearer: "t" });
    expect(result.ok).toBe(false);
  });
});
