import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
const preparedToolsOverride = vi.hoisted(() => ({
  current: undefined as Record<string, any> | undefined,
}));
const createLlmModelMock = vi.hoisted(() =>
  vi.fn(
    (
      _modelDefinition?: unknown,
      _apiKey?: unknown,
      _baseUrls?: unknown,
      _customProviders?: unknown,
    ) => ({
      id: "mock-model",
    }),
  ),
);

vi.mock("ai", async () => {
  // Keep the real exports (`createUIMessageStream`,
  // `createUIMessageStreamResponse`, `parseJsonEventStream`, `pruneMessages`,
  // etc.) — the engine that `runIterationViaBackend` now drives needs them.
  // Only override `generateText` / `streamText` so the local-AI-SDK and
  // stream-AI-SDK paths can be controlled by these tests.
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    finalizePassedForEval: ({ matchPassed }: { matchPassed: boolean }) =>
      matchPassed,
  };
});

vi.mock("../../../utils/chat-helpers", async () => {
  // PR 3 of the engine consolidation: `runIterationViaBackend` now drives
  // `runChatEngineLoop`, which imports `scrubUnavailableToolHistoryForBackend`
  // / `scrubMcpAppsToolResultsForBackend` / `scrubChatGPTAppsToolResultsForBackend`
  // from this module. Returning only `createLlmModel` here would make those
  // imports `undefined`; the engine's `try/catch` then silently swallows the
  // resulting `TypeError`, runs to a `runSucceeded:false` finish, and the
  // test never sees the fetch we expect. Keep the real exports and override
  // only `createLlmModel` so the local-AI-SDK paths can be inspected.
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-helpers")
  >("../../../utils/chat-helpers");
  return {
    ...actual,
    createLlmModel: (
      modelDefinition: unknown,
      apiKey: unknown,
      baseUrls?: unknown,
      customProviders?: unknown,
    ) => createLlmModelMock(modelDefinition, apiKey, baseUrls, customProviders),
  };
});

// Stub the chat-side tool/system/temperature pipeline. The real implementation
// in `chat-v2-orchestration` pulls in `getSkillToolsAndPrompt`, which touches
// the filesystem outside HOSTED_MODE; the eval test environment doesn't need
// that. Return a minimal `PrepareChatV2Result` shape — the actual tool set
// stays empty (matching `mcpClientManager.getToolsForAiSdk` → `{}`), and the
// engine swap only depends on the named output fields.
// PR 3 of the engine consolidation: `runIterationViaBackend` now drives
// `runChatEngineLoop`, which imports `serializeToolsForConvex` for tool
// serialization and uses `http-tool-calls` for local tool execution. Mirror
// the mocks `assistant-turn.test.ts` uses for the same engine — keep these
// minimal so the engine path can reach its `fetch` to Convex without
// blowing up on test-mode-incompatible dependencies (zod schema conversion
// in tool serialization, etc.).
vi.mock("../../../utils/mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: vi.fn(async (options: any) => ({
    allTools: preparedToolsOverride.current ?? {},
    enhancedSystemPrompt: options?.systemPrompt ?? "",
    resolvedTemperature: options?.temperature,
    scrubMessages: (msgs: unknown[]) => msgs,
    progressivePlan: { enabled: false },
    discoveryState: {
      loadedToolIds: new Set<string>(),
      catalogVersion: 0,
    },
  })),
}));

const executeStepsMock = vi.hoisted(() => vi.fn());
vi.mock("../step-executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../step-executor")>()),
  executeSteps: (...args: unknown[]) => executeStepsMock(...args),
}));
const assistantTurnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/assistant-turn.js", () => ({
  runAssistantTurn: (...args: unknown[]) => assistantTurnMock(...args),
}));
import { runEvalSuiteWithAiSdk } from "../../evals-runner.js";

