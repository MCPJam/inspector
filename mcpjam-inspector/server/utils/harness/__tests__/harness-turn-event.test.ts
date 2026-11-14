/**
 * `harness_turn_completed`, the one analytics event a harness turn sends when
 * its response closes: what each field reports for each path a turn can take,
 * that it is sent once, and that it carries nothing but closed vocabularies,
 * whole milliseconds and a verified organization id.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { Hono } from "hono";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../../analytics.js", () => ({ captureServerEvent: capture }));

import {
  HARNESS_TURN_BOOTSTRAPS,
  HARNESS_TURN_DURATIONS,
  HARNESS_TURN_FALLBACK_REASONS,
  HARNESS_TURN_KINDS,
  HARNESS_TURN_OUTCOMES,
  HARNESS_TURN_STARTS,
  HARNESS_TURN_SURFACES,
  type HarnessTurnEventProperties,
} from "@/shared/harness-turn-event";
import type { HarnessResetReason } from "@/shared/harness-session";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import { logConvexId } from "../../log-convex-id.js";
import { logger } from "../../logger.js";
import { setRequestLogContext } from "../../request-logger.js";
import { TurnTiming } from "../../turn-timing.js";
import type { HarnessBootstrapOutcome } from "../harness-bake-observer.js";
import {
  HarnessTurnRecord,
  harnessTurnEventSink,
  type HarnessTurnEventSink,
  type KeptRuntimeOutcome,
} from "../harness-turn-event.js";
import type { WarmAttachOutcome } from "../warm-bridge-runtime.js";

type Sink = HarnessTurnEventSink & {
  capture: Mock<HarnessTurnEventSink["capture"]>;
};
const captured = () => vi.fn<HarnessTurnEventSink["capture"]>();

function setup(
  options: { surface?: "web" | "api"; local?: boolean; now?: () => number } = {},
) {
  const sink: Sink = { surface: options.surface ?? "web", capture: captured() };
  const timing = new TurnTiming({
    harnessTurnEvent: sink,
    ...(options.now ? { now: options.now } : {}),
  });
  const turn = new HarnessTurnRecord(
    timing,
    "claude-code",
    Boolean(options.local),
  );
  return { sink, timing, turn };
}

function sent(sink: Sink): HarnessTurnEventProperties {
  expect(sink.capture).toHaveBeenCalledTimes(1);
  return sink.capture.mock.calls[0]![0];
}

const completed = {
  aborted: false,
  completed: true,
  bootstrap: "baked" as const,
};

/** A turn that reached its session, through the fields that decide `start`. */
function startSession(args: {
  stateVersion?: number;
  approval?: boolean;
  resumed?: boolean;
  resetReason?: HarnessResetReason;
  warm?: WarmAttachOutcome;
  kept?: KeptRuntimeOutcome;
  surface?: "web" | "api";
  local?: boolean;
}) {
  const { sink, turn } = setup(args);
  turn.mark("start");
  turn.claimed(args.stateVersion ?? 1);
  turn.mark("box");
  turn.mark("broker");
  if (args.warm) turn.warmAttach(args.warm);
  if (args.kept) turn.keptRuntime(args.kept);
  turn.sessionStarted({
    approval: args.approval ?? false,
    resumed: args.resumed ?? false,
    resetReason: args.resetReason,
  });
  return { sink, turn };
}

