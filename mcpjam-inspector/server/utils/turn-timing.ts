import type { HarnessTurnEventSink } from "./harness/harness-turn-event.js";

/**
 * Where one chat turn's time goes before the model's first text reaches the
 * browser, on a monotonic clock from the moment the route starts the turn.
 *
 * The route closes each stage as it finishes. The stages that end before the
 * response headers also go out as `Server-Timing`, so the browser's own trace
 * shows them; the harness adds them, with the time to the first text it
 * forwards, to its per-turn `[harness][timing]` line, and sends its closing
 * event to the route's `harnessTurnEvent` sink.
 */
export const TURN_TIMING_STAGES = [
  "setup",
  "turnAuthorization",
  "connections",
  "tools",
  "streamPreparation",
] as const;

/** Each stage's `<stage>Ms` field is declared on `harness.timing` (`log-events.ts`). */
export type TurnTimingStage = (typeof TURN_TIMING_STAGES)[number];

export class TurnTiming {
  /** Where a harness turn on this request sends `harness_turn_completed`. */
  readonly harnessTurnEvent: HarnessTurnEventSink | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private previous: number;
  private readonly stages: Array<[TurnTimingStage, number]> = [];
  private firstTextAfter: number | undefined;
  private boxAcquiredIn: number | undefined;

  constructor(
    options: {
      harnessTurnEvent?: HarnessTurnEventSink;
      now?: () => number;
    } = {},
  ) {
    this.harnessTurnEvent = options.harnessTurnEvent;
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.previous = this.startedAt;
  }

  /** Close `stage`: it ran from the previous mark (or the start) until now. */
  mark(stage: TurnTimingStage): void {
    const at = this.now();
    this.stages.push([stage, at - this.previous]);
    this.previous = at;
  }

  /** The first model text handed to the client stream; later calls keep it. */
  markFirstText(): void {
    this.firstTextAfter ??= this.now() - this.startedAt;
  }

  /**
   * Run `acquire`, the route's acquisition of the box a harness turn runs on
   * (creating or waking it), and keep how long it took. The box is held
   * before the turn starts, so the turn adds this to the wake it measures
   * itself (`box_wake_ms`). It is not a stage: the stage it ran in keeps it.
   */
  async timeBoxAcquisition<T>(acquire: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await acquire();
    } finally {
      this.boxAcquiredIn = this.now() - startedAt;
    }
  }

  /** Whole milliseconds the route spent acquiring the turn's box, if it did. */
  boxAcquisitionMs(): number | undefined {
    return this.boxAcquiredIn === undefined
      ? undefined
      : Math.round(this.boxAcquiredIn);
  }

  /** The `Server-Timing` header value for the stages closed so far. */
  serverTiming(): string {
    return this.stages
      .map(([stage, ms]) => `${stage};dur=${ms.toFixed(1)}`)
      .join(", ");
  }

  /** Whole milliseconds per stage, and `firstTextMs` once text has gone out. */
  fields(): Record<string, number> {
    const fields: Record<string, number> = {};
    for (const [stage, ms] of this.stages) {
      fields[`${stage}Ms`] = Math.round(ms);
    }
    if (this.firstTextAfter !== undefined) {
      fields.firstTextMs = Math.round(this.firstTextAfter);
    }
    return fields;
  }

  /** The same fields inlined for a log message (` setupMs=12 …`). */
  text(): string {
    return Object.entries(this.fields())
      .map(([name, ms]) => ` ${name}=${ms}`)
      .join("");
  }
}
