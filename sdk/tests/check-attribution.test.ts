/**
 * A check may only read the evidence of the thing it names.
 *
 * Every case here is a bug that shipped in the first cut of the Tool-call and
 * Response checks and that a corpus item cannot catch, because each one is a
 * check reading REAL evidence that belongs to a different call — or to no call
 * at all. The shape is always the same: a verdict that looks grounded and is
 * not, which is worse than no verdict, because a reader has no way to tell.
 */

import { describe, expect, it } from "vitest";

import { evaluatePredicate } from "../src/predicates/evaluate";
import { buildIterationTranscript } from "../src/predicates/transcript";
import type { IterationTranscript } from "../src/predicates/types";

const size = { bytes: 10, basis: "model_visible_output", complete: true } as const;

describe("an empty channel is not an empty run", () => {
  /**
   * The trap: a trace that carried a `spans` array with no TOOL span, and
   * messages with no `tool-result` part. Both channels are `complete` — we
   * looked — and both are empty, while a call plainly happened.
   */
  const unmeasured: IterationTranscript = buildIterationTranscript({
    toolCalls: [{ toolName: "slow_tool", arguments: {} }],
    toolCallTimings: [],
    timingsCaptured: true,
    toolResults: [],
    resultsCaptured: true,
  });

  it("refuses to pass a ceiling over calls nobody measured", () => {
    for (const predicate of [
      { type: "toolLatencyUnder", ms: 1 },
      { type: "toolResultSizeUnder", maxBytes: 1 },
    ] as const) {
      const result = evaluatePredicate(unmeasured, predicate);
      // Before: `passed: true`, "no calls to any tool; budget not exercised" —
      // a gating ceiling met by an iteration that was never measured.
      expect(result.status, predicate.type).toBe("error");
      expect(result.reason, predicate.type).toContain("1 observed call(s)");
    }
  });

  it("refuses to report a result it never extracted as no result", () => {
    const result = evaluatePredicate(unmeasured, {
      type: "toolResultContains",
      needle: "x",
    });
    expect(result.status).toBe("error");
    expect(result.reason).not.toContain("returned no results");
  });

  it("still scores a genuinely empty run", () => {
    // No calls at all: nothing ran, so nothing was slow and nothing was big.
    const idle = buildIterationTranscript({
      toolCalls: [],
      toolCallTimings: [],
      timingsCaptured: true,
      toolResults: [],
      resultsCaptured: true,
    });
    const result = evaluatePredicate(idle, { type: "toolLatencyUnder", ms: 1 });
    expect(result.passed).toBe(true);
    expect(result).not.toHaveProperty("status");
  });

  it("says how much of the scope a partial measurement covered", () => {
    // Two calls, one timed. The verdict is real, but "1 call(s) under 500ms"
    // alone reads as coverage the row does not have.
    const partial = buildIterationTranscript({
      toolCalls: [
        { toolName: "a", arguments: {} },
        { toolName: "b", arguments: {} },
      ],
      toolCallTimings: [
        { toolName: "a", durationMs: 12, provenance: "span" },
      ],
      timingsCaptured: true,
    });
    expect(
      evaluatePredicate(partial, { type: "toolLatencyUnder", ms: 500 }).reason,
    ).toContain("1 of 2 observed call(s) measured");
  });
});

describe("scoping a repeat check does not rewrite adjacency", () => {
  const interleaved: IterationTranscript = buildIterationTranscript({
    toolCalls: [
      { toolName: "search", arguments: { q: "a" } },
      { toolName: "other", arguments: {} },
      { toolName: "search", arguments: { q: "a" } },
    ],
  });

  it("reads back-to-back off the transcript, not off the filtered slice", () => {
    // Two identical searches with a call BETWEEN them are not back-to-back.
    // Filtering to `search` first spliced the other call out and reported a
    // repeat that never happened — the same transcript answering two ways
    // depending on how the check was scoped.
    for (const predicate of [
      { type: "noRepeatedIdenticalCall" },
      { type: "noRepeatedIdenticalCall", toolName: "search" },
    ] as const) {
      expect(
        evaluatePredicate(interleaved, predicate).passed,
        predicate.toolName ?? "unscoped",
      ).toBe(true);
    }
  });

  it("still reports a real repeat, and only within its scope", () => {
    const repeated = buildIterationTranscript({
      toolCalls: [
        { toolName: "search", arguments: { q: "a" } },
        { toolName: "search", arguments: { q: "a" } },
      ],
    });
    expect(
      evaluatePredicate(repeated, { type: "noRepeatedIdenticalCall" }).passed,
    ).toBe(false);
    expect(
      evaluatePredicate(repeated, {
        type: "noRepeatedIdenticalCall",
        toolName: "search",
      }).passed,
    ).toBe(false);
    // A repeat of ANOTHER tool is out of scope, not a finding.
    expect(
      evaluatePredicate(repeated, {
        type: "noRepeatedIdenticalCall",
        toolName: "list",
      }).passed,
    ).toBe(true);
  });
});

