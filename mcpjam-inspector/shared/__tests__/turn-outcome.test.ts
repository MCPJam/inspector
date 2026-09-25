import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CURRENT_TURN_OUTCOME_CONTRACT_VERSION,
  DEADLINE_CLOCKS,
  TURN_CANCELLATION_SOURCES,
  TURN_ERROR_SOURCES,
  TURN_LIFECYCLES,
  TURN_MODEL_ACCESS,
  TURN_PAUSE_KINDS,
  TURN_RUNTIME_ENGINES,
  UNRESOLVED_TOOL_CALL_STATES,
  didTurnComplete,
  didTurnFail,
  isTurnUnfinished,
  needsToolCallClosure,
  parseTurnOutcomeRecord,
  turnOutcomeRecordZ,
  type TurnLifecycle,
  type TurnOutcomeRecord,
} from "../turn-outcome";

const __dirname = dirname(fileURLToPath(import.meta.url));
type FixtureRow = { label: string; value: Record<string, unknown> };
type Fixtures = { __readme: string; accept: FixtureRow[]; reject: FixtureRow[] };
const fixtures: Fixtures = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/turn-outcome-parity-fixtures.json"),
    "utf8",
  ),
);

/**
 * Builds WIRE-SHAPED input, deliberately untyped.
 *
 * These rows exist to be REFUSED, so they cannot be `Partial<TurnOutcomeRecord>`
 * — the record is a discriminated union now, and a partial of it cannot express
 * `timed_out` with no clock, which is the very thing several of these assert the
 * parser rejects. Anything reaching `/ingest-chat` is `unknown`; typing this
 * helper as a record would only be pretending otherwise.
 */
const base = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  contractVersion: CURRENT_TURN_OUTCOME_CONTRACT_VERSION,
  lifecycle: "completed",
  runtime: { engine: "emulated", modelAccess: "hosted" },
  recordedAt: 1_750_000_000_000,
  ...overrides,
});

describe("turn-outcome parity fixtures", () => {
  it("has rows on both sides", () => {
    expect(fixtures.accept.length).toBeGreaterThan(0);
    expect(fixtures.reject.length).toBeGreaterThan(0);
  });

  it.each(fixtures.accept.map((row) => [row.label, row.value] as const))(
    "accepts %s",
    (_label, value) => {
      const parsed = turnOutcomeRecordZ.safeParse(value);
      expect(parsed.success).toBe(true);
    },
  );

  it.each(fixtures.reject.map((row) => [row.label, row.value] as const))(
    "rejects %s",
    (_label, value) => {
      expect(turnOutcomeRecordZ.safeParse(value).success).toBe(false);
    },
  );
});

describe("turn-outcome vocabularies are closed and total", () => {
  // Totality, not a snapshot of today's spelling: adding a value to a
  // vocabulary without deciding what it means for the readers below is exactly
  // the drift these assertions exist to stop.
  it("lifecycle covers every value", () => {
    expect([...TURN_LIFECYCLES]).toEqual([
      "completed",
      "failed",
      "timed_out",
      "cancelled",
      "paused",
      "interrupted",
    ]);
  });

  it("cancellation sources name all four harness causes plus the caller", () => {
    expect([...TURN_CANCELLATION_SOURCES]).toEqual([
      "caller",
      "client_disconnect",
      "lease_lost",
      "liveness_lost",
      "reservation_lost",
    ]);
  });

  it("pause kinds, error sources, unresolved states, engines, access", () => {
    expect([...TURN_PAUSE_KINDS]).toEqual([
      "tool_approval",
      "scope_step_up",
      "client_fulfilled",
      "tool_input_required",
    ]);
    expect([...TURN_ERROR_SOURCES]).toEqual(["model", "setup"]);
    expect([...UNRESOLVED_TOOL_CALL_STATES]).toEqual([
      "never_started",
      "outcome_unknown",
    ]);
    expect([...TURN_RUNTIME_ENGINES]).toEqual(["emulated", "harness"]);
    expect([...TURN_MODEL_ACCESS]).toEqual(["hosted", "direct"]);
  });

  it("deadline clocks match the run-supervisor's closed set", () => {
    expect([...DEADLINE_CLOCKS]).toEqual([
      "run",
      "iteration",
      "session",
      "turn",
      "toolCall",
      "sandboxCapacity",
      "setup",
      "discovery",
    ]);
  });

  it("every lifecycle is classified by the readers — none falls through", () => {
    for (const lifecycle of TURN_LIFECYCLES) {
      const outcome = { lifecycle } as Pick<TurnOutcomeRecord, "lifecycle">;
      const classified =
        didTurnComplete(outcome) ||
        isTurnUnfinished(outcome) ||
        lifecycle === "paused";
      expect({ lifecycle, classified }).toEqual({ lifecycle, classified: true });
    }
  });
});

