/**
 * `resolveTurnRuntime` — the shared runtime adapter. These tests lock the
 * byte-parity contract the synthetic (and future swarm) paths depend on:
 * the three-way MCPJam / cloud-BYOK / local-BYOK runtime shape, the exact
 * hosted endpoint + extra body fields, the local model build, the approval
 * guard, and the `/stream/org/local-usage` writeback body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinition } from "@/shared/types";

const resolveSyntheticModelSourceMock = vi.fn();
const assertOrgModelAllowedMock = vi.fn();
const buildOrgModelFromResolvedConfigMock = vi.fn();

vi.mock("../org-model-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../org-model-config.js")
  >("../org-model-config.js");
  return {
    ...actual,
    resolveSyntheticModelSource: (...args: unknown[]) =>
      resolveSyntheticModelSourceMock(...args),
  };
});

vi.mock("@mcpjam/sdk/model-factory", async () => {
  const actual = await vi.importActual<
    typeof import("@mcpjam/sdk/model-factory")
  >("@mcpjam/sdk/model-factory");
  return {
    ...actual,
    assertOrgModelAllowed: (...args: unknown[]) =>
      assertOrgModelAllowedMock(...args),
    buildOrgModelFromResolvedConfig: (...args: unknown[]) =>
      buildOrgModelFromResolvedConfigMock(...args),
  };
});

import {
  resolveTurnRuntime,
  classifyTurnFailure,
} from "../resolve-turn-runtime.js";
import type { UnifiedTurnResult } from "../turn-execution.js";

const MCPJAM_MODEL: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku",
  provider: "anthropic",
};
const BYOK_MODEL: ModelDefinition = {
  id: "claude-3-5-sonnet-latest",
  name: "Claude",
  provider: "anthropic",
};
const LOCAL_MODEL: ModelDefinition = {
  id: "llama3",
  name: "Llama3 local",
  provider: "ollama",
};
/** The Cursor CLI host template's neutral sentinel — no provider serves it. */
const CURSOR_SENTINEL_MODEL: ModelDefinition = {
  id: "cursor/auto",
  name: "Cursor Auto",
  provider: "cursor",
};

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  modelDefinition: MCPJAM_MODEL,
  projectId: "proj-1",
  authHeader: "Bearer abc",
  scenarioId: "scenario-1",
  accessVersion: 3,
  serverIds: ["server-a"],
  sourceType: "scenario" as const,
  chatSessionId: "sess_1",
  attribution: { journeyRunId: "run-xyz" },
  ...overrides,
});

