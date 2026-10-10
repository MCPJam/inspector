import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startHarnessModelBroker,
  startLoopbackModelBroker,
  revokeHarnessModelBroker,
  reserveHarnessBox,
  renewHarnessBoxReservation,
  orgLeaseUpstreamFrom,
  ORG_BINDING_UNCONFIRMED,
  readHarnessLeaseRefusal,
} from "../harness-model-broker";
import { buildBrokerDummyAuth } from "../registry";
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";

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
    impl(String(url), init as RequestInit)
  ) as unknown as typeof fetch;
}

describe("buildBrokerDummyAuth", () => {
  // Since the @ai-sdk/harness 1.0.x stable line, HarnessAuth is the flat
  // ENVIRONMENT auth arm (an env-var map), not the canary line's structured
  // `{ anthropic }` / `{ openaiCompatible }` objects. `toEqual` pins the WHOLE
  // map: every extra key is a variable the adapter would key credential
  // forwarding off, so absence is as load-bearing as presence. (The `gateway`
  // raw-key variant is still gone since COMP-23 — no real credential here.)

  it("claude-code → dummy auth-token env pointed at the proxy (no real key)", () => {
    const auth = buildBrokerDummyAuth(
      "claude-code",
      "https://harness-model.mcpjam.com/web/harness/model-proxy/anthropic"
    );
    expect(auth).toEqual({
      ANTHROPIC_AUTH_TOKEN: "mcpjam-broker-dummy",
      ANTHROPIC_BASE_URL:
        "https://harness-model.mcpjam.com/web/harness/model-proxy/anthropic",
    });
    // ANTHROPIC_API_KEY must be ABSENT, not "": the adapter registers an
    // `x-api-key` egress rewrite for whichever credential variables are
    // PRESENT, and the CLI never sends that header on the auth-token path.
    expect("ANTHROPIC_API_KEY" in auth).toBe(false);
  });

  it("codex → dummy OpenAI-compatible env pointed at the proxy", () => {
    const auth = buildBrokerDummyAuth(
      "codex",
      "https://harness-model.mcpjam.com/web/harness/model-proxy/openai/v1"
    );
    expect(auth).toEqual({
      CODEX_API_KEY: "mcpjam-broker-dummy",
      OPENAI_BASE_URL:
        "https://harness-model.mcpjam.com/web/harness/model-proxy/openai/v1",
    });
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
      box: { kind: "computer", computerId: "c1", projectId: "p1" },
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "raw-token",
    });

    expect(seenUrl).toBe(
      "https://convex.example.com/web/harness/model-broker/start"
    );
    expect(seenBody).toEqual({
      projectId: "p1",
      computerId: "c1",
      harnessId: "claude-code",
      harnessRuntimeVersion: HARNESS_PINNED_VERSIONS["claude-code"],
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

  it("carries the reasoning effort when the turn has one, and omits it otherwise", async () => {
    const bodies: any[] = [];
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        ok: true,
        runId: "run_x",
        expiresAt: 1,
        protocol: "openai",
        proxyBaseUrl: "https://proxy/openai",
        delivery: "e2b-network-transform",
      });
    });
    const base = {
      box: { kind: "computer" as const, computerId: "c1", projectId: "p1" },
      harnessId: "codex" as const,
      modelId: "openai/gpt-5",
      bearer: "t",
    };
    await startHarnessModelBroker({ ...base, reasoningEffort: "high" });
    await startHarnessModelBroker(base);
    expect(bodies[0].reasoningEffort).toBe("high");
    expect("reasoningEffort" in bodies[1]).toBe(false);
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
      box: {
        kind: "computer",
        computerId: "c1",
        projectId: "p1",
        executionScope: scope,
      },
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      runId: "run_2",
      bearer: "t",
    });
    expect(seenBody.executionScope).toEqual(scope);
    expect(seenBody.runId).toBe("run_2");
  });

  it("sends sandboxRowId — and NO computerId or projectId — for an ephemeral box", async () => {
    // The backend requires exactly one box binding and re-derives the project
    // (and the org to bill) from the sandbox row's run, so naming a project
    // here would be an input it has to ignore. Pinned because sending both
    // bindings is a 400, and sending a projectId invites someone to start
    // trusting it.
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        runId: "run_e",
        expiresAt: 789,
        protocol: "anthropic",
        proxyBaseUrl: "https://proxy/anthropic",
        delivery: "e2b-network-transform",
      });
    });
    const result = await startHarnessModelBroker({
      box: { kind: "sandbox", sandboxRowId: "sbxrow_1" },
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      runId: "run_e",
      bearer: "t",
    });
    expect(seenBody).toEqual({
      sandboxRowId: "sbxrow_1",
      harnessId: "claude-code",
      harnessRuntimeVersion: HARNESS_PINNED_VERSIONS["claude-code"],
      modelId: "anthropic/claude-haiku-4.5",
      runId: "run_e",
    });
    expect(seenBody.computerId).toBeUndefined();
    expect(result.ok).toBe(true);
    // Still no credential in the response, same as the computer path.
    expect(JSON.stringify(result)).not.toMatch(/lease|jti|apiKey/i);
  });

  it("names the pinned harness runtime version the lease is for", async () => {
    // The backend's lease rule reads the same version-keyed evidence table as
    // the inspector's pre-flight, so it has to know which CLI version runs.
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        runId: "run_c",
        expiresAt: 1,
        protocol: "openai",
        proxyBaseUrl: "https://proxy/openai",
        delivery: "e2b-network-transform",
      });
    });
    await startHarnessModelBroker({
      box: { kind: "sandbox", sandboxRowId: "sbxrow_1" },
      harnessId: "codex",
      modelId: "openai/gpt-5.5",
      bearer: "t",
    });
    expect(seenBody.harnessRuntimeVersion).toBe("0.149.1");
    expect(seenBody.harnessRuntimeVersion).toBe(HARNESS_PINNED_VERSIONS.codex);
  });

  it("fails closed on a non-2xx response", async () => {
    mockFetch(() =>
      Response.json({ ok: false, error: "nope" }, { status: 403 })
    );
    const result = await startHarnessModelBroker({
      box: { kind: "computer", computerId: "c1", projectId: "p1" },
      harnessId: "codex",
      modelId: "openai/gpt-5",
      bearer: "t",
    });
    expect(result).toEqual({ ok: false, status: 403, error: "nope" });
  });

  it("fails closed when proxyBaseUrl is missing", async () => {
    mockFetch(() => Response.json({ ok: true, runId: "r" }));
    const result = await startHarnessModelBroker({
      box: { kind: "computer", computerId: "c1", projectId: "p1" },
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "t",
    });
    expect(result.ok).toBe(false);
  });
});

