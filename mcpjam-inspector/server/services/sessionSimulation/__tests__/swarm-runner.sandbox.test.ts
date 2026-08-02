/**
 * swarm-runner.sandbox.test.ts — the per-attempt ephemeral sandbox (B-isolation).
 *
 * Drives the REAL swarm runner and the real shared core, mocking only the
 * control-plane HTTP client, so what these tests assert is the actual
 * provision → bind → release ordering the runner performs.
 *
 * The properties that matter, and why:
 *   - two sessions of one target get TWO DISTINCT boxes. This is the whole
 *     point: sharing one box is the contamination bug #3595 suppressed bash to
 *     avoid;
 *   - release fires on success, on session failure, AND on run abort. A leaked
 *     box costs money until the GC cron reaps it;
 *   - a provision failure fails THAT ATTEMPT rather than running it bash-less.
 *     A degraded-but-green run is harder to notice than a red one;
 *   - a harness target never reaches the harness turn under the flag. It would
 *     otherwise reserve the launcher's shared personal computer while the bash
 *     path looked isolated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAssistantTurnMock = vi.fn();
const resolveSyntheticModelSourceMock = vi.fn();
const persistChatSessionToConvexMock = vi.fn();
const prepareChatV2Mock = vi.fn();
const createBrowserSessionContextMock = vi.fn();
const reportAttemptMock = vi.fn();
const swarmPersonaNextTurnMock = vi.fn();
const heartbeatJourneyRunMock = vi.fn();
const provisionJourneySandboxMock = vi.fn();
const releaseSandboxMock = vi.fn();
const resolveHostToolsMock = vi.fn();
const resolveHarnessSandboxMock = vi.fn();
const dataPlaneConfiguredMock = vi.fn(() => true);

vi.mock("../../../utils/assistant-turn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/assistant-turn.js")
  >("../../../utils/assistant-turn.js");
  return {
    ...actual,
    runAssistantTurn: (...args: unknown[]) => runAssistantTurnMock(...args),
  };
});

vi.mock("../../../utils/org-model-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/org-model-config.js")
  >("../../../utils/org-model-config.js");
  return {
    ...actual,
    resolveSyntheticModelSource: (...args: unknown[]) =>
      resolveSyntheticModelSourceMock(...args),
  };
});

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-ingestion.js")
  >("../../../utils/chat-ingestion.js");
  return {
    ...actual,
    persistChatSessionToConvex: (...args: unknown[]) =>
      persistChatSessionToConvexMock(...args),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-v2-orchestration.js")
  >("../../../utils/chat-v2-orchestration.js");
  return {
    ...actual,
    prepareChatV2: (...args: unknown[]) => prepareChatV2Mock(...args),
  };
});

vi.mock("../../browser-session-context.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../browser-session-context.js")
  >("../../browser-session-context.js");
  return {
    ...actual,
    createBrowserSessionContext: (...args: unknown[]) =>
      createBrowserSessionContextMock(...args),
  };
});

vi.mock("../../swarm-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../swarm-agent.js")>(
    "../../swarm-agent.js"
  );
  return {
    ...actual,
    reportAttempt: (...args: unknown[]) => reportAttemptMock(...args),
    swarmPersonaNextTurn: (...args: unknown[]) =>
      swarmPersonaNextTurnMock(...args),
    heartbeatJourneyRun: (...args: unknown[]) =>
      heartbeatJourneyRunMock(...args),
  };
});

vi.mock("../../../utils/computers/control-plane-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/control-plane-client.js")
  >("../../../utils/computers/control-plane-client.js");
  return {
    ...actual,
    // The runner gates on this before touching the sandbox path at all: a
    // server that can provision but not release would burn paid boxes.
    isComputersDataPlaneConfigured: () => dataPlaneConfiguredMock(),
    provisionJourneySandbox: (...args: unknown[]) =>
      provisionJourneySandboxMock(...args),
    releaseSandbox: (...args: unknown[]) => releaseSandboxMock(...args),
  };
});

// Spy on the tool resolver so we can inspect the ctx the shared core builds —
// specifically, whether the trusted binding arrived.
vi.mock("../../../utils/built-in-tools/registry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/built-in-tools/registry.js")
  >("../../../utils/built-in-tools/registry.js");
  return {
    ...actual,
    resolveHostTools: (...args: unknown[]) => {
      resolveHostToolsMock(...args);
      return (actual.resolveHostTools as never as (...a: unknown[]) => unknown)(
        ...args
      );
    },
  };
});

// The harness sandbox resolver is the thing a harness target must NEVER reach:
// it reserves the launcher's PERSONAL computer.
//
// Mocked at its DEFINING module. `run-harness-turn.ts` imports it locally and
// never re-exports it, so mocking that namespace would intercept nothing and
// this assertion would pass no matter what the runner did — false confidence on
// exactly the guarantee that matters most here.
vi.mock("../../../utils/harness/resolve-sandbox.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/resolve-sandbox.js")
  >("../../../utils/harness/resolve-sandbox.js");
  return {
    ...actual,
    resolveHarnessSandbox: (...args: unknown[]) =>
      resolveHarnessSandboxMock(...args),
  };
});

import {
  startJourneyRun,
  type StartJourneyRunOptions,
} from "../swarm-runner.js";
import type { PinnedHostExecutionSpec } from "../../swarm-agent.js";

const TURN_TRACE = {
  turnId: "turn-1",
  promptIndex: 0,
  startedAt: 0,
  endedAt: 1,
  spans: [],
};

function fakeBrowserContext() {
  return {
    computerUseSupported: false,
    computerUseVersion: null,
    computerWidgetTools: {},
    widgetRenderObservations: [],
    browserInteractionSteps: [],
    prepareAdvertisedTools: undefined,
    setActivePromptIndex: vi.fn(),
    noteToolCallInput: vi.fn(),
    handleEngineToolResult: vi.fn(),
    handleDirectToolResultChunk: vi.fn(),
    drainNewArtifacts: vi.fn(() => ({ observations: [], steps: [] })),
    collectVideo: vi.fn(async () => null),
    dismissCarriedWidget: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

/** Per-test tweaks to the single pinned target. Typed against the real spec so
 * a rename can't silently make an override a no-op. */
