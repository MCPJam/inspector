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
// The approval gate reads the adapter's declared capabilities. One test needs a
// NATIVE-delivery harness that cannot approve its MCP tools — a combination no
// registered adapter has anymore — so the flag is overridable here. Everything
// else on the adapter stays real.
let forceNoMcpToolApproval = false;
vi.mock("../../../utils/harness/registry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/registry.js")
  >("../../../utils/harness/registry.js");
  return {
    ...actual,
    getHarnessAdapter: (id: Parameters<typeof actual.getHarnessAdapter>[0]) => {
      const adapter = actual.getHarnessAdapter(id);
      return forceNoMcpToolApproval
        ? { ...adapter, supportsMcpToolApproval: false }
        : adapter;
    },
  };
});

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
  sessionsPerTarget = 1
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
    sessionsPerTarget,
    maxTurns: 3,
    convexHttpUrl: "https://convex.site",
    getBearer: async () => "token",
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

/** Two independent targets in one run, so blast radius is observable. */
function twoTargetOpts(
  first: TargetOverrides,
  second: TargetOverrides
): StartJourneyRunOptions {
  const base = baseOpts();
  const template = base.hosts[0]!;
  return {
    ...base,
    hosts: [
      {
        ...template,
        hostId: "host-1",
        targetId: "environment:env-1",
        ...first,
      },
      {
        ...template,
        hostId: "host-2",
        targetId: "environment:env-2",
        ...second,
      },
    ],
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
  persistChatSessionToConvexMock
    .mockReset()
    .mockResolvedValue({ outcome: "saved", version: 1 });
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
  // Same reasoning as the timers below: reset unconditionally so a capability
  // override can never leak into the next test's adapter.
  forceNoMcpToolApproval = false;
  // Unconditionally, so a run that rejects between `useFakeTimers()` and its
  // matching restore can't leak a frozen clock into the next test and produce
  // a confusing cascade. Cheap, and it covers every fake-timer test here.
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/**
 * Make the persona drive exactly ONE turn per session, then stop.
 *
 * The default persona mock ends every session before the first turn, which is
 * fine for the provisioning assertions (they read the ctx `resolveHostTools`
 * was built with, which happens before any turn) — but the HARNESS binding
 * travels on the turn's handler options, so it only becomes observable once a
 * turn actually executes.
 */
function personaDrivesOneTurn(): void {
  // Keyed on the transcript, not a counter: a counter would be shared across
  // the run's sessions and silently end the second one before its first turn.
  swarmPersonaNextTurnMock.mockImplementation(
    async (_url: unknown, _bearer: unknown, args: unknown) => {
      const transcript =
        (args as { transcriptSoFar?: unknown[] })?.transcriptSoFar ?? [];
      return transcript.length === 0
        ? { message: "hello", endSession: false }
        : { message: "", endSession: true };
    }
  );
}

/** The handler options of the Nth executed turn. */
function turnOptions(index = 0): Record<string, unknown> {
  const call = runAssistantTurnMock.mock.calls[index];
  if (!call)
    throw new Error(`no assistant turn was executed at index ${index}`);
  return call[0] as Record<string, unknown>;
}

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

  it("FAILS the attempt when the data plane is unconfigured", async () => {
    // A target that asked for a reproducible shell must not run without one
    // just because this server can't provision. That is the degraded-but-green
    // outcome the whole design refuses — and it is the same shape as the
    // harness gate, which is keyed on the flag alone for exactly this reason.
    dataPlaneConfiguredMock.mockReturnValue(false);

    await startJourneyRun(baseOpts());

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(resolveHostToolsMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({
      status: "failed",
      errorCode: "sandbox_unavailable",
    });
  });

  it("an unconfigured data plane does NOT fail a target that wants no shell", async () => {
    // Only targets that would have provisioned are affected; everything else
    // runs exactly as before.
    dataPlaneConfiguredMock.mockReturnValue(false);

    await startJourneyRun(baseOpts({ builtInToolIds: ["web_search"] }));

    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });
});

describe("swarm runner — harness targets run on an ephemeral box (phase 6)", () => {
  it("provisions a box, hands it to the harness, and NEVER reserves the personal computer", async () => {
    personaDrivesOneTurn();
    await startJourneyRun(baseOpts({ harness: "claude-code" }));

    // THE assertion, unchanged in spirit from F4: `runHarnessTurn` does not go
    // through `resolveHostTools`, and without an explicit binding it reserves
    // the launcher's PERSONAL computer — one machine shared by every session in
    // the run. Phase 6 gives it a box instead; it must still never fall back.
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();

    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
    // The binding reached the harness on the HANDLER OPTIONS (its equivalent of
    // `ctx.sandboxBinding`), carrying the control-plane row id the egress
    // broker leases against.
    const turnOpts = turnOptions();
    expect(turnOpts.harnessSandboxBinding).toEqual({
      sandboxRowId: "row_1",
      sandboxId: "sbx_1",
      workdir: "/home/user",
    });
    expect(turnOpts.harness).toBe("claude-code");

    const terminals = terminalReports();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.status).toBe("succeeded");
    expect(releaseSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row_1" })
    );
  });

  it("gives two sessions of a harness target two DISTINCT boxes", async () => {
    personaDrivesOneTurn();
    await startJourneyRun(baseOpts({ harness: "claude-code" }, 2));
    const bindings = runAssistantTurnMock.mock.calls.map(
      (call) =>
        (call[0] as { harnessSandboxBinding?: { sandboxRowId?: string } })
          .harnessSandboxBinding
    );
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!.sandboxRowId).not.toBe(bindings[1]!.sandboxRowId);
  });

  it("provisions for a harness target that advertises NO bash tool", async () => {
    // A harness executes on a machine whether or not the host also exposes a
    // shell, so `bash` in the tool list is not what decides this.
    await startJourneyRun(
      baseOpts({ harness: "claude-code", builtInToolIds: [] })
    );
    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });

  it("FAILS CLOSED when the data plane is UNCONFIGURED", async () => {
    // The refusal is gated on the FLAG ALONE, never on provision capability.
    // Tying it to availability would mean a broken or unconfigured sandbox
    // service silently re-enables the contamination path: no box to isolate
    // into, so the harness quietly lands back on the launcher's shared
    // computer. Availability must not widen what is allowed.
    dataPlaneConfiguredMock.mockReturnValue(false);

    await startJourneyRun(baseOpts({ harness: "claude-code" }));

    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(runAssistantTurnMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "failed" });
  });

  it("FAILS CLOSED when provisioning fails, rather than using the personal computer", async () => {
    provisionJourneySandboxMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "image_unavailable",
    });

    await startJourneyRun(baseOpts({ harness: "claude-code" }));

    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "failed" });
  });

  it("FAILS CLOSED, without provisioning, when the run pinned no image", async () => {
    // Knowable per TARGET, so it is refused before any box is booted — a
    // harness-blocked session would pay for a box purely to release it unused.
    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        computerEnvironment: undefined,
        computerUnavailableReason:
          "This environment has no computer image configured, so this run has no sandbox to execute in.",
      })
    );

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(releaseSandboxMock).not.toHaveBeenCalled();
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    const terminals = terminalReports();
    expect(terminals[0]!.status).toBe("failed");
    // The message names the ACTUAL configuration problem, not "swarms don't
    // support harnesses".
    expect(String(terminals[0]!.errorMessage)).toMatch(/computer image/i);
  });

  it("FAILS CLOSED, without provisioning, when the target has no computer attached", async () => {
    await startJourneyRun(
      baseOpts({ harness: "claude-code", computer: undefined })
    );
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(String(terminalReports()[0]!.errorMessage)).toMatch(
      /no computer attached/i
    );
  });

  it("treats a PRE-B-isolation snapshot as blocked for a harness, not silently degraded", async () => {
    // Both pin fields absent is an OLD run snapshot. For bash that stays silent
    // (the tool simply goes missing); a harness cannot run at all, so the
    // session must fail with something true rather than reserve the shared box.
    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        computerEnvironment: undefined,
        computerUnavailableReason: undefined,
      })
    );
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(terminalReports()[0]).toMatchObject({ status: "failed" });
  });
});