/** Why a local turn can refuse the runtime its last turn kept. */
const KEPT_REFUSALS = [
  "configuration_changed",
  "superseded",
  "lifetime",
  "process_died",
  "runtime_update",
  "authorization_revoked",
  "renewal_failed",
  "idle_expired",
  "evicted",
  "shutdown",
  "switched_off",
] as const satisfies readonly KeptRuntimeOutcome[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("harness_turn_completed: one per turn", () => {
  it("is sent once, however often the turn's teardown closes it", () => {
    const { sink, turn } = startSession({});
    turn.close(completed);
    turn.close({ aborted: true, completed: false, bootstrap: undefined });
    expect(sent(sink)).toMatchObject({ outcome: "completed" });
  });

  it("is not sent for a turn whose route installed no sink (an eval, a swarm)", () => {
    const warn = vi.spyOn(logger, "warn");
    const quiet = new HarnessTurnRecord(new TurnTiming(), "codex", false);
    quiet.mark("start");
    expect(() => quiet.close(completed)).not.toThrow();
    const none = new HarnessTurnRecord(undefined, "codex", false);
    expect(() => none.close(completed)).not.toThrow();
    expect(capture).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not change the turn when the sink fails to capture", () => {
    const warn = vi.spyOn(logger, "warn");
    const { sink, turn } = startSession({});
    sink.capture.mockImplementation(() => {
      throw new Error("posthog unavailable");
    });
    expect(() => turn.close(completed)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[harness] turn event was not captured", {
      harnessId: "claude-code",
      error: expect.any(Error),
    });
  });
});

describe("harness_turn_completed: timings", () => {
  it("reports the stages the [harness][timing] line reports, in whole milliseconds", () => {
    const { sink, turn } = setup();
    turn.mark("start");
    vi.advanceTimersByTime(300);
    turn.claimed(1);
    vi.advanceTimersByTime(1_200);
    turn.mark("box");
    vi.advanceTimersByTime(1_100);
    turn.mark("broker");
    vi.advanceTimersByTime(400);
    turn.sessionStarted({
      approval: false,
      resumed: true,
      resetReason: undefined,
    });
    vi.advanceTimersByTime(100);
    turn.mark("dispatch");
    vi.advanceTimersByTime(4_800);
    turn.mark("stream");
    turn.close(completed);
    expect(sent(sink)).toMatchObject({
      claim_ms: 300,
      box_wake_ms: 1_200,
      broker_start_ms: 1_100,
      session_connect_ms: 400,
      dispatch_setup_ms: 3_100,
      model_stream_ms: 4_900,
    });
  });

  it("leaves out the stages a failed turn never finished, and how it never started", () => {
    const { sink, turn } = setup();
    turn.mark("start");
    vi.advanceTimersByTime(250);
    turn.claimed(0);
    turn.close({ aborted: false, completed: false, bootstrap: undefined });
    expect(sent(sink)).toEqual({
      surface: "web",
      harness_id: "claude-code",
      outcome: "failed",
      bootstrap: "unknown",
      kind: "first",
      claim_ms: 250,
    });
  });

  it("reports a local turn's box window as local preparation, and its surface as local", () => {
    const { sink, turn } = setup({ local: true });
    turn.mark("start");
    turn.claimed(1);
    vi.advanceTimersByTime(900);
    turn.mark("box");
    turn.mark("broker");
    turn.sessionStarted({
      approval: false,
      resumed: true,
      resetReason: undefined,
    });
    turn.close(completed);
    const event = sent(sink);
    expect(event).toMatchObject({ surface: "local", local_prepare_ms: 900 });
    expect(event).not.toHaveProperty("box_wake_ms");
    expect(event).not.toHaveProperty("broker_start_ms");
  });

  it("adds the route's acquisition of the box to its wake, and leaves every other stage as it was", async () => {
    let now = 0;
    const { sink, timing, turn } = setup({ now: () => now });
    // The route created or woke the conversation's box before the turn began.
    await timing.timeBoxAcquisition(async () => {
      now += 2_000;
    });
    turn.mark("start");
    vi.advanceTimersByTime(300);
    turn.claimed(1);
    vi.advanceTimersByTime(15);
    turn.mark("box");
    vi.advanceTimersByTime(1_100);
    turn.mark("broker");
    vi.advanceTimersByTime(400);
    turn.sessionStarted({
      approval: false,
      resumed: true,
      resetReason: undefined,
    });
    vi.advanceTimersByTime(100);
    turn.mark("dispatch");
    vi.advanceTimersByTime(4_800);
    turn.mark("stream");
    turn.close(completed);
    expect(sent(sink)).toMatchObject({
      claim_ms: 300,
      box_wake_ms: 2_015,
      broker_start_ms: 1_100,
      session_connect_ms: 400,
      dispatch_setup_ms: 1_915,
      model_stream_ms: 4_900,
    });
  });

  it("reports the route's acquisition as the box wake of a turn that never reached its box", async () => {
    let now = 0;
    const { sink, timing, turn } = setup({ now: () => now });
    await timing.timeBoxAcquisition(async () => {
      now += 1_250;
    });
    turn.mark("start");
    vi.advanceTimersByTime(250);
    turn.claimed(0);
    turn.close({ aborted: false, completed: false, bootstrap: undefined });
    expect(sent(sink)).toMatchObject({ claim_ms: 250, box_wake_ms: 1_250 });
  });

  it("sends no box wake from a local turn, whatever its recorder holds", async () => {
    let now = 0;
    const { sink, timing, turn } = setup({ local: true, now: () => now });
    await timing.timeBoxAcquisition(async () => {
      now += 1_250;
    });
    turn.mark("start");
    turn.claimed(1);
    vi.advanceTimersByTime(900);
    turn.mark("box");
    turn.close(completed);
    const event = sent(sink);
    expect(event).toMatchObject({ surface: "local", local_prepare_ms: 900 });
    expect(event).not.toHaveProperty("box_wake_ms");
  });

  it("takes first_text_ms from the route's recorder, from the start of the request", () => {
    let now = 0;
    const sink: Sink = { surface: "api", capture: captured() };
    const timing = new TurnTiming({ harnessTurnEvent: sink, now: () => now });
    const turn = new HarnessTurnRecord(timing, "codex", false);
    now = 2_480.4;
    timing.markFirstText();
    turn.close(completed);
    expect(sent(sink)).toMatchObject({ surface: "api", first_text_ms: 2_480 });
  });
});

