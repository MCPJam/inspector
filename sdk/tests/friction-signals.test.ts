/**
 * Per-trial FRICTION SIGNALS — the report-only observation contract.
 *
 * Organised around the ways a "the agent wasted work" view LIES:
 *
 *   - an identifier that WAS used, reported as unused;
 *   - a pagination cursor reported as a repeated search;
 *   - an error result mined for identifiers nobody could have used;
 *   - a short number matching inside a longer one;
 *   - a harness run's APPENDED wire-only call read as a later call;
 *   - a trial with no retained results reporting zero identifier signals
 *     instead of saying it never looked;
 *   - and two runs of the deriver over the same trial disagreeing.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  FRICTION_NOT_MEASURED_REASONS,
  FRICTION_SIGNAL_KINDS,
  FRICTION_SIGNALS_VERSION,
  MAX_FRICTION_CALLS,
  MAX_FRICTION_SIGNALS,
  MIN_IDENTIFIER_LENGTH,
  PAGINATION_ARG_KEYS,
  availableBefore,
  buildFrictionCallRecords,
  buildResultsByToolCallIdFromMessages,
  deriveTrialFrictionSignals,
  deriveTrialFrictionSignalsFromCalls,
  evalTrialFrictionSignalsSchema,
  extractResultIdentifiers,
  frictionResultIsError,
  isFrictionNotMeasuredReason,
  isFrictionSignalKind,
  normalizeFrictionResult,
  projectFrictionSignals,
  type EvalTrialFrictionSignals,
  type FrictionCallRecord,
  type FrictionResultEntry,
  type FrictionSignal,
} from "../src/contract/index.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "friction-signals-fixtures.json"
);

type FixtureRow = Record<string, unknown> & { __label: string; __why?: string };
type Fixtures = {
  accept: FixtureRow[];
  reject: FixtureRow[];
  roundTrip: FixtureRow[];
};

function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key.startsWith("__")) continue;
      out[key] = stripAnnotations(entry);
    }
    return out as unknown as T;
  }
  return value;
}

const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixtures;

// ── record helpers ───────────────────────────────────────────────────────────

/** A structured result carrying ids under `results[].id`. */
const idsResult = (...ids: (string | number)[]) => ({
  structuredContent: { results: ids.map((id) => ({ id, title: "t" })) },
});

/** The tool-result content item the emulated engine persists. */
const toolResultMessage = (toolCallId: string, result: unknown) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "search_issues",
      output: { type: "json", value: result },
      result,
    },
  ],
});

const record = (
  over: Partial<FrictionCallRecord> & { index: number; toolName: string }
): FrictionCallRecord => ({
  arguments: {},
  resultAvailable: true,
  ordering: "messageOrder",
  result: { textParts: [], isError: false },
  ...over,
});

const kindsOf = (doc: EvalTrialFrictionSignals) =>
  doc.signals.map((signal) => signal.kind);

const only = <K extends FrictionSignal["kind"]>(
  doc: EvalTrialFrictionSignals,
  kind: K
) => doc.signals.filter((signal) => signal.kind === kind);

// ── vocabularies ─────────────────────────────────────────────────────────────

describe("closed vocabularies", () => {
  test("kinds and reasons have guards, and the version is a literal", () => {
    expect(FRICTION_SIGNALS_VERSION).toBe(1);
    expect(FRICTION_SIGNAL_KINDS).toEqual([
      "identifierSurfacedUnused",
      "searchRepeatedAfterIdentifier",
      "identicalRetry",
      "changedRetry",
      "paginationContinuation",
    ]);
    expect(isFrictionSignalKind("identicalRetry")).toBe(true);
    expect(isFrictionSignalKind("wastedCall")).toBe(false);
    expect(FRICTION_NOT_MEASURED_REASONS).toHaveLength(5);
    expect(isFrictionNotMeasuredReason("orderingUnknown")).toBe(true);
    expect(isFrictionNotMeasuredReason("unknown")).toBe(false);
  });
});

// ── the fixture rows ─────────────────────────────────────────────────────────

