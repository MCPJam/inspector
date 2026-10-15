import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveOrgModelConfig = vi.hoisted(() => vi.fn());
vi.mock("../org-model-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org-model-config")>()),
  resolveOrgModelConfig,
}));

import {
  OWN_KEY_POLICY_RECHECK_MS,
  ownKeyTurnRefusal,
  withOwnKeyTurnPolicy,
  type OwnKeyTurn,
} from "../own-key-turn-policy";

const none = { provider: "none", model: "none" } as const;

function turn(overrides: Partial<OwnKeyTurn> = {}): OwnKeyTurn {
  return {
    projectId: "project-1",
    selection: undefined,
    provider: "ollama",
    hasRequestKey: true,
    auth: { authHeader: "Bearer user-token" },
    ...overrides,
  };
}

const strict = { aiKeyPolicy: { requireOrgKeys: true }, providers: [] };

// The window is timed with `performance.now()`, so fake it explicitly rather
// than relying on the Vitest version's default `toFake` list.
function useFakeClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
}

describe("ownKeyTurnRefusal", () => {
  beforeEach(() => {
    resolveOrgModelConfig.mockReset();
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("refuses a local selection while the organization requires its own keys", async () => {
    resolveOrgModelConfig.mockResolvedValue(strict);
    const refusal = await ownKeyTurnRefusal(
      turn({
        selection: {
          modelId: "llama3",
          source: "local",
          connectionRef: { kind: "localProvider", providerKey: "ollama" },
          fallback: none,
        },
      }),
    );
    expect(refusal).toMatchObject({
      status: 403,
      details: { code: "org_keys_required" },
    });
    expect(resolveOrgModelConfig).toHaveBeenCalledWith(
      { projectId: "project-1" },
      { authHeader: "Bearer user-token" },
    );
  });

  it("refuses a turn with no saved selection, or a legacy one, the same way", async () => {
    resolveOrgModelConfig.mockResolvedValue(strict);
    for (const selection of [
      undefined,
      { source: "legacy", modelId: "llama3" } as const,
    ]) {
      expect(await ownKeyTurnRefusal(turn({ selection }))).toMatchObject({
        status: 403,
        details: { code: "org_keys_required" },
      });
    }
  });

  it("lets the turn run when the organization does not require its own keys", async () => {
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    expect(await ownKeyTurnRefusal(turn())).toBeUndefined();
  });

  it("reads nothing for a turn with no project or no backend", async () => {
    expect(
      await ownKeyTurnRefusal(turn({ projectId: undefined })),
    ).toBeUndefined();
    vi.stubEnv("CONVEX_HTTP_URL", "");
    expect(await ownKeyTurnRefusal(turn())).toBeUndefined();
    expect(resolveOrgModelConfig).not.toHaveBeenCalled();
  });

  it("refuses the turn, retryably, when the policy can't be read", async () => {
    resolveOrgModelConfig.mockRejectedValue(new Error("boom"));
    expect(await ownKeyTurnRefusal(turn())).toMatchObject({
      status: 503,
      details: { code: "ai_key_policy_unavailable", isRetryable: true },
    });
  });
  it.each(["doGenerate", "doStream"] as const)(
    "rechecks policy before a later %s attempt",
    async (method) => {
      resolveOrgModelConfig.mockResolvedValue({
        aiKeyPolicy: { requireOrgKeys: false },
        providers: [],
      });
      const dispatch = vi.fn(() =>
        resolveOrgModelConfig.mockResolvedValue(strict),
      );
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          dispatch();
          return {
            content: [],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 0,
                noCache: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
            warnings: [],
          };
        },
        doStream: async () => {
          dispatch();
          return { stream: new ReadableStream() };
        },
      });
      useFakeClock();
      const guarded = withOwnKeyTurnPolicy(model, turn());
      await guarded[method]({ prompt: [] });
      vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS);
      await expect(guarded[method]({ prompt: [] })).rejects.toMatchObject({
        status: 403,
        details: { code: "org_keys_required" },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    },
  );

  it("reads the policy once for a burst of tool-loop steps", async () => {
    // The bearer-only route allows 60 reads a minute per user, and a 3-model
    // turn reading before every step spent it and refused itself as
    // `ai_key_policy_unavailable`.
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn());
    for (let step = 0; step < 20; step += 1) {
      await guarded.doStream({ prompt: [] });
    }
    expect(resolveOrgModelConfig).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the window even when the wall clock steps back", async () => {
    useFakeClock();
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn());
    await guarded.doStream({ prompt: [] });
    resolveOrgModelConfig.mockResolvedValue(strict);
    vi.setSystemTime(Date.now() - 60 * 60_000);
    vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS);
    await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
      status: 403,
      details: { code: "org_keys_required" },
    });
  });

  it("makes parallel requests wait on one read", async () => {
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn());
    await Promise.all(
      Array.from({ length: 10 }, () => guarded.doStream({ prompt: [] })),
    );
    expect(resolveOrgModelConfig).toHaveBeenCalledTimes(1);
  });

  it("treats an allowedAt from another timebase as stale", async () => {
    resolveOrgModelConfig.mockResolvedValue(strict);
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn(), {
      allowedAt: Date.now(),
    });
    await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
      status: 403,
      details: { code: "org_keys_required" },
    });
  });

  it("fails every waiter of a failed read, then reads again", async () => {
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn());
    resolveOrgModelConfig.mockRejectedValueOnce(new Error("network down"));
    const results = await Promise.allSettled([
      guarded.doStream({ prompt: [] }),
      guarded.doStream({ prompt: [] }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await guarded.doStream({ prompt: [] });
    expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
  });

  it("trusts the route's own check while it is fresh", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn(), {
      allowedAt: performance.now(),
    });
    await guarded.doStream({ prompt: [] });
    expect(resolveOrgModelConfig).not.toHaveBeenCalled();
  });

  it("re-reads before the first request when the route's check is already stale", async () => {
    resolveOrgModelConfig.mockResolvedValue(strict);
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn(), {
      allowedAt: performance.now() - OWN_KEY_POLICY_RECHECK_MS,
    });
    await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
      status: 403,
      details: { code: "org_keys_required" },
    });
  });

  it("dates a slow read from when it started, not when it answered", async () => {
    useFakeClock();
    const allow = { aiKeyPolicy: { requireOrgKeys: false }, providers: [] };
    resolveOrgModelConfig.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(allow), 14_000)),
    );
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn());
    const first = guarded.doStream({ prompt: [] });
    await vi.advanceTimersByTimeAsync(14_000);
    await first;

    resolveOrgModelConfig.mockResolvedValue(strict);
    vi.advanceTimersByTime(1_000);
    await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
      status: 403,
      details: { code: "org_keys_required" },
    });
    expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
  });

  it("does not trust a read that refused the turn", async () => {
    resolveOrgModelConfig.mockRejectedValueOnce(new Error("429"));
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const guarded = withOwnKeyTurnPolicy(model, turn());
    await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
      status: 503,
      details: { code: "ai_key_policy_unavailable" },
    });
    await guarded.doStream({ prompt: [] });
    expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
  });
});