/**
 * The harness preflight the INTERACTIVE path already ran, now applied to swarm
 * targets too.
 *
 * Until phase 6 the swarm path refused every harness outright, so it never
 * needed one. Admitting harness targets means inheriting every rule chat
 * enforces — and the failure mode for missing one is not a red run: it is a
 * paid box booted for a session that then quietly does something else.
 *
 * These go through the SHARED `checkHarnessRuntimeAvailable`, so a rule added
 * to the chat preflight later applies here without a second edit.
 */
describe("swarm runner — harness preflight parity with interactive chat", () => {
  it("refuses a BYOK / non-catalog model before booting anything", async () => {
    // `resolveTurnRuntime` sends a non-MCPJam model on a local-runtime BYOK
    // provider to the DIRECT engine, whose branch never forwards `harness` or
    // `harnessSandboxBinding`. Admitting it would boot a paid box and then run
    // the emulated engine with the box untouched — degraded AND expensive, and
    // invisible in the run.
    await startJourneyRun(
      baseOpts({ harness: "claude-code", modelId: "acme/private-llm" })
    );

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(releaseSandboxMock).not.toHaveBeenCalled();
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    const terminals = terminalReports();
    expect(terminals[0]!.status).toBe("failed");
    expect(String(terminals[0]!.errorMessage)).toMatch(/MCPJam-provided/i);
  });

  it("refuses an enterprise-managed (XAA) target", async () => {
    // The harness reaches MCP servers through a signed proxy whose token
    // carries no host, so it cannot enforce the host's authorization policy —
    // a harness turn could bypass it. Chat rejects this; so must a swarm.
    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        mcpProfile: {
          extensions: {
            "com.mcpjam/enterprise-managed-auth": { idp: "mcpjam" },
          },
        } as never,
      })
    );

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(resolveHarnessSandboxMock).not.toHaveBeenCalled();
    expect(String(terminalReports()[0]!.errorMessage)).toMatch(
      /enterprise-managed/i
    );
  });

  it("refuses requireToolApproval on a harness that cannot pause", async () => {
    // Codex builds its thread with `approvalPolicy: "never"` hardcoded, so it
    // is never asked to pause on any surface — the combination advertises an
    // approval gate it cannot enforce. (Claude Code CAN pause on all three
    // surfaces and is admitted; asserted below.)
    await startJourneyRun(
      baseOpts({
        harness: "codex",
        requireToolApproval: true,
        serverIds: ["server-1"],
      })
    );

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(String(terminalReports()[0]!.errorMessage)).toMatch(/approval/i);
  });

  it("admits requireToolApproval with MCP servers on Claude Code", async () => {
    // The adapter bridge's `canUseTool` gates MCP tool calls under
    // "allow-reads", so this target is sound and must reach provisioning
    // rather than being refused at the preflight.
    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        requireToolApproval: true,
        serverIds: ["server-1"],
      })
    );

    expect(provisionJourneySandboxMock).toHaveBeenCalled();
  });

  it("counts PLUGIN servers toward the approval gate", async () => {
    // A target whose MCP servers come solely from a plugin has an empty
    // `serverIds`, so a selected-servers-only predicate reads `false` and the
    // target slips the very gate the approval rule exists to close.
    //
    // Asserted on Claude Code, and it has to be: Codex refuses on the
    // native-approval arm BEFORE the server count is ever consulted, so a
    // Codex fixture here would pass without exercising the counting at all.
    // Claude Code reaches the MCP arm, so the plugin servers are what decides
    // — proven by the `supportsMcpToolApproval: false` stub, which turns the
    // same target into a refusal only because the plugin servers counted.
    forceNoMcpToolApproval = true;

    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        requireToolApproval: true,
        serverIds: [],
        pluginServerIds: ["plugin-server-1"],
      })
    );

    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
    expect(String(terminalReports()[0]!.errorMessage)).toMatch(
      /MCP-server tools/i
    );
  });

  it("does NOT refuse the same host once the plugin servers are gone", async () => {
    // The control for the case above: with no servers at all the identical
    // stubbed host is admitted, so the refusal really did come from counting
    // the plugin-contributed ones rather than from the stub itself.
    forceNoMcpToolApproval = true;

    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        requireToolApproval: true,
        serverIds: [],
        pluginServerIds: [],
      })
    );

    expect(provisionJourneySandboxMock).toHaveBeenCalled();
  });

  it("admits a BARE hosted model id (provider comes from the resolved definition)", async () => {
    // The mirror image of the BYOK case: deciding eligibility on the raw
    // pinned string is provider-blind, so `gpt-5-nano` reads as non-hosted and
    // a perfectly legitimate target gets refused before it can boot a box.
    // The gate derives both eligibility and the canonical id from the SAME
    // resolved `ModelDefinition` the turn runs on.
    personaDrivesOneTurn();
    await startJourneyRun(
      baseOpts({ harness: "codex", modelId: "gpt-5-nano", serverIds: [] })
    );

    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });

  it("still admits an approval target with NO MCP servers", async () => {
    // The rule is capability-driven, not "approval is unsupported": Claude Code
    // does gate its own tools. Over-refusing here would silently drop a
    // configuration the interactive path allows.
    personaDrivesOneTurn();
    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        requireToolApproval: true,
        serverIds: [],
      })
    );

    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });

  it("leaves NON-harness targets untouched by the preflight", async () => {
    // The gate is scoped to harness targets; a plain bash target on a BYOK
    // model is none of its business.
    await startJourneyRun(baseOpts({ modelId: "acme/private-llm" }));
    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
    expect(terminalReports()[0]).toMatchObject({ status: "succeeded" });
  });
});