describe("the shared fixtures", () => {
  for (const row of fixtures.accept) {
    test(`accepts: ${row.__label}`, () => {
      const parsed = evalTrialFrictionSignalsSchema.safeParse(
        stripAnnotations(row)
      );
      expect(
        parsed.success,
        parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)
      ).toBe(true);
    });
  }

  for (const row of fixtures.reject) {
    test(`rejects: ${row.__label}`, () => {
      expect(
        evalTrialFrictionSignalsSchema.safeParse(stripAnnotations(row)).success
      ).toBe(false);
    });
  }

  for (const row of fixtures.roundTrip) {
    test(`round-trips: ${row.__label}`, () => {
      const input = stripAnnotations(row);
      const parsed = evalTrialFrictionSignalsSchema.parse(input);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
    });
  }

  test("every vocabulary member is reachable from a fixture", () => {
    const seen = new Set<string>();
    for (const row of [...fixtures.accept, ...fixtures.roundTrip]) {
      for (const signal of (row.signals as { kind: string }[]) ?? []) {
        seen.add(signal.kind);
      }
    }
    expect([...seen].sort()).toEqual([...FRICTION_SIGNAL_KINDS].sort());

    const reasons = new Set<string>();
    for (const row of [...fixtures.accept, ...fixtures.reject]) {
      if (typeof row.notMeasuredReason === "string") {
        reasons.add(row.notMeasuredReason);
      }
      const identifier = row.identifierSignals as { reason?: string };
      if (identifier?.reason) reasons.add(identifier.reason);
    }
    // `truncated` is only ever produced by the deriver's own cap, which the
    // derivation tests below reach; the rest are producer-visible states.
    for (const reason of FRICTION_NOT_MEASURED_REASONS) {
      expect([...reasons, "truncated"]).toContain(reason);
    }
  });
});

// ── result normalization ─────────────────────────────────────────────────────

describe("reading a tool result", () => {
  test("finds isError in all three placements", () => {
    expect(frictionResultIsError({ isError: true })).toBe(true);
    expect(frictionResultIsError({ result: { isError: true } })).toBe(true);
    expect(
      frictionResultIsError({ output: { value: { isError: true } } })
    ).toBe(true);
    expect(frictionResultIsError({ result: { isError: false } })).toBe(false);
  });

  test("reads a bare CallToolResult and a tool-result item the same way", () => {
    const raw = {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { ok: true },
      isError: false,
    };
    expect(normalizeFrictionResult(raw)).toEqual({
      structuredContent: { ok: true },
      textParts: ["hello"],
      isError: false,
    });
    expect(
      normalizeFrictionResult({
        type: "tool-result",
        toolCallId: "c1",
        result: raw,
      })
    ).toEqual({
      structuredContent: { ok: true },
      textParts: ["hello"],
      isError: false,
    });
  });
});

describe("identifier extraction", () => {
  test("takes values under identifier-named keys and id-shaped literals", () => {
    const found = extractResultIdentifiers(
      normalizeFrictionResult({
        structuredContent: {
          results: [
            { id: "ISSUE-41", title: "a title" },
            { issueId: "ISSUE-42", note: "not an identifier" },
          ],
          trace: "0f1e2d3c4b5a6978",
        },
      })
    );
    expect(found.values).toEqual(["0f1e2d3c4b5a6978", "ISSUE-41", "ISSUE-42"]);
    expect(found.keyPaths).toEqual([
      "results[].id",
      "results[].issueId",
      "trace",
    ]);
  });

  test("drops candidates below the minimum length", () => {
    expect(MIN_IDENTIFIER_LENGTH).toBe(3);
    const found = extractResultIdentifiers(
      normalizeFrictionResult({ structuredContent: { id: 12 } })
    );
    expect(found.values).toEqual([]);
  });

  test("parses a text part that looks like a JSON document, and only that", () => {
    const fromJson = extractResultIdentifiers(
      normalizeFrictionResult({
        content: [{ type: "text", text: '{"id":"ISSUE-9001"}' }],
      })
    );
    expect(fromJson.values).toEqual(["ISSUE-9001"]);
    const fromProse = extractResultIdentifiers(
      normalizeFrictionResult({
        content: [{ type: "text", text: "the id is ISSUE-9001" }],
      })
    );
    expect(fromProse.values).toEqual([]);
  });
});

// ── availability ─────────────────────────────────────────────────────────────