/** A successful direct-turn result the way `runUnifiedAssistantTurn` returns it. */
const successResult = (): UnifiedTurnResult =>
  ({
    messages: [],
    newMessages: [],
    assistantMessages: [],
    toolCalls: [],
    toolResults: [],
    usage: { totalTokens: 11 },
    finishReason: "stop",
    turnTrace: {
      turnId: "turn-1",
      promptIndex: 2,
      startedAt: 0,
      endedAt: 1,
      spans: [],
      usage: { totalTokens: 11 },
      finishReason: "stop",
    },
    aborted: false,
  }) as unknown as UnifiedTurnResult;

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  globalThis.fetch = fetchMock as never;
  resolveSyntheticModelSourceMock.mockReset();
  assertOrgModelAllowedMock.mockReset();
  buildOrgModelFromResolvedConfigMock.mockReset();
  buildOrgModelFromResolvedConfigMock.mockReturnValue({ localModel: true });
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("resolveTurnRuntime — runtime shape", () => {
  it("MCPJam → hosted /stream, no providerKey, no-op usage writeback", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const rt = await resolveTurnRuntime(baseArgs());

    expect(rt.modelSource).toBe("mcpjam");
    expect(rt.runtime).toEqual({ kind: "hosted", endpointPath: "/stream" });
    // Hosted writeback is a no-op (backend records usage server-side).
    await rt.finalizeUsage(successResult());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("MCPJam forwards caller extraBodyFields + harness when present", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });

    const rt = await resolveTurnRuntime(
      baseArgs({
        modelDefinition: MCPJAM_MODEL,
        extraBodyFields: { foo: "bar" },
        harness: "claude-code",
      }),
    );

    expect(rt.runtime).toEqual({
      kind: "hosted",
      endpointPath: "/stream",
      extraBodyFields: { foo: "bar" },
      harness: "claude-code",
    });
  });

  it("external account WITH a harness is refused here — this surface cannot deliver the credential", async () => {
    // The host's model id names no provider model, so there is no org provider
    // to resolve and no MCPJam credential to spend — and the resolver no longer
    // ships `providerKey: "cursor"` to `/stream/org`, which Convex answered
    // with `provider_not_configured: cursor`.
    //
    // But "not a provider question" is not the same as "runnable". An
    // external-account runtime authenticates with the customer's own vendor
    // credential, which `runHarnessTurn` takes ONLY from the caller's
    // materialized project secrets — and `runUnifiedAssistantTurn`, the facade
    // every caller of this resolver drives, has no `runtimeSecrets` seam at
    // all. Handing back a runnable "hosted + harness" runtime advertised a turn
    // that then died inside the harness telling the user to add a
    // `CURSOR_API_KEY` secret they may already have set. Refuse instead, with
    // the real reason, before the caller marks the turn as possibly-spent.
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "external-account",
    });

    await expect(
      resolveTurnRuntime(
        baseArgs({ modelDefinition: CURSOR_SENTINEL_MODEL, harness: "cursor" }),
      ),
    ).rejects.toThrow(/cursor\/auto[\s\S]*your own account/);
    // Not "add a secret" — the diagnosis names the surface, not the customer.
    await expect(
      resolveTurnRuntime(
        baseArgs({ modelDefinition: CURSOR_SENTINEL_MODEL, harness: "cursor" }),
      ),
    ).rejects.toThrow(/cannot deliver that credential/);
    // And no round-trip that could answer `provider_not_configured`.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("external account without a harness is refused, not routed to a provider", async () => {
    // A sentinel on a turn with no harness selected cannot run at all. Saying
    // so here — before the caller marks the turn as possibly-spent — is what
    // replaces `provider_not_configured: cursor`, which read as "go configure
    // a key" for a provider that has no keys.
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "external-account",
    });

    // The OTHER refusal sentence: this one is about the sentinel itself, not
    // about what this surface can deliver, so the two arms stay legible apart.
    await expect(
      resolveTurnRuntime(baseArgs({ modelDefinition: CURSOR_SENTINEL_MODEL })),
    ).rejects.toThrow(/cursor\/auto[\s\S]*not a model MCPJam can run/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cloud BYOK → hosted /stream/org with providerKey + serverIds (byte-parity body)", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "byok",
      orgRuntime: { runtimeLocation: "cloud", providerKey: "anthropic" },
    });

    const rt = await resolveTurnRuntime(
      baseArgs({ modelDefinition: BYOK_MODEL, extraBodyFields: { keep: 1 } }),
    );

    expect(rt.modelSource).toBe("byok");
    expect(rt.runtime).toEqual({
      kind: "hosted",
      endpointPath: "/stream/org",
      // Caller fields first, then the sibling contract fields.
      extraBodyFields: {
        keep: 1,
        providerKey: "anthropic",
        serverIds: ["server-a"],
      },
    });
    // Hosted → no local-usage writeback.
    await rt.finalizeUsage(successResult());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cloud BYOK omits serverIds when none are selected", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "byok",
      orgRuntime: { runtimeLocation: "cloud", providerKey: "openai" },
    });

    const rt = await resolveTurnRuntime(
      baseArgs({ modelDefinition: BYOK_MODEL, serverIds: [] }),
    );

    expect(rt.runtime).toEqual({
      kind: "hosted",
      endpointPath: "/stream/org",
      extraBodyFields: { providerKey: "openai" },
    });
  });

  it("local BYOK → direct runtime with the model built and no provider metadata", async () => {
    const provider = { providerKey: "openai" } as never;
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: { runtimeLocation: "local", provider },
    });

    const rt = await resolveTurnRuntime(baseArgs({ modelDefinition: LOCAL_MODEL }));

    expect(rt.modelSource).toBe("local_byok");
    expect(assertOrgModelAllowedMock).toHaveBeenCalledWith(provider, "llama3");
    expect(buildOrgModelFromResolvedConfigMock).toHaveBeenCalledWith(
      provider,
      "llama3",
    );
    expect(rt.runtime).toEqual({
      kind: "direct",
      llmModel: { localModel: true },
      modelId: "llama3",
    });
    // Byte-parity: no provider string is forwarded (spans carried none before).
    expect((rt.runtime as { provider?: string }).provider).toBeUndefined();
  });

  it("local BYOK + requireToolApproval=true with non-empty tools throws before building the model", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as never,
      },
    });

    await expect(
      resolveTurnRuntime(
        baseArgs({
          modelDefinition: LOCAL_MODEL,
          requireToolApproval: true,
          tools: { search: { description: "noop" } } as never,
        }),
      ),
    ).rejects.toThrow(/approval-required tool calls.*Disable tool approval/i);

    expect(buildOrgModelFromResolvedConfigMock).not.toHaveBeenCalled();
  });
});

