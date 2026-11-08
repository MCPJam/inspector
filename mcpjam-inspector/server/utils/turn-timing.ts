/**
 * Where one chat turn's time goes before the model's first text reaches the
 * browser, on a monotonic clock from the moment the route starts the turn.
 *
 * The route closes each stage as it finishes. The stages that end before the
 * response headers also go out as `Server-Timing`, so the browser's own trace
 * shows them; the harness adds them, with the time to the first text it
 * forwards, to its per-turn `[harness][timing]` line.
 */
export type TurnTimingStage =
  "setup" | "turnAuthorization" | "connections" | "tools" | "streamPreparation";

export class TurnTiming {
  private readonly startedAt: number;
  private previous: number;
  private readonly stages: Array<[TurnTimingStage, number]> = [];
  private firstTextAfter: number | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
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