describe("availableBefore", () => {
  const messageOrder = (index: number) =>
    record({ index, toolName: "t", ordering: "messageOrder" });
  const timed = (index: number, startedAtMs: number, settledAtMs: number) =>
    record({
      index,
      toolName: "t",
      ordering: "timed",
      startedAtMs,
      settledAtMs,
    });

  test("message order is causal", () => {
    expect(availableBefore(messageOrder(0), messageOrder(1))).toBe(true);
    expect(availableBefore(messageOrder(1), messageOrder(0))).toBe(false);
  });

  test("timed order compares settled against started, not indexes", () => {
    const early = timed(3, 100, 200);
    const late = timed(1, 300, 400);
    expect(availableBefore(early, late)).toBe(true);
    expect(availableBefore(late, early)).toBe(false);
  });

  test("two different orderings can never establish availability", () => {
    expect(availableBefore(messageOrder(0), timed(1, 100, 200))).toBe(false);
    expect(availableBefore(timed(0, 100, 200), messageOrder(1))).toBe(false);
  });
});

// ── derivation ───────────────────────────────────────────────────────────────

describe("adjacency signals", () => {
  test("byte-identical arguments are an identical retry, with the error flag", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "get_issue",
        arguments: { id: "ISSUE-41" },
        result: { textParts: [], isError: true },
      }),
      record({
        index: 1,
        toolName: "get_issue",
        arguments: { id: "ISSUE-41" },
      }),
    ]);
    expect(kindsOf(doc)).toEqual(["identicalRetry"]);
    expect(only(doc, "identicalRetry")[0]).toMatchObject({
      callIndex: 1,
      priorCallIndex: 0,
      afterError: true,
    });
  });

  test("key order does not make two identical calls look different", () => {
    const doc = deriveTrialFrictionSignals([
      record({ index: 0, toolName: "s", arguments: { a: 1, b: 2 } }),
      record({ index: 1, toolName: "s", arguments: { b: 2, a: 1 } }),
    ]);
    expect(kindsOf(doc)).toEqual(["identicalRetry"]);
  });

  test("a pagination-only difference is a continuation, never a repeat", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "list_pages",
        arguments: { q: "open", cursor: "c1", limit: 20 },
        result: { textParts: [], isError: false },
      }),
      record({
        index: 1,
        toolName: "list_pages",
        arguments: { q: "open", cursor: "c2", limit: 20 },
      }),
    ]);
    expect(kindsOf(doc)).toEqual(["paginationContinuation"]);
    expect(only(doc, "paginationContinuation")[0]!.paginationKeys).toEqual([
      "cursor",
    ]);
  });

  test("every pagination key is recognised at the top level", () => {
    for (const key of PAGINATION_ARG_KEYS) {
      const doc = deriveTrialFrictionSignals([
        record({ index: 0, toolName: "p", arguments: { q: "x", [key]: 1 } }),
        record({ index: 1, toolName: "p", arguments: { q: "x", [key]: 2 } }),
      ]);
      expect(kindsOf(doc), key).toEqual(["paginationContinuation"]);
    }
  });

  test("a real argument change beside a cursor is a changed retry", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "s",
        arguments: { q: "open", cursor: "c1" },
      }),
      record({
        index: 1,
        toolName: "s",
        arguments: { q: "closed", cursor: "c2" },
      }),
    ]);
    expect(kindsOf(doc)).toEqual(["changedRetry"]);
  });

  test("different tools next to each other produce nothing", () => {
    const doc = deriveTrialFrictionSignals([
      record({ index: 0, toolName: "search_issues" }),
      record({ index: 1, toolName: "get_issue", arguments: { id: "x" } }),
    ]);
    expect(doc.signals).toEqual([]);
    expect(doc.state).toBe("measured");
  });
});