describe("harness_turn_completed: closed vocabularies", () => {
  it.each([
    [0, "first"],
    [1, "follow_up"],
    [12, "follow_up"],
  ] as const)(
    "a lane at state version %i is a %s turn",
    (stateVersion, kind) => {
      const { sink, turn } = startSession({ stateVersion });
      turn.close(completed);
      expect(sent(sink).kind).toBe(kind);
    },
  );

  it.each<[string, Parameters<typeof startSession>[0], string, string]>([
    ["a first session", {}, "new", "none"],
    ["saved files", { resumed: true }, "disk_resume", "none"],
    ["a warm re-attach", { resumed: true, warm: "attached" }, "warm", "none"],
    [
      "a refused probe",
      { resumed: true, warm: "probe_refused" },
      "disk_resume",
      "probe_refused",
    ],
    [
      "an attach that threw",
      { resumed: true, warm: "attach_failed" },
      "disk_resume",
      "attach_failed",
    ],
    [
      "an attach out of time",
      { resumed: true, warm: "attach_timeout" },
      "disk_resume",
      "attach_timeout",
    ],
    [
      "an approval decision",
      { approval: true, resumed: true },
      "approval_continuation",
      "none",
    ],
    [
      "a changed runtime",
      { resetReason: "runtime-changed" },
      "new",
      "configuration_changed",
    ],
    [
      "a replaced box",
      { resetReason: "sandbox-replaced" },
      "new",
      "sandbox_replaced",
    ],
    [
      "a resume that failed after a refused probe",
      { resetReason: "resume-failed", warm: "probe_refused" },
      "new",
      "resume_failed",
    ],
    [
      "a pre-detach session",
      { resumed: true, resetReason: "legacy-cold-resume" },
      "disk_resume",
      "none",
    ],
  ])("%s starts as %s with fallback %s", (_label, args, start, fallback) => {
    const { sink, turn } = startSession(args);
    turn.close(completed);
    expect(sent(sink)).toMatchObject({ start, fallback_reason: fallback });
  });

  it("reports an adopted kept local runtime as a warm start on this machine", () => {
    const { sink, turn } = startSession({
      local: true,
      resumed: true,
      kept: "adopted",
    });
    turn.close(completed);
    expect(sent(sink)).toMatchObject({
      surface: "local",
      start: "warm",
      fallback_reason: "none",
    });
  });

  it.each(KEPT_REFUSALS)(
    "a local turn that did not adopt its kept runtime says why: %s",
    (reason) => {
      const { sink, turn } = startSession({
        local: true,
        resumed: true,
        kept: reason,
      });
      turn.close(completed);
      expect(sent(sink)).toMatchObject({
        surface: "local",
        start: "disk_resume",
        fallback_reason: reason,
      });
    },
  );

  it.each<[string, { warm?: WarmAttachOutcome; kept?: KeptRuntimeOutcome }, string]>([
    ["a kept local runtime", { kept: "authorization_revoked" }, "authorization_revoked"],
    ["a warm bridge", { warm: "probe_refused" }, "probe_refused"],
  ])(
    "still says why it refused %s when the turn then failed before its session",
    (_label, reuse, fallback) => {
      const { sink, turn } = setup({ local: reuse.kept !== undefined });
      turn.mark("start");
      turn.claimed(1);
      if (reuse.warm) turn.warmAttach(reuse.warm);
      if (reuse.kept) turn.keptRuntime(reuse.kept);
      turn.close({ aborted: false, completed: false, bootstrap: undefined });
      const event = sent(sink);
      expect(event).toMatchObject({ outcome: "failed", fallback_reason: fallback });
      expect(event).not.toHaveProperty("start");
    },
  );

  it("sends no fallback for a runtime it adopted when the turn failed before its session", () => {
    const { sink, turn } = setup({ local: true });
    turn.mark("start");
    turn.claimed(1);
    turn.keptRuntime("adopted");
    turn.close({ aborted: false, completed: false, bootstrap: undefined });
    const event = sent(sink);
    expect(event).not.toHaveProperty("fallback_reason");
    expect(event).not.toHaveProperty("start");
  });

  it("lets the lane's reset say why a local turn started fresh, over its kept runtime's refusal", () => {
    const { sink, turn } = startSession({
      local: true,
      resetReason: "runtime-changed",
      kept: "process_died",
    });
    turn.close(completed);
    expect(sent(sink)).toMatchObject({
      start: "new",
      fallback_reason: "configuration_changed",
    });
  });

  it.each<[HarnessBootstrapOutcome | undefined, string]>([
    ["baked", "baked"],
    ["installed", "installed"],
    ["install-failed", "install_failed"],
    ["reused", "reused"],
    ["none", "unknown"],
    [undefined, "unknown"],
  ])("bootstrap %s reports %s", (bootstrap, reported) => {
    const { sink, turn } = startSession({});
    turn.close({ aborted: false, completed: true, bootstrap });
    expect(sent(sink).bootstrap).toBe(reported);
  });

  it.each([
    [{ aborted: true, completed: true }, "aborted"],
    [{ aborted: true, completed: false }, "aborted"],
    [{ aborted: false, completed: true }, "completed"],
    [{ aborted: false, completed: false }, "failed"],
  ] as const)("%o is %s", (turnState, outcome) => {
    const { sink, turn } = startSession({});
    turn.close({ ...turnState, bootstrap: undefined });
    expect(sent(sink).outcome).toBe(outcome);
  });

  it("only ever sends listed values, across every path", () => {
    const vocabulary: Record<string, readonly string[]> = {
      surface: HARNESS_TURN_SURFACES,
      kind: HARNESS_TURN_KINDS,
      start: HARNESS_TURN_STARTS,
      fallback_reason: HARNESS_TURN_FALLBACK_REASONS,
      bootstrap: HARNESS_TURN_BOOTSTRAPS,
      outcome: HARNESS_TURN_OUTCOMES,
      harness_id: ["claude-code"],
    };
    const fields = new Set([
      ...Object.keys(vocabulary),
      ...HARNESS_TURN_DURATIONS,
    ]);
    const seen = new Map<string, Set<unknown>>();
    // A hosted turn's warm attach, or a local turn's kept runtime.
    const reuses: Array<{
      warm?: WarmAttachOutcome;
      kept?: KeptRuntimeOutcome;
    }> = [
      {},
      ...(
        ["attached", "probe_refused", "attach_failed", "attach_timeout"] as const
      ).map((warm) => ({ warm })),
      ...(["adopted", ...KEPT_REFUSALS] as const).map((kept) => ({ kept })),
    ];
    const resets: Array<HarnessResetReason | undefined> = [
      undefined,
      "runtime-changed",
      "sandbox-replaced",
      "resume-failed",
      "legacy-cold-resume",
    ];
    for (const surface of ["web", "api"] as const)
      for (const local of [false, true])
        for (const approval of [false, true])
          for (const resumed of [false, true])
            for (const reuse of reuses)
              for (const resetReason of resets)
                for (const bootstrap of [
                  "baked",
                  "install-failed",
                  undefined,
                ] as const)
                  for (const aborted of [false, true]) {
                    const { sink, turn } = startSession({
                      surface,
                      local,
                      approval,
                      resumed,
                      ...reuse,
                      resetReason,
                    });
                    turn.close({ aborted, completed: !aborted, bootstrap });
                    const event = sent(sink);
                    for (const [field, value] of Object.entries(event)) {
                      expect(fields).toContain(field);
                      if (field in vocabulary)
                        expect(vocabulary[field]).toContain(value);
                      else
                        expect(
                          Number.isInteger(value) && Number(value) >= 0,
                        ).toBe(true);
                      seen.set(
                        field,
                        (seen.get(field) ?? new Set()).add(value),
                      );
                    }
                  }
    // Every value each path can produce came up.
    expect([...seen.get("start")!].sort()).toEqual(
      [...HARNESS_TURN_STARTS].sort(),
    );
    expect([...seen.get("fallback_reason")!].sort()).toEqual(
      [...HARNESS_TURN_FALLBACK_REASONS].sort(),
    );
    expect([...seen.get("surface")!].sort()).toEqual(
      [...HARNESS_TURN_SURFACES].sort(),
    );
  });
});