type TargetOverrides = Partial<PinnedHostExecutionSpec>;

function baseOpts(
  target: TargetOverrides = {},
  sessionsPerHost = 1
): StartJourneyRunOptions {
  return {
    runId: "run-1",
    projectId: "proj-1",
    hosts: [
      {
        hostId: "host-1",
        targetId: "environment:env-1",
        hostName: "Host One",
        hostConfigId: "hc-1",
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "sys",
        requireToolApproval: false,
        serverIds: ["server-1"],
        builtInToolIds: ["bash"],
        computer: { kind: "personal" as const },
        computerEnvironment: {
          environmentId: "env-img-1",
          environmentBuildId: "bld-1",
        },
        ...target,
      },
    ],
    personaSnapshot: {
      personaId: "p1",
      name: "Persona One",
      role: "tester",
      notes: "",
    },
    sessionsPerHost,
    maxTurns: 3,
    convexHttpUrl: "https://convex.site",
    bearer: "token",
    authHeader: "Bearer token",
    managerFactory: async () => ({
      manager: {
        hasServer: () => false,
        executeTool: vi.fn(),
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as never,
      connectedServerIds: ["server-1"],
      dispose: async () => {},
    }),
  };
}

/** Every ctx `resolveHostTools` was called with, in order. */
function resolverContexts(): Array<Record<string, unknown>> {
  return resolveHostToolsMock.mock.calls.map(
    (call) => call[1] as Record<string, unknown>
  );
}

/** Every terminal (non-`running`) attempt report the runner made. */
function terminalReports(): Array<Record<string, unknown>> {
  return reportAttemptMock.mock.calls
    .map((call) => call[2] as Record<string, unknown>)
    .filter((body) => body.status !== "running");
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.site");
  vi.stubEnv("MCPJAM_SWARM_EPHEMERAL_BASH", "true");
  let seq = 0;
  provisionJourneySandboxMock.mockReset().mockImplementation(async () => {
    seq += 1;
    return {
      ok: true,
      value: {
        sandboxId: `sbx_${seq}`,
        sandboxRowId: `row_${seq}`,
        workdir: "/home/user",
      },
    };
  });
  releaseSandboxMock.mockReset().mockResolvedValue(undefined);
  dataPlaneConfiguredMock.mockReset().mockReturnValue(true);
  resolveHostToolsMock.mockReset();
  resolveHarnessSandboxMock.mockReset();
  reportAttemptMock.mockReset().mockResolvedValue({ ok: true, applied: true });
  heartbeatJourneyRunMock.mockReset().mockResolvedValue(undefined);
  persistChatSessionToConvexMock.mockReset().mockResolvedValue(undefined);
  resolveSyntheticModelSourceMock
    .mockReset()
    .mockResolvedValue({ source: "mcpjam" });
  prepareChatV2Mock.mockReset().mockResolvedValue({
    allTools: {},
    enhancedSystemPrompt: "enhanced",
    resolvedTemperature: undefined,
    progressivePlan: undefined,
    discoveryState: undefined,
  });
  createBrowserSessionContextMock
    .mockReset()
    // A FACTORY, not a fixed value: the two-session test would otherwise hand
    // both sessions the same context object and the same spies.
    .mockImplementation(() => fakeBrowserContext());
  swarmPersonaNextTurnMock
    .mockReset()
    .mockResolvedValue({ message: "", endSession: true });
  runAssistantTurnMock.mockReset().mockImplementation(async (opts: never) => ({
    messages: [
      ...(opts as { messages: unknown[] }).messages,
      { role: "assistant", content: "hi" },
    ],
    assistantMessages: [],
    toolCalls: [],
    toolResults: [],
    turnTrace: TURN_TRACE,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("swarm runner — per-attempt ephemeral sandbox", () => {
  it("provisions after the claim, binds the box, and releases it", async () => {
    await startJourneyRun(baseOpts());

    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
    expect(provisionJourneySandboxMock.mock.calls[0]![0]).toMatchObject({
      runId: "run-1",
      targetId: "environment:env-1",
      sessionIdx: 0,
    });

    // The trusted binding reached the resolver on `ctx` — never on `config`.
    const ctxs = resolverContexts();
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.sandboxBinding).toEqual({
      sandboxId: "sbx_1",
      workdir: "/home/user",
    });
    expect(ctxs[0]!.isJourneySession).toBe(true);

    expect(releaseSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row_1" })
    );
  });

  it("bounds the release call with its own deadline", async () => {
    // Release runs in the attempt's `finally`, so an unbounded call to a
    // control plane that never responds would stall the target worker and
    // leave the run alive forever. It must not use the RUN signal (cleanup has
    // to survive a cancel) — but it must still have a deadline.
    await startJourneyRun(baseOpts());
    const arg = releaseSandboxMock.mock.calls[0]![0];
    expect(arg.sandboxRowId).toBe("row_1");
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a 2xx whose body is unusable instead of throwing", async () => {
    // `postJson` swallows a body-parse failure and returns
    // `{ok: true, value: null}` on any 2xx — reachable when the request
    // deadline fires after the headers arrive. Dereferencing that would throw
    // straight past the bounded retry.
    let calls = 0;
    provisionJourneySandboxMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, value: null };
      return {
        ok: true,
        value: { sandboxId: "sbx_9", sandboxRowId: "row_9" },
      };
    });

    // Fake timers, like the 503 sibling: the retry sleeps a real jittered
    // backoff otherwise, costing seconds of wall clock for nothing.
    vi.useFakeTimers();
    const run = startJourneyRun(baseOpts());
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();

    expect(calls).toBe(2);
    const ctxs = resolverContexts();
    expect(ctxs[0]!.sandboxBinding).toEqual({ sandboxId: "sbx_9" });
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });

  it("gives two sessions of ONE target two DISTINCT boxes", async () => {
    await startJourneyRun(baseOpts({}, 2));

    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(2);
    const bindings = resolverContexts().map((c) => c.sandboxBinding);
    expect(bindings).toHaveLength(2);
    // The entire point of per-attempt scoping: one session's writes can never
    // be visible to the next.
    expect((bindings[0] as { sandboxId: string }).sandboxId).not.toBe(
      (bindings[1] as { sandboxId: string }).sandboxId
    );
    expect(releaseSandboxMock.mock.calls.map((c) => c[0].sandboxRowId)).toEqual(
      ["row_1", "row_2"]
    );
  });

  it("releases the box even when the session fails", async () => {
    // The shared core breaks out BEFORE `runAssistantTurn` on `endSession:
    // true`, so the default persona mock would make this pass through the
    // ordinary success path and prove nothing. Drive one real turn, then fail
    // it.
    swarmPersonaNextTurnMock.mockResolvedValue({
      message: "go",
      endSession: false,
    });
    runAssistantTurnMock.mockRejectedValue(new Error("model exploded"));

    await startJourneyRun(baseOpts());

    expect(runAssistantTurnMock).toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "failed" });
    expect(releaseSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row_1" })
    );
  });

  it("releases the box when the run is aborted mid-flight", async () => {
    const controller = new AbortController();
    swarmPersonaNextTurnMock.mockResolvedValue({
      message: "go",
      endSession: false,
    });
    runAssistantTurnMock.mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await startJourneyRun({
      ...baseOpts(),
      abortSignal: controller.signal,
    });

    // The abort path is the one most likely to skip a `finally`; a box leaked
    // here costs money until the GC cron reaps it.
    expect(runAssistantTurnMock).toHaveBeenCalled();
    expect(releaseSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row_1" })
    );
  });

  it("leaves an attempt aborted DURING provisioning to the run-level finalizer", async () => {
    // A shutdown / spend-cap short-circuit that lands inside provisioning is an
    // abort artifact, not this attempt's failure. `finalizeRunPendingAttempts`
    // sweeps `running` attempts too, so stamping a terminal here would out-race
    // it and record a misleading cause.
    const controller = new AbortController();
    provisionJourneySandboxMock.mockImplementation(async () => {
      controller.abort();
      return { ok: false, status: 0, error: "network error" };
    });

    await startJourneyRun({
      ...baseOpts(),
      abortSignal: controller.signal,
    });

    expect(terminalReports()).toHaveLength(0);
    expect(releaseSandboxMock).not.toHaveBeenCalled();
  });

  it("fails the attempt (rather than running it bash-less) when provisioning is refused", async () => {
    provisionJourneySandboxMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "This target pinned no computer environment.",
    });

    await startJourneyRun(baseOpts());

    // The session never ran — a silently bash-less run would be a validity
    // change nobody would notice.
    expect(resolveHostToolsMock).not.toHaveBeenCalled();
    const terminals = terminalReports();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      status: "failed",
      errorCode: "sandbox_error",
    });
    // Nothing was booted, so nothing is released.
    expect(releaseSandboxMock).not.toHaveBeenCalled();
  });

  it("retries a 503 and fails with `sandbox_at_capacity` once the retries are spent", async () => {
    vi.useFakeTimers();
    provisionJourneySandboxMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: "Computers is at capacity, try again in a few minutes",
    });
    const run = startJourneyRun(baseOpts());
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();

    // Bounded, not infinite: the attempt fails honestly instead of hanging.
    expect(provisionJourneySandboxMock.mock.calls.length).toBeGreaterThan(1);
    expect(terminalReports()[0]).toMatchObject({
      status: "failed",
      errorCode: "sandbox_at_capacity",
    });
  });

  it("a 409 is NOT retried — the answer cannot change", async () => {
    provisionJourneySandboxMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "This attempt is succeeded; only a running attempt may hold one.",
    });
    await startJourneyRun(baseOpts());
    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
  });
});