describe("identifier signals", () => {
  const searchThenTwoUnrelated = (secondArguments: unknown) => [
    record({
      index: 0,
      toolName: "search_issues",
      arguments: { q: "open" },
      result: normalizeFrictionResult(idsResult("ISSUE-41", "ISSUE-42")),
      toolCallId: "call_0",
    }),
    record({ index: 1, toolName: "list_pages", arguments: { page: 1 } }),
    record({ index: 2, toolName: "get_issue", arguments: secondArguments }),
  ];

  test("fires when no later call carried any identifier", () => {
    const doc = deriveTrialFrictionSignals(
      searchThenTwoUnrelated({ title: "open bugs" })
    );
    expect(kindsOf(doc)).toEqual(["identifierSurfacedUnused"]);
    expect(only(doc, "identifierSurfacedUnused")[0]).toMatchObject({
      informationCallIndex: 0,
      observedAtCallIndex: 2,
      toolName: "search_issues",
      toolCallId: "call_0",
      identifierKeyPaths: ["results[].id"],
      identifierCount: 2,
      laterCallCount: 2,
    });
  });

  test("stays silent when a later call used one of the identifiers", () => {
    const doc = deriveTrialFrictionSignals(
      searchThenTwoUnrelated({ id: "ISSUE-42" })
    );
    expect(doc.signals).toEqual([]);
  });

  test("needs two later calls, not one", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        arguments: { q: "open" },
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({ index: 1, toolName: "get_issue", arguments: { title: "x" } }),
    ]);
    expect(doc.signals).toEqual([]);
  });

  test("an error result is never mined for identifiers", () => {
    const records = searchThenTwoUnrelated({ title: "open bugs" });
    records[0]!.result = {
      ...records[0]!.result!,
      isError: true,
    };
    expect(deriveTrialFrictionSignals(records).signals).toEqual([]);
  });

  test("a whole-token match is required — 123 is not used by 1234", () => {
    const used = deriveTrialFrictionSignals(
      searchThenTwoUnrelated({ id: "1234" }).map((row, index) =>
        index === 0
          ? {
              ...row,
              result: normalizeFrictionResult(idsResult("123")),
            }
          : row
      )
    );
    expect(kindsOf(used)).toEqual(["identifierSurfacedUnused"]);

    const reallyUsed = deriveTrialFrictionSignals(
      searchThenTwoUnrelated({ id: "123" }).map((row, index) =>
        index === 0
          ? {
              ...row,
              result: normalizeFrictionResult(idsResult("123")),
            }
          : row
      )
    );
    expect(reallyUsed.signals).toEqual([]);
  });

  test("a numeric identifier is matched by its string form", () => {
    const records = searchThenTwoUnrelated({ id: 4711 });
    records[0]!.result = normalizeFrictionResult(idsResult(4711));
    expect(deriveTrialFrictionSignals(records).signals).toEqual([]);
  });

  test("a repeated search after unused identifiers names its repeats", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        arguments: { q: "open" },
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({
        index: 1,
        toolName: "search_issues",
        arguments: { q: "open bugs" },
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({
        index: 2,
        toolName: "search_issues",
        arguments: { q: "bugs" },
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
    ]);
    const repeated = only(doc, "searchRepeatedAfterIdentifier")[0]!;
    expect(repeated).toMatchObject({
      informationCallIndex: 0,
      observedAtCallIndex: 2,
      repeatCallIndexes: [1, 2],
    });
  });

  test("a paginating search is never a repeated search", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        arguments: { q: "open", cursor: "c1" },
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({
        index: 1,
        toolName: "search_issues",
        arguments: { q: "open", cursor: "c2" },
        result: normalizeFrictionResult(idsResult("ISSUE-42")),
      }),
      record({
        index: 2,
        toolName: "search_issues",
        arguments: { q: "open", cursor: "c3" },
        result: normalizeFrictionResult(idsResult("ISSUE-43")),
      }),
    ]);
    expect(kindsOf(doc)).not.toContain("searchRepeatedAfterIdentifier");
    expect(
      kindsOf(doc).filter((kind) => kind === "paginationContinuation")
    ).toHaveLength(2);
  });
});

describe("harness ordering", () => {
  /**
   * The case array position cannot answer: a wire-only call appended to the
   * graded array at the END but settled BEFORE the search that "surfaced" the
   * identifiers. Reading position would call it a later call and fire.
   */
  test("an appended wire-only call that settled first is not a later call", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        arguments: { q: "open" },
        ordering: "timed",
        startedAtMs: 3_000,
        settledAtMs: 4_000,
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({
        index: 1,
        toolName: "get_issue",
        arguments: { title: "x" },
        ordering: "timed",
        startedAtMs: 5_000,
        settledAtMs: 5_500,
      }),
      record({
        index: 2,
        toolName: "list_pages",
        arguments: { page: 1 },
        ordering: "timed",
        startedAtMs: 1_000,
        settledAtMs: 1_500,
      }),
    ]);
    // Only ONE call started after the search settled, so the two-later-calls
    // floor is not met and nothing fires.
    expect(only(doc, "identifierSurfacedUnused")).toEqual([]);
    expect(doc.identifierSignals).toEqual({ state: "measured" });
  });

  test("mixed timed and message ordering makes identifier signals unmeasured", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        ordering: "timed",
        startedAtMs: 1,
        settledAtMs: 2,
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({ index: 1, toolName: "get_issue", arguments: { title: "x" } }),
      record({ index: 2, toolName: "get_issue", arguments: { title: "x" } }),
    ]);
    expect(doc.identifierSignals).toEqual({
      state: "notMeasured",
      reason: "orderingUnknown",
    });
    // Adjacency survives: it never depended on timing.
    expect(kindsOf(doc)).toEqual(["identicalRetry"]);
  });

  test("a call with no retained result makes identifier signals unmeasured", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({
        index: 1,
        toolName: "get_issue",
        arguments: { title: "x" },
        resultAvailable: false,
        ordering: "unknown",
        result: undefined,
      }),
      record({ index: 2, toolName: "get_issue", arguments: { title: "x" } }),
    ]);
    expect(doc.identifierSignals).toEqual({
      state: "notMeasured",
      reason: "resultsUnavailable",
    });
    expect(kindsOf(doc)).toEqual(["identicalRetry"]);
    expect(doc.resultAvailableCount).toBe(2);
  });
});

