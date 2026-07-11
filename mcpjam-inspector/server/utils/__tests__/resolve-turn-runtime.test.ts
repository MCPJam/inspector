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

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  modelDefinition: MCPJAM_MODEL,
  projectId: "proj-1",
  authHeader: "Bearer abc",
  chatboxId: "chatbox-1",
  accessVersion: 3,
  serverIds: ["server-a"],
  sourceType: "chatbox" as const,
  chatSessionId: "sess_1",
  attribution: { synthesisRunId: "run-xyz" },
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

  it("posts /stream/org/local-usage with the byte-identical body incl. synthesisRunId", async () => {
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
      sourceType: "chatbox",
      turnId: "turn-1",
      promptIndex: 2,
      chatboxId: "chatbox-1",
      accessVersion: 3,
      serverIds: ["server-a"],
      synthesisRunId: "run-xyz",
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