describe("a page is graded against its own result", () => {
  /** Page one carries a cursor; page two, the defect, carries none. */
  const pages = (withIds: boolean): IterationTranscript =>
    buildIterationTranscript({
      toolCalls: [
        {
          ...(withIds ? { toolCallId: "c1" } : {}),
          toolName: "list",
          arguments: { limit: 2 },
        },
        {
          ...(withIds ? { toolCallId: "c2" } : {}),
          toolName: "list",
          arguments: { limit: 2, cursor: "n1" },
        },
      ],
      toolResults: [
        {
          ...(withIds ? { toolCallId: "c1" } : {}),
          toolName: "list",
          json: { items: [1, 2], nextCursor: "n1" },
          size,
        },
        {
          ...(withIds ? { toolCallId: "c2" } : {}),
          toolName: "list",
          json: { items: [3, 4] },
          size,
        },
      ],
      resultsCaptured: true,
    });

  it("finds the missing continuation with or without call ids", () => {
    // Without ids the check paired BOTH calls with the first result and
    // reported "all 2 full page(s) carried continuation metadata" — page one's
    // cursor, read twice, covering for the page that had none.
    for (const withIds of [true, false]) {
      const result = evaluatePredicate(pages(withIds), {
        type: "fullPageHasContinuation",
      });
      expect(result.passed, `ids: ${withIds}`).toBe(false);
      expect(result.status, `ids: ${withIds}`).toBeUndefined();
    }
  });

  it("does not hand a call another call's page when its own is missing", () => {
    // Every row carries an id and none is c2's: c2 produced no result, so
    // there is no full page to grade — not page one's, graded again.
    const missing = buildIterationTranscript({
      toolCalls: [
        { toolCallId: "c1", toolName: "list", arguments: { limit: 2 } },
        { toolCallId: "c2", toolName: "list", arguments: { limit: 2 } },
      ],
      toolResults: [
        {
          toolCallId: "c1",
          toolName: "list",
          json: { items: [1, 2], nextCursor: "n1" },
          size,
        },
      ],
      resultsCaptured: true,
    });
    expect(
      evaluatePredicate(missing, { type: "fullPageHasContinuation" }).reason,
    ).toContain("all 1 full page(s)");
  });
});