describe("honest degradation", () => {
  test("zero calls is notMeasured: noToolCalls", () => {
    const doc = deriveTrialFrictionSignals([]);
    expect(doc.state).toBe("notMeasured");
    expect(doc.notMeasuredReason).toBe("noToolCalls");
    expect(doc.signals).toEqual([]);
  });

  test("past the call cap the whole document is notMeasured: truncated", () => {
    const records = Array.from({ length: MAX_FRICTION_CALLS + 1 }, (_, index) =>
      record({ index, toolName: "search_issues", arguments: { q: "open" } })
    );
    const doc = deriveTrialFrictionSignals(records);
    expect(doc.state).toBe("notMeasured");
    expect(doc.notMeasuredReason).toBe("truncated");
    expect(doc.callCount).toBe(MAX_FRICTION_CALLS + 1);
    expect(doc.signals).toEqual([]);
  });

  test("arguments that cannot be canonicalized are evidenceIncomplete", () => {
    const cyclic: Record<string, unknown> = { q: "open" };
    cyclic.self = cyclic;
    const doc = deriveTrialFrictionSignals([
      record({ index: 0, toolName: "s", arguments: { q: "open" } }),
      record({ index: 1, toolName: "s", arguments: cyclic }),
    ]);
    expect(doc.notMeasuredReason).toBe("evidenceIncomplete");
    // NOT a skipped call: skipping would renumber every index after it.
    expect(doc.callCount).toBe(2);
  });

  test("a producer-declared evidence hole keeps the call counts honest", () => {
    const doc = deriveTrialFrictionSignalsFromCalls({
      toolsCalled: [
        { toolName: "a", toolCallId: "c1", arguments: {} },
        { toolName: "b", toolCallId: "c2", arguments: {} },
      ],
      evidenceHole: "evidenceIncomplete",
    });
    expect(doc.state).toBe("notMeasured");
    expect(doc.notMeasuredReason).toBe("evidenceIncomplete");
    expect(doc.callCount).toBe(2);
  });

  test("the signal list is capped", () => {
    const records = Array.from({ length: 60 }, (_, index) =>
      record({ index, toolName: "s", arguments: { q: "open" } })
    );
    expect(
      deriveTrialFrictionSignals(records).signals.length
    ).toBeLessThanOrEqual(MAX_FRICTION_SIGNALS);
  });
});