describe("swarm runner — server-executed built-ins reach the harness", () => {
  it("forwards builtInTools to the harness turn", async () => {
    // The harness receives server-executed built-ins (`web_search`, …) on their
    // OWN option, not merged into `tools`: it hands them to the runtime as
    // specs and runs `execute()` here, while MCP-server tools arrive via
    // `.mcp.json`. Before this the swarm core passed them to prepareChatV2
    // only, so a harness target configured with `web_search` silently lost it
    // — and silent tool loss reads as a host-config bug, not a run bug.
    personaDrivesOneTurn();
    await startJourneyRun(
      baseOpts({
        harness: "claude-code",
        builtInToolIds: ["web_search"],
      })
    );

    const builtIns = turnOptions().builtInTools as
      | Record<string, unknown>
      | undefined;
    expect(builtIns).toBeDefined();
    expect(Object.keys(builtIns!)).toContain("web_search");
  });

  it("does NOT set builtInTools on a non-harness target", async () => {
    // The emulated engine already receives them merged into `tools` via
    // prepareChatV2's `allTools`; setting both would advertise each twice.
    personaDrivesOneTurn();
    await startJourneyRun(baseOpts({ builtInToolIds: ["web_search"] }));
    expect(turnOptions().builtInTools).toBeUndefined();
  });
});