describe("startLoopbackModelBroker", () => {
  it("names the pinned harness runtime version on a loopback start", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({ ok: false }, { status: 503 });
    });
    await startLoopbackModelBroker({
      projectId: "p1",
      harnessId: "claude-code",
      modelId: "anthropic/claude-sonnet-4.5",
      machineId: "m1",
      keyId: "k1",
      bearer: "t",
    });
    expect(seenBody.delivery).toBe("inspector-loopback-gateway");
    expect(seenBody.harnessRuntimeVersion).toBe(
      HARNESS_PINNED_VERSIONS["claude-code"]
    );
  });

  it("carries the reasoning effort on a loopback start", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({ ok: false }, { status: 503 });
    });
    await startLoopbackModelBroker({
      projectId: "p1",
      harnessId: "codex",
      modelId: "openai/gpt-5",
      machineId: "m1",
      keyId: "k1",
      reasoningEffort: "medium",
      bearer: "t",
    });
    expect(seenBody.reasoningEffort).toBe("medium");
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

describe("harness box reservation", () => {
  const box = { kind: "sandbox" as const, sandboxRowId: "sbxrow_1" };

  it("fails closed when the reservation endpoint is missing", async () => {
    mockFetch(() => Response.json({ ok: false }, { status: 404 }));
    await expect(
      reserveHarnessBox({
        box,
        harnessId: "claude-code",
        modelId: "anthropic/claude-haiku-4.5",
        runId: "run_1",
        bearer: "t",
      })
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: "Couldn't reserve the computer (404)",
    });
  });

  it("reserve names the pinned runtime version for every baked harness", async () => {
    const bodies: any[] = [];
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, expiresAt: 5 });
    });
    await reserveHarnessBox({
      box,
      harnessId: "codex",
      modelId: "openai/gpt-5.5",
      runId: "run_1",
      bearer: "t",
    });
    await reserveHarnessBox({
      box,
      harnessId: "cursor",
      modelId: "cursor/auto",
      runId: "run_2",
      bearer: "t",
    });
    expect(bodies[0].harnessRuntimeVersion).toBe(HARNESS_PINNED_VERSIONS.codex);
    expect(bodies[1].harnessRuntimeVersion).toBe(
      HARNESS_PINNED_VERSIONS.cursor,
    );
  });

  it("renews the same box claim and returns the new expiry", async () => {
    let seenUrl = "";
    let seenBody: any = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return Response.json({ ok: true, expiresAt: 999 });
    });
    await expect(
      renewHarnessBoxReservation({
        box,
        harnessId: "claude-code",
        modelId: "anthropic/claude-haiku-4.5",
        runId: "run_1",
        bearer: "t",
      })
    ).resolves.toEqual({ ok: true, expiresAt: 999 });
    expect(seenUrl).toBe(
      "https://convex.example.com/web/harness/model-broker/reserve/renew"
    );
    expect(seenBody).toEqual({
      sandboxRowId: "sbxrow_1",
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      runId: "run_1",
    });
  });
});