import {
  EXECUTION_BUDGET_DEFAULTS,
  resolveExecutionBudgetsForSurface,
  type ExecutionBudgetResolution,
} from "@mcpjam/sdk/contract";
import { defaultEvalExecutionBudgets } from "../../evals-runner.js";
import { EVAL_SANDBOX_CAPACITY_POLICY } from "../../../utils/run-supervisor/capacity-retry.js";
import { PLAYGROUND_CAPACITY_POLICY } from "../../../utils/run-supervisor/capacity-retry.js";
import { provisionEvalSandbox } from "../../../utils/computers/control-plane-client.js";

/**
 * The eval runner's end of the execution-budget contract.
 *
 * `runIterationUnderBudget` — the clock itself — is pinned in
 * `evals-runner.test.ts`. What is pinned HERE is everything around it: that
 * the runner's idea of a default is the contract's idea of a default, that the
 * sandbox path waits on a queue instead of failing the iteration on it, and
 * that the eval policy is deliberately not the Playground's.
 */

/** The platform-default eval resolution, unwrapped. Never a violation. */
function resolvedEvalDefaults() {
  const resolution: ExecutionBudgetResolution =
    resolveExecutionBudgetsForSurface({ surface: "evals" });
  if (!resolution.ok) {
    throw new Error(
      `the platform defaults must resolve: ${JSON.stringify(resolution.violations)}`,
    );
  }
  return resolution.resolved;
}

describe("defaultEvalExecutionBudgets", () => {
  it("is the contract's resolved defaults, not a second copy of the numbers", () => {
    // The runner uses this whenever a run launched before the backend froze
    // budgets into its snapshot — which today is every run. If it drifted from
    // the contract, the ceiling checks, the settings UI and the actual clocks
    // would each be enforcing a different set of numbers.
    expect(defaultEvalExecutionBudgets()).toEqual(resolvedEvalDefaults());
  });

  it("reports every field as coming from the default rung", () => {
    // Provenance matters for the settings surface: a field nobody authored has
    // to render as inherited, not as a choice someone made.
    const { sources } = resolvedEvalDefaults();
    for (const [field, source] of Object.entries(sources)) {
      expect(source, `${field} should be defaulted`).toBe("default");
    }
  });

  it("uses the eval unit clock, never the swarm one", () => {
    // `unitTimeoutMs` is the RESOLVED spelling of two different authored
    // fields — `iterationTimeoutMs` here, `sessionTimeoutMs` for swarms — and
    // the two surfaces do not share a number.
    const budgets = defaultEvalExecutionBudgets();
    expect(budgets.unitTimeoutMs).toBe(
      EXECUTION_BUDGET_DEFAULTS.evals.unitTimeoutMs,
    );
    expect(budgets.unitTimeoutMs).not.toBe(
      EXECUTION_BUDGET_DEFAULTS.swarms.unitTimeoutMs,
    );
  });

  it("leaves room for several turns inside one iteration", () => {
    // Not arithmetic for its own sake: a turn budget at or above the iteration
    // budget makes the iteration clock unreachable, and every timeout would be
    // attributed to the wrong layer.
    const budgets = defaultEvalExecutionBudgets();
    expect(budgets.turnTimeoutMs).toBeLessThan(budgets.unitTimeoutMs);
    expect(budgets.unitTimeoutMs).toBeLessThan(budgets.runTimeoutMs);
  });
});