describe("the builders", () => {
  test("reads tool results out of a transcript, by id and not by position", () => {
    const results = buildResultsByToolCallIdFromMessages([
      { role: "assistant", content: "thinking" },
      toolResultMessage("call_b", idsResult("ISSUE-42")),
      toolResultMessage("call_a", idsResult("ISSUE-41")),
      // No `result`: what the model saw, not what the server returned.
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_c",
            toolName: "x",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);
    expect([...results.keys()].sort()).toEqual(["call_a", "call_b"]);

    const records = buildFrictionCallRecords({
      toolsCalled: [
        { toolName: "search_issues", toolCallId: "call_a", arguments: {} },
        { toolName: "search_issues", toolCallId: "call_b", arguments: {} },
        { toolName: "get_issue", toolCallId: "call_c", arguments: {} },
      ],
      resultsByToolCallId: results,
    });
    expect(records.map((row) => [row.resultAvailable, row.ordering])).toEqual([
      [true, "messageOrder"],
      [true, "messageOrder"],
      [false, "unknown"],
    ]);
    // The id join, not the position: `call_a` is second in the transcript.
    expect(extractResultIdentifiers(records[0]!.result!).values).toEqual([
      "ISSUE-41",
    ]);
  });

  test("an entry carrying wire timing makes its call timed", () => {
    const results = new Map<string, FrictionResultEntry>([
      [
        "evidence:req-7",
        {
          raw: idsResult("ISSUE-41"),
          startedAtMs: 1_000,
          settledAtMs: 1_500,
        },
      ],
    ]);
    const [row] = buildFrictionCallRecords({
      toolsCalled: [
        {
          toolName: "search_issues",
          toolCallId: "evidence:req-7",
          arguments: {},
        },
      ],
      resultsByToolCallId: results,
    });
    expect(row).toMatchObject({
      ordering: "timed",
      startedAtMs: 1_000,
      settledAtMs: 1_500,
      resultAvailable: true,
    });
  });
});

describe("determinism", () => {
  const trial: FrictionCallRecord[] = [
    record({
      index: 0,
      toolName: "search_issues",
      arguments: { q: "open" },
      result: normalizeFrictionResult(idsResult("ISSUE-41", "ISSUE-42")),
    }),
    record({
      index: 1,
      toolName: "search_issues",
      arguments: { q: "open bugs" },
      result: normalizeFrictionResult(idsResult("ISSUE-41")),
    }),
    record({ index: 2, toolName: "get_issue", arguments: { title: "x" } }),
    record({ index: 3, toolName: "get_issue", arguments: { title: "x" } }),
  ];

  test("two derivations over the same trial are byte-identical", () => {
    const a = deriveTrialFrictionSignals(trial);
    const b = deriveTrialFrictionSignals(trial);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("signals come back ordered by the call that made them observable", () => {
    const doc = deriveTrialFrictionSignals(trial);
    const observations = doc.signals.map((signal) =>
      signal.kind === "identifierSurfacedUnused" ||
      signal.kind === "searchRepeatedAfterIdentifier"
        ? signal.observedAtCallIndex
        : signal.callIndex
    );
    expect([...observations].sort((a, b) => a - b)).toEqual(observations);
  });
});

// ── projection ───────────────────────────────────────────────────────────────

describe("projectFrictionSignals", () => {
  const valid = deriveTrialFrictionSignals([
    record({ index: 0, toolName: "s", arguments: { q: "open" } }),
    record({ index: 1, toolName: "s", arguments: { q: "open" } }),
  ]);

  test("omits the block for metadata that predates the measurement", () => {
    expect(projectFrictionSignals({ stageResults: [] })).toEqual({});
    expect(projectFrictionSignals(undefined)).toEqual({});
    expect(projectFrictionSignals("nope")).toEqual({});
  });

  test("passes a valid document through", () => {
    expect(projectFrictionSignals({ frictionSignals: valid })).toEqual({
      frictionSignals: valid,
    });
  });

  test("marks an invalid document unverified rather than dropping it", () => {
    expect(
      projectFrictionSignals({ frictionSignals: { version: 1, state: "yes" } })
    ).toEqual({ frictionSignalsUnverified: true });
  });

  test("never carries an identifier value", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "search_issues",
        arguments: { q: "open" },
        result: normalizeFrictionResult(idsResult("ISSUE-41", "ISSUE-42")),
      }),
      record({ index: 1, toolName: "get_issue", arguments: { title: "x" } }),
      record({ index: 2, toolName: "get_issue", arguments: { title: "y" } }),
    ]);
    expect(kindsOf(doc)).toContain("identifierSurfacedUnused");
    expect(JSON.stringify(doc)).not.toContain("ISSUE-41");
    expect(JSON.stringify(doc)).not.toContain("ISSUE-42");
  });
});

describe("a call whose tool name could not be read", () => {
  test("produces no signal, and does not cost the trial its other ones", () => {
    const doc = deriveTrialFrictionSignals([
      record({
        index: 0,
        toolName: "",
        arguments: { q: "open" },
        result: normalizeFrictionResult(idsResult("ISSUE-41")),
      }),
      record({ index: 1, toolName: "get_issue", arguments: { title: "x" } }),
      record({ index: 2, toolName: "get_issue", arguments: { title: "x" } }),
    ]);
    // The nameless call yields nothing — the schema needs a name and a throw
    // here would lose the whole document.
    expect(only(doc, "identifierSurfacedUnused")).toEqual([]);
    // The adjacency pair, which never needed that name, survives.
    expect(kindsOf(doc)).toEqual(["identicalRetry"]);
    expect(doc.state).toBe("measured");
  });
});