describe("org-key leases", () => {
  const orgSelection = {
    source: "org" as const,
    modelId: "anthropic/claude-sonnet-4.5",
    connectionRef: { kind: "orgProvider" as const, id: "conn_1" },
  };
  const orgStartResponse = {
    ok: true,
    runId: "run_org",
    expiresAt: 123,
    protocol: "anthropic",
    proxyBaseUrl: "https://proxy/anthropic",
    delivery: "e2b-network-transform",
    credentialSource: "org",
    upstreamProfile: "anthropic-native",
    upstreamModelId: "claude-sonnet-4-5",
    credentialRevision: "0123456789abcdef",
  };

  it("carries the org selection and the prepared revision, and returns the confirmed binding", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json(orgStartResponse);
    });
    const result = await startHarnessModelBroker({
      box: { kind: "computer", computerId: "c1", projectId: "p1" },
      harnessId: "claude-code",
      modelId: orgSelection.modelId,
      modelSelection: orgSelection as never,
      expectedCredentialRevision: "0123456789abcdef",
      bearer: "t",
    });
    expect(seenBody.modelSelection).toEqual(orgSelection);
    expect(seenBody.expectedCredentialRevision).toBe("0123456789abcdef");
    expect(result).toMatchObject({
      ok: true,
      orgUpstream: {
        credentialSource: "org",
        profile: "anthropic-native",
        nativeModelId: "claude-sonnet-4-5",
        credentialRevision: "0123456789abcdef",
      },
    });
    // Still never a key or a lease in the result.
    expect(JSON.stringify(result)).not.toMatch(/lease|jti|apiKey/i);
  });

  it("a hosted start's body is unchanged: no selection, no revision", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ...orgStartResponse,
        credentialSource: undefined,
      });
    });
    const result = await startHarnessModelBroker({
      box: { kind: "computer", computerId: "c1", projectId: "p1" },
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      modelSelection: {
        source: "hosted",
        modelId: "anthropic/claude-haiku-4.5",
      } as never,
      expectedCredentialRevision: "ignored",
      bearer: "t",
    });
    expect(seenBody).toEqual({
      projectId: "p1",
      computerId: "c1",
      harnessId: "claude-code",
      harnessRuntimeVersion: HARNESS_PINNED_VERSIONS["claude-code"],
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(result.ok && "orgUpstream" in result).toBe(false);
  });

  it("revokes and fails when an org start comes back without confirming the binding (an older backend)", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch((url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/start")) {
        // Minted on MCPJam's key: no credentialSource in the echo.
        const {
          credentialSource,
          upstreamProfile,
          upstreamModelId,
          credentialRevision,
          ...hosted
        } = orgStartResponse;
        return Response.json(hosted);
      }
      return Response.json({ ok: true });
    });
    const result = await startHarnessModelBroker({
      box: { kind: "computer", computerId: "c1", projectId: "p1" },
      harnessId: "claude-code",
      modelId: orgSelection.modelId,
      modelSelection: orgSelection as never,
      bearer: "t",
    });
    expect(result).toMatchObject({ ok: false, code: ORG_BINDING_UNCONFIRMED });
    const revoke = calls.find((c) => c.url.endsWith("/revoke"));
    expect(revoke?.body).toMatchObject({ runId: "run_org" });
  });

  it("the loopback start carries the selection and applies the same guard", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch((url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/revoke")) return Response.json({ ok: true });
      return Response.json({
        ok: true,
        runId: "run_lb",
        expiresAt: 1,
        protocol: "openai",
        proxyBaseUrl: "https://proxy/openai",
        delivery: "inspector-loopback-gateway",
        lease: "lease-token",
      });
    });
    const result = await startLoopbackModelBroker({
      projectId: "p1",
      harnessId: "codex",
      modelId: "openai/gpt-5",
      modelSelection: {
        source: "org",
        modelId: "openai/gpt-5",
        connectionRef: { kind: "orgProvider", id: "conn_2" },
      } as never,
      machineId: "m1",
      keyId: "k1",
      bearer: "t",
    });
    expect(calls[0]!.body.modelSelection).toMatchObject({
      source: "org",
      connectionRef: { id: "conn_2" },
    });
    expect(result).toMatchObject({ ok: false, code: ORG_BINDING_UNCONFIRMED });
    expect(calls.some((c) => c.url.endsWith("/revoke"))).toBe(true);
  });

  it("reserve sends the org selection and returns the revision it prepared", async () => {
    let seenBody: any = {};
    mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        expiresAt: 5,
        credentialRevision: "fedcba9876543210",
      });
    });
    const result = await reserveHarnessBox({
      box: { kind: "sandbox", sandboxRowId: "sbxrow_1" },
      harnessId: "claude-code",
      modelId: orgSelection.modelId,
      modelSelection: orgSelection as never,
      runId: "run_1",
      bearer: "t",
    });
    expect(seenBody.modelSelection).toEqual(orgSelection);
    expect(result).toMatchObject({
      ok: true,
      credentialRevision: "fedcba9876543210",
    });
  });
});