describe("resolveTurnRuntime — local usage writeback (finalizeUsage)", () => {
  const localArgs = () =>
    baseArgs({
      modelDefinition: LOCAL_MODEL,
      // resolveSyntheticModelSource is mocked, so modelDefinition only feeds
      // the local model build (modelId "llama3").
    });

  beforeEach(() => {
    resolveSyntheticModelSourceMock.mockResolvedValue({
      source: "local_byok",
      orgRuntime: {
        runtimeLocation: "local",
        provider: { providerKey: "openai" } as never,
      },
    });
  });

  it("posts /stream/org/local-usage with the byte-identical body incl. journeyRunId", async () => {
    const rt = await resolveTurnRuntime(localArgs());

    await rt.finalizeUsage(successResult());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe("https://convex.test/stream/org/local-usage");
    expect(init.headers.Authorization).toBe("Bearer abc");
    expect(JSON.parse(init.body)).toEqual({
      projectId: "proj-1",
      providerKey: "openai",
      model: "llama3",
      usage: { totalTokens: 11 },
      finishReason: "stop",
      chatSessionId: "sess_1",
      sourceType: "scenario",
      turnId: "turn-1",
      promptIndex: 2,
      scenarioId: "scenario-1",
      accessVersion: 3,
      serverIds: ["server-a"],
      journeyRunId: "run-xyz",
    });
  });

  it("does NOT fire on an aborted result", async () => {
    const rt = await resolveTurnRuntime(localArgs());

    const aborted = { ...successResult(), aborted: true } as UnifiedTurnResult;
    await rt.finalizeUsage(aborted);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a writeback rejection (best-effort parity with the old fire-and-forget catch)", async () => {
    // Parity with the OLD `buildLocalOrgOnPersist`, where the writeback was
    // `postLocalUsage({...}).catch((err) => logger.warn(...))`: a
    // `/stream/org/local-usage` outage NEVER failed the turn. The new
    // `finalizeUsage` awaits the post, so a rejection must be caught here or
    // it would fail an otherwise-successful synthetic turn.
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const rt = await resolveTurnRuntime(localArgs());

    await expect(rt.finalizeUsage(successResult())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("classifyTurnFailure (exported single source of truth)", () => {
  it("folds rate-limit / spend / cap messages into rate_limited", () => {
    expect(classifyTurnFailure("Rate limit exceeded")).toBe("rate_limited");
    expect(classifyTurnFailure("ratelimit hit")).toBe("rate_limited");
    expect(classifyTurnFailure("daily spend cap reached")).toBe("rate_limited");
    expect(classifyTurnFailure("hard cap hit")).toBe("rate_limited");
  });

  it("folds org spend-cap phrasings (quota / budget) into rate_limited", () => {
    // An org spend-cap can surface as "quota"/"budget" wording; it must reach
    // rate_limited so the swarm fan-out's whole-run stop can fire.
    expect(classifyTurnFailure("Organization quota exceeded")).toBe(
      "rate_limited",
    );
    expect(classifyTurnFailure("monthly budget exhausted")).toBe(
      "rate_limited",
    );
  });

  it("folds a bare 429 / 'too many requests' into rate_limited", () => {
    // The local-BYOK path re-throws the provider's sentence with no code and
    // no HTTP status appended, so a throttled user key arrives as prose only.
    expect(classifyTurnFailure("429 Too Many Requests")).toBe("rate_limited");
    expect(classifyTurnFailure("Anthropic returned Too Many Requests")).toBe(
      "rate_limited",
    );
    // The wording a real throttle produces: the AI SDK retries three times and
    // wraps the last provider error in a `RetryError`.
    expect(
      classifyTurnFailure(
        "Failed after 3 attempts. Last error: Too Many Requests",
      ),
    ).toBe("rate_limited");
  });

  it("does NOT read a port or id that merely contains 429 as rate_limited", () => {
    expect(classifyTurnFailure("connect ECONNREFUSED 127.0.0.1:4291")).toBe(
      "failed",
    );
    expect(classifyTurnFailure("run 14290 aborted")).toBe("failed");
  });

  it("does NOT over-match 'capacity'/'recap'/'escape' as rate_limited", () => {
    // `cap` is word-anchored — a provider capacity error is a hard failure.
    expect(classifyTurnFailure("model capacity exceeded")).toBe("failed");
    expect(classifyTurnFailure("rate capacity exceeded")).toBe("failed");
    expect(classifyTurnFailure("here is a recap of the run")).toBe("failed");
    expect(classifyTurnFailure("attempting to escape")).toBe("failed");
  });

  it("maps everything else to failed", () => {
    expect(classifyTurnFailure("provider exploded")).toBe("failed");
    expect(classifyTurnFailure("")).toBe("failed");
  });
});

describe("resolveTurnRuntime — classifyFailure", () => {
  it("folds rate-limit / spend / cap messages into rate_limited, else failed", async () => {
    resolveSyntheticModelSourceMock.mockResolvedValue({ source: "mcpjam" });
    const rt = await resolveTurnRuntime(baseArgs());

    expect(rt.classifyFailure("Rate limit exceeded")).toBe("rate_limited");
    expect(rt.classifyFailure("daily spend cap reached")).toBe("rate_limited");
    expect(rt.classifyFailure("hard cap hit")).toBe("rate_limited");
    expect(rt.classifyFailure("provider exploded")).toBe("failed");
  });
});