describe("swarm runner — targets that want no sandbox", () => {
  it("skips provisioning entirely when the target does not advertise bash", async () => {
    await startJourneyRun(baseOpts({ builtInToolIds: ["web_search"] }));
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(resolverContexts()[0]!.sandboxBinding).toBeUndefined();
  });

  it("skips provisioning when no image is pinned, and surfaces the frozen reason", async () => {
    await startJourneyRun(
      baseOpts({
        computerEnvironment: undefined,
        computerUnavailableReason:
          "This environment has no computer image configured, so bash is unavailable in this run.",
      })
    );
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    // The session still runs — a missing image is a configuration state, not
    // an error — and the notice names the real problem.
    expect(resolveHostToolsMock).toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });

  it("treats a PRE-B-isolation snapshot (both fields absent) as legacy, not as unavailable", async () => {
    // Absence alone cannot distinguish an old backend from a new backend with
    // no image; the old backend must keep today's silent suppression.
    await startJourneyRun(
      baseOpts({
        computerEnvironment: undefined,
        computerUnavailableReason: undefined,
      })
    );
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });

  it("does nothing at all when the flag is off", async () => {
    vi.stubEnv("MCPJAM_SWARM_EPHEMERAL_BASH", "");
    await startJourneyRun(baseOpts());
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(resolverContexts()[0]!.sandboxBinding).toBeUndefined();
  });
});

