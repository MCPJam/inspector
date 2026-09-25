/**
 * `getHostedTurnFailure` is the gate evals and swarms share for "did this
 * hosted turn fail". It used to key on the ABSENCE of a turn trace, which was
 * only ever correct because a turn that ended badly was excluded from
 * persistence and therefore produced no trace.
 *
 * That inference breaks in BOTH directions once failed turns are recorded: a
 * failure now carries a trace (so absence stops marking it), and a cancellation
 * carries one too (and a cancellation is not a failure — somebody asked for
 * it). These tests pin the new order: the record first, the old heuristics only
 * for callers without one.
 */
import { describe, expect, it } from "vitest";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type {
  TimeoutMetadata,
  TurnCancellationSource,
  TurnOutcomeRecord,
} from "@/shared/turn-outcome";
import { getHostedTurnFailure } from "../hosted-turn-failure";

/**
 * PER-VARIANT builders, not one `Partial<TurnOutcomeRecord>` spread.
 *
 * `TurnOutcomeRecord` is a discriminated union, so a single builder taking a
 * partial and spreading it is exactly the shape the union exists to rule out:
 * it can produce a `timed_out` with no clock. Each helper below asks for the
 * legs its own lifecycle requires, so a test cannot construct a record the
 * parser would refuse.
 */
const base = {
  contractVersion: 1,
  runtime: { engine: "emulated", modelAccess: "hosted" },
  recordedAt: 1_750_000_000_000,
} as const;

const completedRecord = (
  extra: { finishReason?: string } = {},
): TurnOutcomeRecord => ({ ...base, lifecycle: "completed", ...extra });

const failedRecord = (
  termination: NonNullable<
    Extract<TurnOutcomeRecord, { lifecycle: "failed" }>["termination"]
  > = {},
): TurnOutcomeRecord => ({ ...base, lifecycle: "failed", termination });

const timedOutRecord = (
  timeout: TimeoutMetadata = { clock: "turn", budgetMs: 1000, elapsedMs: 1000 },
): TurnOutcomeRecord => ({
  ...base,
  lifecycle: "timed_out",
  termination: { timeout },
});

const cancelledRecord = (
  cancellationSource: TurnCancellationSource = "caller",
): TurnOutcomeRecord => ({
  ...base,
  lifecycle: "cancelled",
  termination: { cancellationSource },
});

const okSpan: EvalTraceSpan = {
  id: "s1",
  name: "LLM",
  category: "llm",
  startMs: 0,
  endMs: 1,
  status: "ok",
};