describe("orgLeaseUpstreamFrom", () => {
  it("accepts only a complete org echo", () => {
    expect(
      orgLeaseUpstreamFrom({
        credentialSource: "org",
        upstreamProfile: "openai-native",
        upstreamModelId: "gpt-5",
        credentialRevision: "abc",
      }),
    ).toEqual({
      credentialSource: "org",
      profile: "openai-native",
      nativeModelId: "gpt-5",
      credentialRevision: "abc",
    });
    const complete = {
      credentialSource: "org",
      upstreamProfile: "anthropic-native",
      upstreamModelId: "claude-sonnet-4-5",
      credentialRevision: "a",
    };
    for (const partial of [
      null,
      {},
      { credentialSource: "platform" },
      { ...complete, upstreamProfile: "gateway" },
      { ...complete, credentialRevision: undefined },
      { ...complete, credentialRevision: "" },
      { ...complete, upstreamModelId: undefined },
      // A Gateway spelling is not a native id.
      { ...complete, upstreamModelId: "anthropic/claude-sonnet-4.5" },
    ]) {
      expect(orgLeaseUpstreamFrom(partial)).toBeNull();
    }
  });
});

describe("readHarnessLeaseRefusal", () => {
  it("POSTs the run id and returns the proxy's recorded refusal", async () => {
    let seenUrl = "";
    let seenBody: any = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        refusal: { reason: "byok_credential_rejected", at: 123 },
      });
    });
    await expect(
      readHarnessLeaseRefusal({ runId: "run_1", bearer: "t" }),
    ).resolves.toEqual({ reason: "byok_credential_rejected", at: 123 });
    expect(seenUrl).toBe(
      "https://convex.example.com/web/harness/model-broker/refusal",
    );
    expect(seenBody).toEqual({ runId: "run_1" });
  });

  it("is undefined when nothing was refused, the endpoint fails, or the network does", async () => {
    mockFetch(() => Response.json({ ok: true }));
    await expect(
      readHarnessLeaseRefusal({ runId: "r", bearer: "t" }),
    ).resolves.toBeUndefined();
    mockFetch(() => Response.json({ ok: false }, { status: 404 }));
    await expect(
      readHarnessLeaseRefusal({ runId: "r", bearer: "t" }),
    ).resolves.toBeUndefined();
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      readHarnessLeaseRefusal({ runId: "r", bearer: "t" }),
    ).resolves.toBeUndefined();
  });
});
