/**
 * `harness_turn_completed`: one analytics event per harness turn, sent when
 * the turn's response closes (its fields are in `shared/harness-turn-event.ts`).
 *
 * Built from what the turn already measures, as it learns it: the stage marks
 * of its `[harness][timing]` line, the lane claim's state version, how its
 * session started, the warm attach's answer and the bootstrap observation.
 * The route's `TurnTiming` supplies `first_text_ms`, the time the route spent
 * acquiring the turn's box before the turn started, and the sink: a turn
 * with none (an eval, a swarm) sends nothing.
 *
 * Content-free by construction: closed vocabularies, the harness id and whole
 * milliseconds, plus the verified organization id the route's sink adds. A
 * refused reuse reports which step refused, never the error it threw.
 */
import type { Context } from "hono";
import type { HarnessResetReason } from "@/shared/harness-session";
import type {
  HarnessTurnBootstrap,
  HarnessTurnDuration,
  HarnessTurnEventProperties,
  HarnessTurnFallbackReason,
  HarnessTurnStart,
} from "@/shared/harness-turn-event";
import { captureServerEvent } from "../analytics.js";
import { logger } from "../logger.js";
import type { TurnTiming } from "../turn-timing.js";
import type { HarnessBootstrapOutcome } from "./harness-bake-observer.js";
import type { HarnessId } from "./registry.js";
import type { WarmAttachOutcome } from "./warm-bridge-runtime.js";

/** Where a route sends its harness turns' events. */
export interface HarnessTurnEventSink {
  /** The route's surface; a turn that ran on the person's machine reports `local`. */
  readonly surface: "web" | "api";
  capture(event: HarnessTurnEventProperties): void;
}

/**
 * The sink a chat route installs. The event is attributed like the route's
 * other server events (`captureServerEvent`), and carries the organization a
 * server-side check verified for the request, when there is one: read when the
 * turn closes, after the route's own checks have run.
 */
export function harnessTurnEventSink(
  c: Context,
  surface: HarnessTurnEventSink["surface"],
): HarnessTurnEventSink {
  return {
    surface,
    capture(event) {
      const organizationId = c.var.requestLogContext?.orgId;
      captureServerEvent(c, "harness_turn_completed", {
        ...event,
        ...(organizationId ? { organization_id: organizationId } : {}),
      });
    },
  };
}

/** The `[harness][timing]` line's marks, in the order a turn reaches them. */
export type HarnessTurnStage =
  "start" | "claim" | "box" | "broker" | "connect" | "dispatch" | "stream";

const RESET_FALLBACK: Record<HarnessResetReason, HarnessTurnFallbackReason> = {
  "runtime-changed": "configuration_changed",
  "sandbox-replaced": "sandbox_replaced",
  "resume-failed": "resume_failed",
  // Still resumes from saved files: nothing was refused.
  "legacy-cold-resume": "none",
};

const BOOTSTRAP: Record<HarnessBootstrapOutcome, HarnessTurnBootstrap> = {
  baked: "baked",
  installed: "installed",
  "install-failed": "install_failed",
  reused: "reused",
  none: "unknown",
};

/** One turn's event: recorded as the turn runs, sent once when it closes. */
export class HarnessTurnRecord {
  private readonly marks = new Map<HarnessTurnStage, number>();
  private lane: Pick<HarnessTurnEventProperties, "kind"> | undefined;
  private session:
    Pick<HarnessTurnEventProperties, "start" | "fallback_reason"> | undefined;
  private warm: WarmAttachOutcome | undefined;
  private sent = false;

  constructor(
    private readonly timing: TurnTiming | undefined,
    private readonly harnessId: HarnessId,
    /** The turn ran on the person's machine: there is no box or broker. */
    private readonly local: boolean,
  ) {}

  /** `Date.now()`, kept as the end of `stage`. */
  mark(stage: HarnessTurnStage): number {
    const at = Date.now();
    this.marks.set(stage, at);
    return at;
  }

  /** The lane is claimed. Its state version moves only when a turn commits. */
  claimed(stateVersion: number): number {
    this.lane = { kind: stateVersion > 0 ? "follow_up" : "first" };
    return this.mark("claim");
  }

  /** The warm runtime's answer, which comes before the session starts. */
  readonly warmAttach = (outcome: WarmAttachOutcome): void => {
    this.warm = outcome;
  };

  /**
   * The session started. `resetReason` is the reset the turn showed the
   * person; without one, a warm attach that fell back says why.
   */
  sessionStarted(session: {
    approval: boolean;
    resumed: boolean;
    resetReason: HarnessResetReason | undefined;
  }): number {
    let start: HarnessTurnStart = "new";
    if (session.approval) start = "approval_continuation";
    else if (session.resumed)
      start = this.warm === "attached" ? "warm" : "disk_resume";
    let fallback: HarnessTurnFallbackReason = "none";
    if (session.resetReason) fallback = RESET_FALLBACK[session.resetReason];
    else if (this.warm && this.warm !== "attached") fallback = this.warm;
    this.session = { start, fallback_reason: fallback };
    return this.mark("connect");
  }

  /** Send the event, once, however often the turn's teardown closes it. */
  close(turn: {
    aborted: boolean;
    completed: boolean;
    bootstrap: HarnessBootstrapOutcome | undefined;
  }): void {
    const sink = this.timing?.harnessTurnEvent;
    if (this.sent || !sink) return;
    this.sent = true;
    const event: HarnessTurnEventProperties = {
      surface: this.local ? "local" : sink.surface,
      harness_id: this.harnessId,
      outcome: turn.aborted
        ? "aborted"
        : turn.completed
          ? "completed"
          : "failed",
      bootstrap: turn.bootstrap ? BOOTSTRAP[turn.bootstrap] : "unknown",
      ...this.lane,
      ...this.session,
    };
    for (const [field, ms] of this.durations()) {
      if (ms !== undefined) event[field] = ms;
    }
    try {
      sink.capture(event);
    } catch (error) {
      // The turn's outcome is settled; its analytics must not change it.
      logger.warn("[harness] turn event was not captured", {
        harnessId: this.harnessId,
        error,
      });
    }
  }

  /**
   * As the `[harness][timing]` line computes them, for the stages reached.
   * The box's wake also counts the route acquiring it before the turn began.
   */
  private durations(): Array<[HarnessTurnDuration, number | undefined]> {
    const between = (from: HarnessTurnStage, to: HarnessTurnStage) => {
      const begin = this.marks.get(from);
      const end = this.marks.get(to);
      return begin === undefined || end === undefined || end < begin
        ? undefined
        : end - begin;
    };
    const acquired = this.timing?.boxAcquisitionMs();
    const woken = between("claim", "box");
    const boxWake = acquired === undefined ? woken : acquired + (woken ?? 0);
    return [
      ["first_text_ms", this.timing?.fields().firstTextMs],
      ["claim_ms", between("start", "claim")],
      ["box_wake_ms", this.local ? undefined : boxWake],
      ["broker_start_ms", this.local ? undefined : between("box", "broker")],
      ["local_prepare_ms", this.local ? between("claim", "box") : undefined],
      ["session_connect_ms", between("broker", "connect")],
      ["dispatch_setup_ms", between("start", "dispatch")],
      ["model_stream_ms", between("connect", "stream")],
    ];
  }
}