describe("getHostedTurnFailure keys on the record's lifecycle", () => {
  it("A SETUP FAILURE WITH ZERO ERROR SPANS is still reported as failed", () => {
    // The row this whole reordering exists for. Saving failed turns without
    // changing this gate would have made a setup failure — which never reached
    // the model and so recorded no error span — read as a clean success, with
    // a trace present and a message in history.
    const failure = getHostedTurnFailure({
      outcome: failedRecord({
        errorSource: "setup",
        errorCode: "MCP_CONNECT_FAILED",
      }),
      turnTrace: { spans: [okSpan] },
      newMessageCount: 2,
    });
    expect(failure).toBe(
      "Turn failed before the model was invoked (MCP_CONNECT_FAILED)",
    );
  });

  it("a timed-out turn names its clock and budget", () => {
    expect(
      getHostedTurnFailure({
        outcome: timedOutRecord({
          clock: "turn",
          budgetMs: 360_000,
          elapsedMs: 360_412,
        }),
        turnTrace: { spans: [okSpan] },
        newMessageCount: 1,
      }),
    ).toBe("Turn exceeded its turn budget of 360000ms (elapsed 360412ms)");
  });

  it("a mid-stream failure is attributed to the stream, with its code", () => {
    expect(
      getHostedTurnFailure({
        outcome: failedRecord({
          errorSource: "model",
          errorCode: "UPSTREAM_ERROR",
        }),
        turnTrace: { spans: [okSpan] },
        newMessageCount: 1,
      }),
    ).toBe("Backend stream failed during iteration (UPSTREAM_ERROR)");
  });

  it("A CANCELLED TURN IS NOT A FAILURE, even with a trace and no messages", () => {
    // Routing a stop through the failure path would record a verdict for a run
    // the user ended. Cancellation policy belongs to the caller, not here.
    expect(
      getHostedTurnFailure({
        outcome: cancelledRecord("client_disconnect"),
        turnTrace: { spans: [] },
        newMessageCount: 0,
      }),
    ).toBeNull();
  });

  it("a cancelled turn with NO trace is still not a failure", () => {
    expect(
      getHostedTurnFailure({
        outcome: cancelledRecord("lease_lost"),
        turnTrace: undefined,
        newMessageCount: 0,
      }),
    ).toBeNull();
  });

  it("a paused turn is not a failure", () => {
    expect(
      getHostedTurnFailure({
        outcome: {
          ...base,
          lifecycle: "paused" as const,
          paused: { kind: "tool_approval" as const },
        },
        turnTrace: { spans: [okSpan] },
        newMessageCount: 1,
      }),
    ).toBeNull();
  });

  it("a completed turn still fails the empty-content check", () => {
    // The content checks are not superseded by the record; a turn can complete
    // and produce nothing.
    expect(
      getHostedTurnFailure({
        outcome: completedRecord(),
        turnTrace: { spans: [okSpan] },
        newMessageCount: 0,
      }),
    ).toBe("Backend step returned no content (stream error or empty response)");
  });

  it("a completed turn with content and no error spans passes", () => {
    expect(
      getHostedTurnFailure({
        outcome: completedRecord(),
        turnTrace: { spans: [okSpan] },
        newMessageCount: 2,
      }),
    ).toBeNull();
  });

  it("A COMPLETED TURN WITH NO TRACE is not an engine failure", () => {
    // The trace-absence branch is guarded on the RECORD's absence, not merely
    // unreachable beside one. A turn can be recorded and still write no trace:
    // the terminal-recording switch being off produces exactly this pair, and
    // reading it as a caught engine error would manufacture a failure out of a
    // switch position.
    expect(
      getHostedTurnFailure({
        outcome: completedRecord(),
        turnTrace: undefined,
        newMessageCount: 2,
      }),
    ).toBeNull();
  });

  it("a paused turn with no trace is not an engine failure either", () => {
    expect(
      getHostedTurnFailure({
        outcome: {
          ...base,
          lifecycle: "paused" as const,
          paused: { kind: "tool_approval" as const },
        },
        turnTrace: undefined,
        newMessageCount: 1,
      }),
    ).toBeNull();
  });

  it("but a recorded turn with no trace AND no content still fails that check", () => {
    // The content check runs before the trace is walked, so losing the
    // trace-absence branch does not lose the empty-reply one with it.
    expect(
      getHostedTurnFailure({
        outcome: completedRecord(),
        turnTrace: undefined,
        newMessageCount: 0,
      }),
    ).toBe("Backend step returned no content (stream error or empty response)");
  });
});

describe("without a record, the old heuristics still apply", () => {
  it("trace absence marks a failure for callers with no record", () => {
    expect(
      getHostedTurnFailure({ turnTrace: undefined, newMessageCount: 1 }),
    ).toBe(
      "Backend stream failed during iteration (engine caught an error mid-turn)",
    );
  });

  it("an error span that is not tool evidence marks a failure", () => {
    expect(
      getHostedTurnFailure({
        turnTrace: {
          spans: [
            { ...okSpan, id: "s2", name: "step", category: "step", status: "error" },
          ],
        },
        newMessageCount: 1,
      }),
    ).toBe("Backend step failed mid-turn: step");
  });

  it("a TOOL error span is left to the caller's tool-error policy", () => {
    expect(
      getHostedTurnFailure({
        turnTrace: {
          spans: [
            {
              ...okSpan,
              id: "s3",
              name: "tool",
              category: "tool",
              status: "error",
            },
          ],
        },
        newMessageCount: 1,
      }),
    ).toBeNull();
  });
});