describe("EVAL_SANDBOX_CAPACITY_POLICY", () => {
  it("fits inside one iteration's default budget", () => {
    // This wait is spent INSIDE the iteration clock. A capacity ceiling at or
    // above it would let a queue consume the whole iteration and leave nothing
    // for the work it was queued for.
    expect(EVAL_SANDBOX_CAPACITY_POLICY.totalBudgetMs).toBeLessThan(
      defaultEvalExecutionBudgets().unitTimeoutMs,
    );
  });

  it("jitters, unlike the Playground policy", () => {
    // A suite launches its iterations together. Without jitter a full pool is
    // re-polled by all of them on the same tick — the thundering herd one
    // waiting Playground user cannot produce.
    expect(EVAL_SANDBOX_CAPACITY_POLICY.jitter).toBeTypeOf("function");
    expect(PLAYGROUND_CAPACITY_POLICY).not.toHaveProperty("jitter");
  });

  it("caps attempts, and waits less than the Playground does", () => {
    expect(EVAL_SANDBOX_CAPACITY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(EVAL_SANDBOX_CAPACITY_POLICY.totalBudgetMs).toBeLessThan(
      PLAYGROUND_CAPACITY_POLICY.totalBudgetMs,
    );
  });
});

describe("provisionEvalSandbox — capacity", () => {
  const realFetch = global.fetch;
  let previousConvexHttpUrl: string | undefined;
  let requests: number;
  let respond: () => Response;

  beforeEach(() => {
    previousConvexHttpUrl = process.env.CONVEX_HTTP_URL;
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    requests = 0;
    respond = () => new Response("{}", { status: 200 });
    global.fetch = vi.fn(async () => {
      requests += 1;
      return respond();
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

  const args = { bearer: "token", runId: "r1", iterationId: "i1" };

  it("returns a successful provision on the first attempt", async () => {
    respond = () =>
      new Response(JSON.stringify({ sandboxId: "s1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(provisionEvalSandbox(args)).resolves.toMatchObject({
      ok: true,
    });
    expect(requests).toBe(1);
  });

  it("hands back a non-capacity refusal immediately, without retrying", async () => {
    // A 409 is an ANSWER — no image pinned, attempt not running. Waiting on it
    // buys nothing and spends the iteration's clock.
    respond = () =>
      new Response(JSON.stringify({ error: "no image", code: "no_image" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    await expect(provisionEvalSandbox(args)).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(requests).toBe(1);
  });

  it("waits out a 503 at_capacity and succeeds on the retry", async () => {
    // The whole point of the loop: a full pool is a QUEUE, not a verdict.
    // Before this, a suite that happened to launch while the pool was
    // saturated recorded genuine failures, and a capacity blip read as a
    // quality regression on the run's chart.
    //
    // Fake timers because the real first wait is 15 seconds; the assertion is
    // that the SECOND attempt happens at all, and only after a wait.
    vi.useFakeTimers();
    try {
      respond = () =>
        requests === 1
          ? new Response(
              JSON.stringify({ error: "full", code: "at_capacity" }),
              {
                status: 503,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response(JSON.stringify({ sandboxId: "s1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });

      const pending = provisionEvalSandbox(args);
      // Let the first attempt settle, then confirm the loop is WAITING rather
      // than having already given up or already re-fired.
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1);

      await vi.advanceTimersByTimeAsync(
        EVAL_SANDBOX_CAPACITY_POLICY.maxDelayMs,
      );
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up in real time when a 503 outlives the budget, keeping the control plane's own words", async () => {
    // The whole point of the retry: a full pool is a QUEUE, not a verdict.
    // Before this, a suite that happened to launch while the pool was
    // saturated recorded genuine failures, and a capacity blip read as a
    // quality regression on the run's chart.
    //
    // Asserted through a budget too small for the first WAIT to fit, so the
    // loop reaches its terminal in real time rather than the test waiting out
    // a real backoff. A second is the right size: far under the 7.5s floor on
    // that first wait, and far over what one mocked attempt costs. A budget of
    // a millisecond also stops in real time, but it can expire before the
    // first attempt is even made on a loaded runner — and then there is no
    // control-plane result to relay, so the assertion below fails on a
    // fallback this test is not about.
    respond = () =>
      new Response(
        JSON.stringify({
          error: "full",
          code: "at_capacity",
          resource: "desktops",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    const result = await provisionEvalSandbox({ ...args, timeoutMs: 1_000 });
    // The control plane's OWN refusal is relayed — its status, its code, its
    // `resource` — rather than a message this layer invented about a failure
    // it only passed along.
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: "at_capacity",
      resource: "desktops",
    });
    // It really did try, and really did stop — and with this budget the count
    // is EXACT, not a range: one attempt fits, and the 7.5s floor on the wait
    // that would precede a second one does not. A range here would pass just
    // as happily if the budget stopped being enforced before the retry.
    expect(requests).toBe(1);
  });
});

describe.each(["local", "hosted"] as const)(
  "%s iteration lifecycle",
  (runner) => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.clearAllMocks();
    });

    async function startRun(
      options: {
        killSwitch?: boolean;
        runDeadline?: boolean;
        turnTimeout?: boolean;
        capacity?: boolean;
        capacityAbort?: boolean;
      } = {},
    ) {
      vi.useFakeTimers();
      vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
      vi.stubEnv(
        "MCPJAM_EVAL_ISOLATED_ITERATION_TIMEOUT",
        options.killSwitch ? "0" : "1",
      );
      const model = runner === "local" ? "gpt-4-turbo" : "gpt-5-mini";
      const snapshot = {
        title: "Case",
        query: "Hello",
        model,
        provider: "openai",
      };
      const rows = Array.from({ length: 3 }, (_, index) => ({
        _id: `iter-${index + 1}`,
        testCaseId: "case-1",
        iterationNumber: index + 1,
        testCaseSnapshot: snapshot,
        status: "pending",
        result: "pending",
      })) as Array<Record<string, any>>;
      const recorder = {
        startIteration: vi.fn(
          async ({ iterationNumber }) => rows[iterationNumber - 1]._id,
        ),
        beginExecutionAttempt: vi.fn(async () => {}),
        finishIteration: vi.fn(async (args) =>
          Object.assign(
            rows.find((row) => row._id === args.iterationId)!,
            args,
          ),
        ),
        finalize: vi.fn(async () => {}),
      };
      const convexClient = {
        query: vi.fn(async (name) =>
          name === "testSuites:getTestSuiteRunDetails"
            ? { iterations: rows }
            : { status: "running" },
        ),
        mutation: vi.fn(async () => ({})),
        action: vi.fn(async (name, args) => {
          if (name === "testSuites:updateTestIteration")
            Object.assign(
              rows.find((row) => row._id === args.iterationId)!,
              args,
            );
        }),
      };
      const manager = {
        getToolsForAiSdk: vi.fn(async () => ({})),
        listTools: vi.fn(async () => ({ tools: [] })),
        getAllToolAnnotations: vi.fn(() => ({})),
        hasCachedToolAnnotations: vi.fn(() => true),
        getConnectionStatus: vi.fn(() => "connected"),
        listServers: vi.fn(() => ["srv-1"]),
        getAllToolsMetadata: vi.fn(() => ({})),
        executeTool: vi.fn(),
      };
      let calls = 0;
      executeStepsMock.mockImplementation(async ({ isAborted }) => {
        calls += 1;
        if (calls === 2) {
          // The engine cooperates by returning cancellation, not by throwing.
          await new Promise<void>((resolve) => {
            const tick = setInterval(() => {
              if (isAborted()) {
                clearInterval(tick);
                resolve();
              }
            }, 1);
          });
          return { cancelled: true };
        }
        return {};
      });
      if (options.turnTimeout) {
        const actual =
          await vi.importActual<typeof import("../step-executor")>(
            "../step-executor",
          );
        executeStepsMock.mockImplementation(actual.executeSteps);
        const waitForAbort = (signal: AbortSignal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        streamTextMock.mockImplementation(({ abortSignal }) => ({
          consumeStream: () => waitForAbort(abortSignal),
          response: Promise.resolve({ messages: [] }),
          steps: Promise.resolve([]),
          totalUsage: Promise.resolve({}),
          finishReason: Promise.resolve("stop"),
        }));
        assistantTurnMock.mockImplementation(async ({ abortSignal }) => {
          await waitForAbort(abortSignal);
          return {};
        });
      }
      if (options.capacity || options.capacityAbort) {
        vi.stubEnv("E2B_API_KEY", "test-key");
        vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "test-secret");
        vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-token");
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({ error: "full", code: "at_capacity" }),
                {
                  status: 503,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );
      }
      if (options.capacityAbort) {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            (_url, init) =>
              new Promise((_resolve, reject) => {
                init.signal.addEventListener(
                  "abort",
                  () => reject(init.signal.reason),
                  { once: true },
                );
              }),
          ),
        );
      }
      const pending = runEvalSuiteWithAiSdk({
        suiteId: "suite-1",
        runId: "run-1",
        recorder,
        config: {
          tests: [
            {
              ...snapshot,
              runs: 3,
              testCaseId: "case-1",
              expectedToolCalls: [],
              promptTurns: [
                { id: "turn-1", prompt: "Hello", expectedToolCalls: [] },
              ],
            },
          ],
          environment: {
            servers: ["srv-1"],
            ...(options.capacity || options.capacityAbort
              ? { computerEnvironmentId: "env-1" }
              : {}),
          },
        },
        modelApiKeys: { openai: "sk-test" },
        convexClient,
        convexHttpUrl: "https://example.convex.site",
        convexAuthToken: "token",
        mcpClientManager: manager,
        executionBudgets: {
          ...defaultEvalExecutionBudgets(),
          turnTimeoutMs: options.turnTimeout ? 20 : 1000,
          unitTimeoutMs: 100,
          runTimeoutMs: options.runDeadline ? 50 : 1000,
        },
      } as any);
      await vi.advanceTimersByTimeAsync(options.capacityAbort ? 350 : 150);
      await pending;
      return { rows, recorder, convexClient };
    }

    it("persists the turn clock before the iteration budget expires", async () => {
      const { rows } = await startRun({ turnTimeout: true });
      for (const row of rows) {
        expect(row.status).toBe("completed");
        expect(row.metadata.timeout).toMatchObject({
          clock: "turn",
          budgetMs: 20,
          elapsedMs: 20,
        });
      }
    });

    it("persists sandbox capacity exhaustion as a setup failure", async () => {
      const { rows } = await startRun({ capacity: true });
      for (const row of rows) {
        expect(row.status).toBe("setup_failed");
        expect(row.metadata.timeout.clock).toBe("sandboxCapacity");
        expect(row.metadata.timeout.budgetMs).toBeLessThanOrEqual(100);
      }
    });

    it("records iteration timeout when provisioning consumes the remaining unit budget", async () => {
      const { rows } = await startRun({ capacityAbort: true });
      for (const row of rows) {
        expect(row.status).toBe("timed_out");
        expect(row.metadata.timeout.clock).toBe("iteration");
      }
    });

    it("isolates iteration 2 and completes iterations 1 and 3", async () => {
      const { rows, recorder } = await startRun();
      expect(rows.map((row) => row.status)).toEqual([
        "completed",
        "timed_out",
        "completed",
      ]);
      expect(rows[1].metadata.timeout.clock).toBe("iteration");
      expect(recorder.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "completed",
          summary: expect.any(Object),
        }),
      );
    });

    it("restores abort-the-run behavior under the compatibility switch", async () => {
      const { recorder } = await startRun({ killSwitch: true });
      expect(recorder.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "timed_out",
          stopReason: "iteration_timeout",
        }),
      );
    });

    it("keeps completed evidence and finalizes the run deadline for the backend sweep", async () => {
      const { rows, recorder } = await startRun({ runDeadline: true });
      expect(rows[0].status).toBe("completed");
      expect(recorder.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "timed_out",
          stopReason: "run_timeout",
        }),
      );
    });
  },
);