describe("an error names ITS call's input, or we do not know", () => {
  const toolInventory = [
    {
      name: "fetch",
      inputSchema: { type: "object", properties: { ref: { type: "string" } } },
    },
  ];
  const message = "Upstream reports alpha-9 gone";

  it("does not credit a value another invocation sent", () => {
    // Two calls, no call id on the error: "alpha-9" was sent by ONE of them
    // and nothing says it was the one that failed. This used to pass.
    const ambiguous = buildIterationTranscript({
      toolCalls: [
        { toolName: "fetch", arguments: { ref: "alpha-9" } },
        { toolName: "fetch", arguments: { ref: "beta-7" } },
      ],
      toolErrors: [{ toolName: "fetch", kind: "content-error", message }],
      toolInventory,
    });
    const result = evaluatePredicate(ambiguous, { type: "toolErrorNamesInput" });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("carries no call id");
  });

  it("resolves to a real verdict once the error carries a call id", () => {
    const joined = buildIterationTranscript({
      toolCalls: [
        { toolCallId: "c1", toolName: "fetch", arguments: { ref: "alpha-9" } },
        { toolCallId: "c2", toolName: "fetch", arguments: { ref: "beta-7" } },
      ],
      toolErrors: [
        { toolCallId: "c2", toolName: "fetch", kind: "content-error", message },
      ],
      toolInventory,
    });
    // c2 sent beta-7. The message names alpha-9 — another call's input.
    const result = evaluatePredicate(joined, { type: "toolErrorNamesInput" });
    expect(result.passed).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it("reads the only call to a tool as the call that failed", () => {
    const single = buildIterationTranscript({
      toolCalls: [{ toolName: "fetch", arguments: { ref: "alpha-9" } }],
      toolErrors: [{ toolName: "fetch", kind: "content-error", message }],
      toolInventory,
    });
    expect(
      evaluatePredicate(single, { type: "toolErrorNamesInput" }),
    ).toMatchObject({ passed: true });
  });

  it("still fails soundly when no candidate's input is named", () => {
    // Ambiguity is not a licence to withhold a verdict the evidence supports:
    // this message names no input of ANY call, whichever one failed.
    const none = buildIterationTranscript({
      toolCalls: [
        { toolName: "fetch", arguments: { ref: "alpha-9" } },
        { toolName: "fetch", arguments: { ref: "beta-7" } },
      ],
      toolErrors: [
        {
          toolName: "fetch",
          kind: "content-error",
          message: "Upstream unavailable (503). Please retry.",
        },
      ],
      toolInventory,
    });
    const result = evaluatePredicate(none, { type: "toolErrorNamesInput" });
    expect(result.passed).toBe(false);
    expect(result.status).toBeUndefined();
  });
});

describe("an incomplete scope makes only one direction of verdict", () => {
  /** Two results, and the capture says rows were dropped on the way here. */
  const partial = (rows: number): IterationTranscript => ({
    toolCalls: [{ toolName: "list", arguments: {} }],
    toolErrors: [],
    toolResults: Array.from({ length: rows }, (_, index) => ({
      toolName: "list",
      text: `row ${index}`,
      json: { ok: true },
      size,
    })),
    capture: {
      toolResults: "partial",
      toolCallTimings: "absent",
      toolInventory: "absent",
    },
  });

  it("keeps a hit and refuses the absence", () => {
    // Finding it is proof; not finding it, over rows we know were dropped,
    // is not proof it is not there.
    expect(
      evaluatePredicate(partial(2), {
        type: "toolResultContains",
        needle: "row 1",
      }),
    ).toMatchObject({ passed: true });
    const miss = evaluatePredicate(partial(2), {
      type: "toolResultContains",
      needle: "row 900",
    });
    expect(miss.status).toBe("error");
    expect(miss.reason).toContain("absence cannot be established");
  });

  it("keeps a size failure and refuses a size pass", () => {
    const over = evaluatePredicate(partial(2), {
      type: "toolResultSizeUnder",
      maxBytes: 1,
    });
    expect(over.passed).toBe(false);
    expect(over).not.toHaveProperty("status");
    expect(
      evaluatePredicate(partial(2), {
        type: "toolResultSizeUnder",
        maxBytes: 4096,
      }).status,
    ).toBe("error");
  });

  it("refuses 'they all matched' when they were not all read", () => {
    expect(
      evaluatePredicate(partial(2), {
        type: "toolResultMatchesSchema",
        schema: { type: "object" },
      }).status,
    ).toBe("error");
  });
});

describe("a truncated row is not a short one", () => {
  const truncated: IterationTranscript = {
    toolCalls: [{ toolName: "dump", arguments: {} }],
    toolErrors: [],
    toolResults: [
      {
        toolName: "dump",
        text: '{"items":[1,2,3',
        truncated: true,
        size: { bytes: 90_000, basis: "model_visible_output", complete: true },
      },
    ],
    capture: {
      toolResults: "complete",
      toolCallTimings: "absent",
      toolInventory: "absent",
    },
  };

  it("does not report a cut-off payload as 'not JSON'", () => {
    // The server sent JSON. We stored the first 64,000 characters of it.
    const result = evaluatePredicate(truncated, {
      type: "toolResultMatchesSchema",
      schema: { type: "object" },
    });
    expect(result.status).toBe("error");
    expect(result.reason).not.toContain("was not JSON");
  });

  it("does not read a cut-off row as not containing the needle", () => {
    expect(
      evaluatePredicate(truncated, {
        type: "toolResultContains",
        needle: "items",
      }),
    ).toMatchObject({ passed: true });
    expect(
      evaluatePredicate(truncated, { type: "toolResultContains", needle: "99" })
        .status,
    ).toBe("error");
  });

  it("still grades the size, which was measured before the cap", () => {
    // `size.bytes` is taken on the whole output part, so truncation cannot
    // mislead it — and refusing here would make the cap unmeasurable.
    const graded = evaluatePredicate(truncated, {
      type: "toolResultSizeUnder",
      maxBytes: 65_536,
    });
    expect(graded.passed).toBe(false);
    expect(graded).not.toHaveProperty("status");
  });
});