describe("harness_turn_completed: the route's sink", () => {
  const ORG = "k57d2gqxm9vbhw4e3n8r6tyf1c0sa2jz";

  async function sendThroughRoute(orgId: string | null) {
    const app = new Hono();
    app.use("*", requestLogContextMiddleware);
    app.post("/turn", (c) => {
      setRequestLogContext(c, { orgId: logConvexId(orgId) });
      const timing = new TurnTiming({
        harnessTurnEvent: harnessTurnEventSink(c, "web"),
      });
      const turn = new HarnessTurnRecord(timing, "codex", false);
      turn.close(completed);
      return c.text("ok");
    });
    await app.request("/turn", { method: "POST" });
    expect(capture).toHaveBeenCalledTimes(1);
    return capture.mock.calls[0]!;
  }

  it("attributes the event like the route's other server events, with the verified organization", async () => {
    const [context, name, properties] = await sendThroughRoute(ORG);
    expect(context.var.requestLogContext.orgId).toBe(ORG);
    expect(name).toBe("harness_turn_completed");
    expect(properties).toEqual({
      surface: "web",
      harness_id: "codex",
      outcome: "completed",
      bootstrap: "baked",
      organization_id: ORG,
    });
  });

  it("leaves the organization out when no check verified one", async () => {
    const [, , properties] = await sendThroughRoute(null);
    expect(properties).not.toHaveProperty("organization_id");
  });
});