describe("swarm runner — a bad target cannot take the run down with it", () => {
  it("refuses ONLY its own target when the enterprise policy is malformed", async () => {
    // Blast radius. `runTarget` is awaited inside `worker()` and the workers
    // are combined with `Promise.all`, which rejects on the FIRST rejection —
    // so anything that escapes `runTarget` fails the whole run AND abandons
    // sibling targets already in flight. The run-level catch's contract is
    // that per-target work is already guarded, and that contract is only as
    // strong as the newest line inside `runTarget`.
    const malformed = {
      // `idp` is not a supported value ⇒ the policy reader's `invalid` arm.
      extensions: { "com.mcpjam/enterprise-managed-auth": { idp: "nope" } },
    } as never;
    personaDrivesOneTurn();

    await startJourneyRun(
      twoTargetOpts(
        { harness: "claude-code", mcpProfile: malformed },
        { harness: "claude-code" }
      )
    );

    const byHost = new Map(terminalReports().map((r) => [String(r.hostId), r]));
    // The malformed target is refused...
    // `session_failed`, NOT `host_worker_failed`. That distinction IS the
    // finding: the latter is the code the worker catch stamps when something
    // escaped `runTarget`, and it is what this produced before the policy read
    // stopped throwing. The message alone cannot tell the two apart — the old
    // 409 also said "enterprise-managed".
    expect(byHost.get("host-1")).toMatchObject({
      status: "failed",
      errorCode: "session_failed",
    });
    // INVALID is treated exactly like ON — never more permissive than a policy
    // that parses.
    expect(String(byHost.get("host-1")!.errorMessage)).toMatch(
      /enterprise-managed/i
    );
    // ...while its sibling runs to completion.
    expect(byHost.get("host-2")).toMatchObject({ status: "succeeded" });
    expect(provisionJourneySandboxMock).toHaveBeenCalledTimes(1);
  });

  it("refuses ONLY its own target when the harness id is unknown to this build", async () => {
    // `getHarnessAdapter` throws on an id a newer backend could have written
    // into the snapshot. Same requirement: a stated per-target refusal, not an
    // exception, and siblings unaffected.
    personaDrivesOneTurn();

    await startJourneyRun(
      twoTargetOpts(
        { harness: "future-harness" as never },
        { harness: "claude-code" }
      )
    );

    const byHost = new Map(terminalReports().map((r) => [String(r.hostId), r]));
    expect(byHost.get("host-1")).toMatchObject({
      status: "failed",
      errorCode: "session_failed",
    });
    expect(String(byHost.get("host-1")!.errorMessage)).toMatch(
      /could not be validated/i
    );
    expect(byHost.get("host-2")).toMatchObject({ status: "succeeded" });
  });

  it("a VALID enterprise policy and a malformed one are refused the same way", async () => {
    // The invariant stated directly: malformed must not be a softer outcome.
    personaDrivesOneTurn();
    await startJourneyRun(
      twoTargetOpts(
        {
          harness: "claude-code",
          mcpProfile: {
            extensions: {
              "com.mcpjam/enterprise-managed-auth": { idp: "mcpjam" },
            },
          } as never,
        },
        {
          harness: "claude-code",
          mcpProfile: {
            extensions: {
              "com.mcpjam/enterprise-managed-auth": { idp: "nope" },
            },
          } as never,
        }
      )
    );

    const terminals = terminalReports();
    expect(terminals).toHaveLength(2);
    for (const t of terminals) {
      // Same status AND same error code for both — a malformed policy is not a
      // different KIND of outcome from a valid one, which is what it was while
      // the read could throw.
      expect(t.status).toBe("failed");
      expect(t.errorCode).toBe("session_failed");
      expect(String(t.errorMessage)).toMatch(/enterprise-managed/i);
    }
    expect(provisionJourneySandboxMock).not.toHaveBeenCalled();
  });
});
