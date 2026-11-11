import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveOrgModelConfig = vi.hoisted(() => vi.fn());
vi.mock("../org-model-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org-model-config")>()),
  resolveOrgModelConfig,
}));

import {
  OWN_KEY_POLICY_RECHECK_MS,
  ownKeyTurnCheck,
  ownKeyTurnRefusal,
  resetOwnKeyPolicyCacheForTests,
  withOwnKeyTurnPolicy,
  type OwnKeyTurn,
} from "../own-key-turn-policy";
import { withGithubCredentialPolicy } from "../../services/github-checks/credential-policy";

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
    resetOwnKeyPolicyCacheForTests();
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
  describe("shared across turns of one scope", () => {
    const allow = { aiKeyPolicy: { requireOrgKeys: false }, providers: [] };
    const streaming = () =>
      new MockLanguageModelV3({
        doStream: async () => ({ stream: new ReadableStream() }),
      });

    it("shares one read between turns and their pre-flights, then one refresh after the window", async () => {
      // 18 turns checking every 15 s on their own used up the user's 60
      // reads a minute in under 4 minutes.
      useFakeClock();
      resolveOrgModelConfig.mockResolvedValue(allow);
      const turns = Array.from({ length: 18 }, () => ({
        model: withOwnKeyTurnPolicy(streaming(), turn()),
      }));
      await Promise.all(turns.map(() => ownKeyTurnRefusal(turn())));
      await Promise.all(
        turns.map(({ model }) => model.doStream({ prompt: [] })),
      );
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS);
      await Promise.all(
        turns.map(({ model }) => model.doStream({ prompt: [] })),
      );
      await ownKeyTurnRefusal(turn());
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });

    it("does not renew the window on hits", async () => {
      useFakeClock();
      resolveOrgModelConfig.mockResolvedValue(allow);
      await ownKeyTurnRefusal(turn());
      vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS - 1);
      await ownKeyTurnRefusal(turn());
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await ownKeyTurnRefusal(turn());
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["another user", { auth: { authHeader: "Bearer other-user" } }],
      ["another project", { projectId: "project-2" }],
      [
        "another guest scenario",
        {
          auth: {
            authHeader: "Bearer user-token",
            scenarioId: "scn-2",
            accessVersion: 1,
          },
        },
      ],
      [
        "another access version",
        {
          auth: {
            authHeader: "Bearer user-token",
            scenarioId: "scn-1",
            accessVersion: 2,
          },
        },
      ],
      [
        "other servers",
        { auth: { authHeader: "Bearer user-token", serverIds: ["srv-9"] } },
      ],
    ] as const)("never lends an allow to %s", async (_name, other) => {
      resolveOrgModelConfig.mockResolvedValueOnce(allow);
      if ("auth" in other && "scenarioId" in other.auth) {
        // Same scenario at access version 1, so only the field under test differs.
        await ownKeyTurnRefusal(
          turn({
            auth: {
              authHeader: "Bearer user-token",
              scenarioId: "scn-1",
              accessVersion: 1,
            },
          }),
        );
      } else {
        await ownKeyTurnRefusal(turn());
      }

      resolveOrgModelConfig.mockResolvedValueOnce(strict);
      expect(
        await ownKeyTurnRefusal(turn(other as Partial<OwnKeyTurn>)),
      ).toMatchObject({ status: 403, details: { code: "org_keys_required" } });
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });

    it("never lends an allow to another backend", async () => {
      resolveOrgModelConfig.mockResolvedValueOnce(allow);
      await ownKeyTurnRefusal(turn());
      vi.stubEnv("CONVEX_HTTP_URL", "https://other-backend.test");
      resolveOrgModelConfig.mockResolvedValueOnce(strict);
      expect(await ownKeyTurnRefusal(turn())).toMatchObject({ status: 403 });
    });

    it("a failed or refusing refresh never dispatches and leaves no trusted allow", async () => {
      useFakeClock();
      const dispatch = vi.fn();
      const model = new MockLanguageModelV3({
        doStream: async () => {
          dispatch();
          return { stream: new ReadableStream() };
        },
      });
      resolveOrgModelConfig.mockResolvedValueOnce(allow);
      const guarded = withOwnKeyTurnPolicy(model, turn());
      await guarded.doStream({ prompt: [] });
      expect(dispatch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS);
      resolveOrgModelConfig.mockRejectedValueOnce(new Error("429"));
      await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
        status: 503,
        details: { code: "ai_key_policy_unavailable" },
      });
      // Another turn of the same scope gets no allow out of that failure.
      resolveOrgModelConfig.mockResolvedValueOnce(strict);
      expect(await ownKeyTurnRefusal(turn())).toMatchObject({ status: 403 });
      resolveOrgModelConfig.mockResolvedValueOnce(strict);
      await expect(guarded.doStream({ prompt: [] })).rejects.toMatchObject({
        status: 403,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(4);
    });

    it("enforces a strict policy on every turn's first request after the window", async () => {
      useFakeClock();
      resolveOrgModelConfig.mockResolvedValue(allow);
      const models = [
        withOwnKeyTurnPolicy(streaming(), turn()),
        withOwnKeyTurnPolicy(streaming(), turn()),
      ];
      await Promise.all(models.map((model) => model.doStream({ prompt: [] })));

      resolveOrgModelConfig.mockResolvedValue(strict);
      vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS);
      const results = await Promise.allSettled(
        models.map((model) => model.doStream({ prompt: [] })),
      );
      expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });

    it("keeps reads unshared inside a GitHub-scoped execution", async () => {
      resolveOrgModelConfig.mockResolvedValue(allow);
      await withGithubCredentialPolicy(
        {
          policy: "suite_credentials",
          allowedBuiltInToolIds: [],
          checkAccess: async () => {},
        },
        async () => {
          await ownKeyTurnRefusal(turn());
          await ownKeyTurnRefusal(turn());
        },
      );
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });

    it("dates a turn wrapped after a shared answer from that answer's read", async () => {
      // The chat route's shape: a pre-flight check, then the model wrapped
      // with what it returned. A pre-flight answered from another turn's read
      // must not restart the window, or a revocation would hold for ~30 s.
      useFakeClock();
      resolveOrgModelConfig.mockResolvedValueOnce(allow);
      await ownKeyTurnRefusal(turn());

      // Revoked, then a new turn arrives just inside the shared window.
      resolveOrgModelConfig.mockResolvedValue(strict);
      vi.advanceTimersByTime(OWN_KEY_POLICY_RECHECK_MS - 100);
      const check = await ownKeyTurnCheck(turn());
      expect(check.refusal).toBeUndefined();
      const model = withOwnKeyTurnPolicy(streaming(), turn(), {
        allowedAt: check.readAt,
      });

      vi.advanceTimersByTime(100);
      await expect(model.doStream({ prompt: [] })).rejects.toMatchObject({
        status: 403,
        details: { code: "org_keys_required" },
      });
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });

    it("fails every caller of a shared read that fails, then reads again", async () => {
      let fail!: (error: Error) => void;
      resolveOrgModelConfig.mockImplementationOnce(
        () => new Promise((_, reject) => (fail = reject)),
      );
      const first = ownKeyTurnRefusal(turn());
      const second = ownKeyTurnRefusal(turn());
      fail(new Error("network down"));
      for (const refusal of await Promise.all([first, second])) {
        expect(refusal).toMatchObject({
          status: 503,
          details: { code: "ai_key_policy_unavailable" },
        });
      }
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(1);

      resolveOrgModelConfig.mockResolvedValueOnce(allow);
      expect(await ownKeyTurnRefusal(turn())).toBeUndefined();
      expect(resolveOrgModelConfig).toHaveBeenCalledTimes(2);
    });
  });
});