describe("turn-outcome invariants", () => {
  it("timed_out requires termination.timeout", () => {
    expect(
      turnOutcomeRecordZ.safeParse(base({ lifecycle: "timed_out" })).success,
    ).toBe(false);
    expect(
      turnOutcomeRecordZ.safeParse(
        base({
          lifecycle: "timed_out",
          termination: {
            timeout: { clock: "turn", budgetMs: 1000, elapsedMs: 1001 },
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("cancelled requires a cancellation source", () => {
    expect(
      turnOutcomeRecordZ.safeParse(base({ lifecycle: "cancelled" })).success,
    ).toBe(false);
    expect(
      turnOutcomeRecordZ.safeParse(
        base({
          lifecycle: "cancelled",
          termination: { cancellationSource: "lease_lost" },
        }),
      ).success,
    ).toBe(true);
  });

  it("paused requires a pause kind", () => {
    expect(
      turnOutcomeRecordZ.safeParse(base({ lifecycle: "paused" })).success,
    ).toBe(false);
    expect(
      turnOutcomeRecordZ.safeParse(
        base({ lifecycle: "paused", paused: { kind: "tool_approval" } }),
      ).success,
    ).toBe(true);
  });

  it("completed forbids a termination block", () => {
    expect(
      turnOutcomeRecordZ.safeParse(
        base({ lifecycle: "completed", termination: { errorCode: "x" } }),
      ).success,
    ).toBe(false);
  });

  it("A TIMEOUT ONLY BELONGS TO A timed_out TURN", () => {
    // Not a harmless extra field. Every reader keys off `lifecycle`, so a
    // `failed` record carrying a timeout has one half saying the turn ran out
    // of time and the other saying it did not — and whoever reads it answers
    // with whichever half they happened to look at.
    //
    // The timeout here is COMPLETE (`elapsedMs` included, which the contract
    // requires). A row missing a required field would be refused before the
    // invariant was ever consulted, and this test would pass without pinning
    // anything.
    expect(
      turnOutcomeRecordZ.safeParse(
        base({
          lifecycle: "failed",
          termination: {
            errorSource: "model",
            timeout: { clock: "turn", budgetMs: 1000, elapsedMs: 1001 },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("a cancellation source only belongs to a cancelled turn", () => {
    expect(
      turnOutcomeRecordZ.safeParse(
        base({
          lifecycle: "timed_out",
          termination: {
            timeout: { clock: "turn", budgetMs: 1000, elapsedMs: 1001 },
            cancellationSource: "caller",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("a pause kind only belongs to a paused turn", () => {
    expect(
      turnOutcomeRecordZ.safeParse(
        base({
          lifecycle: "cancelled",
          termination: { cancellationSource: "caller" },
          paused: { kind: "tool_approval" },
        }),
      ).success,
    ).toBe(false);
  });

  it("and the parity fixture's inverse rows reject ON THE INVARIANT, not on a typo", () => {
    // A reject row is only worth what its REASON is. Each of these is valid in
    // every other respect, so removing the one offending field must make it
    // parse — otherwise the row would pass this suite while pinning nothing,
    // and the backend mirror would be free to drift underneath it.
    const rows = fixtures.reject.filter((row) =>
      /did not call itself/.test(row.label),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(
        turnOutcomeRecordZ.safeParse(row.value).success,
        `${row.label} should be refused`,
      ).toBe(false);
      const stripped = JSON.parse(JSON.stringify(row.value)) as {
        termination?: Record<string, unknown>;
        paused?: unknown;
      };
      if (/timeout/.test(row.label)) delete stripped.termination?.timeout;
      if (/cancellation source/.test(row.label)) {
        delete stripped.termination?.cancellationSource;
      }
      if (/pause kind/.test(row.label)) delete stripped.paused;
      expect(
        turnOutcomeRecordZ.safeParse(stripped).success,
        `${row.label} should be VALID once the offending field is gone — if it ` +
          `is not, the row is rejected for some other reason and pins nothing`,
      ).toBe(true);
    }
  });

  it("and the NUMERIC reject rows reject on the number, not on the shape", () => {
    // Same discipline as the invariant rows above, for the constraints the
    // backend parser was found to be missing. These cannot be tested by
    // DELETING the offending field — `recordedAt` and the timeout legs are
    // required, so the row would then be refused for absence and pin nothing
    // again. So each is REPAIRED to a legal value instead, and must parse.
    const repairs: Array<[RegExp, (v: any) => void]> = [
      [/recordedAt/, (v) => void (v.recordedAt = 1750000000000)],
      [/budgetMs/, (v) => void (v.termination.timeout.budgetMs = 10)],
      [/elapsedMs/, (v) => void (v.termination.timeout.elapsedMs = 10)],
      [/errorHttpStatus/, (v) => void (v.termination.errorHttpStatus = 500)],
      [/superseded/, (v) =>
        void (v.termination.superseded[0].at = 1750000000000)],
    ];
    const rows = fixtures.reject.filter((row) =>
      /must be an INTEGER|must be NONNEGATIVE|HTTP range/.test(row.label),
    );
    // Guards against the set silently shrinking to nothing if labels change.
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      expect(
        turnOutcomeRecordZ.safeParse(row.value).success,
        `${row.label} should be refused`,
      ).toBe(false);
      const repaired = JSON.parse(JSON.stringify(row.value));
      const repair = repairs.find(([re]) => re.test(row.label));
      expect(repair, `no repair known for: ${row.label}`).toBeDefined();
      repair![1](repaired);
      expect(
        turnOutcomeRecordZ.safeParse(repaired).success,
        `${row.label} should be VALID once the number is legal — if it is ` +
          `not, the row is refused for some other reason and pins nothing`,
      ).toBe(true);
    }
  });

  it("but `superseded` stays valid under every lifecycle", () => {
    // A late mark arriving after the turn settled is diagnosis ABOUT the race,
    // not a second claim about the ending. Restricting it the same way would
    // throw away the only evidence that two marks contended.
    for (const lifecycle of ["completed", "failed", "cancelled"] as const) {
      const record = base({
        lifecycle,
        ...(lifecycle === "completed"
          ? {}
          : {
              termination: {
                superseded: [{ mark: "paused" as const, at: 1750000000000 }],
                ...(lifecycle === "cancelled"
                  ? { cancellationSource: "caller" as const }
                  : { errorSource: "model" as const }),
              },
            }),
      });
      expect(turnOutcomeRecordZ.safeParse(record).success).toBe(true);
    }
  });

  it("a paused turn may still name its harness while running emulated", () => {
    // The scope step-up continuation runs on the emulated engine by design.
    // Dropping the host id would make it indistinguishable from a plain turn.
    const parsed = parseTurnOutcomeRecord(
      base({
        lifecycle: "paused",
        paused: { kind: "scope_step_up" },
        runtime: {
          engine: "emulated",
          harness: "claude-code",
          modelAccess: "hosted",
        },
      }),
    );
    expect(parsed?.runtime).toEqual({
      engine: "emulated",
      harness: "claude-code",
      modelAccess: "hosted",
    });
  });
});

describe("turn-outcome readers", () => {
  const of = (lifecycle: TurnLifecycle) => ({ lifecycle });

  it("cancelled is not a failure — somebody asked for it", () => {
    expect(didTurnFail(of("cancelled"))).toBe(false);
    expect(didTurnFail(of("failed"))).toBe(true);
    expect(didTurnFail(of("timed_out"))).toBe(true);
    expect(didTurnFail(of("paused"))).toBe(false);
    expect(didTurnFail(of("completed"))).toBe(false);
  });

  it("an ABSENT record is never success and never failure", () => {
    expect(didTurnComplete(undefined)).toBe(false);
    expect(didTurnFail(undefined)).toBe(false);
    expect(isTurnUnfinished(undefined)).toBe(false);
    expect(needsToolCallClosure(undefined)).toBe(false);
  });

  it("closure skips paused turns — their dangling call is the resume handle", () => {
    expect(needsToolCallClosure(of("paused"))).toBe(false);
    expect(needsToolCallClosure(of("cancelled"))).toBe(true);
    expect(needsToolCallClosure(of("failed"))).toBe(true);
    expect(needsToolCallClosure(of("timed_out"))).toBe(true);
    expect(needsToolCallClosure(of("completed"))).toBe(false);
  });

  it("parse returns undefined rather than throwing on junk", () => {
    expect(parseTurnOutcomeRecord(null)).toBeUndefined();
    expect(parseTurnOutcomeRecord({ lifecycle: "completed" })).toBeUndefined();
    expect(parseTurnOutcomeRecord(base())?.lifecycle).toBe("completed");
  });
});

describe("interrupted has no producer", () => {
  /**
   * The slot exists so a later producer (durable checkpoints, S7) does not have
   * to re-version the contract. Until then, nothing in the tree emits it — and
   * this test is the record of that decision, not a coverage gap.
   */
  it("is in the vocabulary and parses, but is not written by any mark", () => {
    expect(TURN_LIFECYCLES).toContain("interrupted");
    expect(
      turnOutcomeRecordZ.safeParse(base({ lifecycle: "interrupted" })).success,
    ).toBe(true);
    expect(isTurnUnfinished({ lifecycle: "interrupted" })).toBe(true);
    // Closure does NOT apply: nothing observed the turn, so the dispatch states
    // a closure needs were never collected.
    expect(needsToolCallClosure({ lifecycle: "interrupted" })).toBe(false);
  });
});