describe("swarm runner — harness targets fail closed (F4)", () => {
  it("never runs the harness turn, and never reaches the personal-computer reserve", async () => {
    await startJourneyRun(baseOpts({ harness: "claude-code" }));

    // THE assertion: `runHarnessTurn` bypasses `resolveHostTools` and reserves
    // the launcher's PERSONAL computer, so a harness target that ran would keep
    // sharing one machine across every session while bash looked isolated.
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    const terminals = terminalReports();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.status).toBe("failed");
    expect(String(terminals[0]!.errorMessage)).toMatch(/harness/i);
  });

  it("stays blocked when the flag is on but the data plane is UNCONFIGURED", async () => {
    // The refusal is gated on the FLAG ALONE, never on provision capability.
    // Tying it to availability would mean a broken or unconfigured sandbox
    // service silently re-enables the contamination path: no box to isolate
    // into, so the harness quietly lands back on the launcher's shared
    // computer. Availability must not widen what is allowed.
    dataPlaneConfiguredMock.mockReturnValue(false);

    await startJourneyRun(baseOpts({ harness: "claude-code" }));

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "failed" });
  });

  it("does not provision a box for an attempt it is going to refuse", async () => {
    // A harness-blocked session is refused before it builds anything, so a box
    // booted for it is paid for and never touched.
    await startJourneyRun(baseOpts({ harness: "claude-code" }));
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(releaseSandboxMock).not.toHaveBeenCalled();
  });

  it("leaves harness targets alone when the flag is off", async () => {
    vi.stubEnv("MCPJAM_SWARM_EPHEMERAL_BASH", "");
    await startJourneyRun(baseOpts({ harness: "claude-code" }));
    // Flag off ⇒ today's behaviour, unchanged. The session proceeds through the
    // normal path (which is still contaminated — that is what the flag fixes).
    expect(terminalReports()[0]!.status).not.toBe("failed");
  });
});
