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

  it("refuses a ceiling met by only some of the calls", () => {
    // Two calls, one timed. "The slowest was under budget" is a claim about
    // BOTH, and the untimed one could be the slow one — the same fact as a
    // partial capture, one step finer.
    const partial = (durationMs: number) =>
      buildIterationTranscript({
        toolCalls: [
          { toolName: "a", arguments: {} },
          { toolName: "b", arguments: {} },
        ],
        toolCallTimings: [{ toolName: "a", durationMs, provenance: "span" }],
        timingsCaptured: true,
      });
    const under = evaluatePredicate(partial(12), {
      type: "toolLatencyUnder",
      ms: 500,
    });
    expect(under.status).toBe("error");
    expect(under.reason).toContain("only 1 of 2 observed call(s) were timed");

    // A call found OVER budget is proof whatever else went untimed, and the
    // reason still says how much was measured.
    const over = evaluatePredicate(partial(900), {
      type: "toolLatencyUnder",
      ms: 500,
    });
    expect(over.passed).toBe(false);
    expect(over).not.toHaveProperty("status");
    expect(over.reason).toContain("1 of 2 observed call(s) measured");
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

describe("a called tool the inventory does not describe is unreadable, not clean", () => {
  /**
   * A widget-initiated or out-of-band call reaches `toolCalls` without ever
   * appearing in the advertised registry. `argumentsMatchToolSchema` has
   * always refused to grade that. The two SAFETY checks used to skip it and
   * return `passed: true` — the worst shape available: a clean bill of health
   * for the one call nobody could read.
   */
  const outOfBand: IterationTranscript = buildIterationTranscript({
    toolCalls: [
      { toolName: "list_items", arguments: {} },
      { toolName: "ghost_tool", arguments: {} },
    ],
    toolInventory: [
      {
        name: "list_items",
        description: "List items.",
        annotations: { readOnlyHint: true },
      },
    ],
    inventoryCaptured: true,
  });

  it("refuses to clear a deprecation check it could not read", () => {
    const result = evaluatePredicate(outOfBand, {
      type: "noDeprecatedToolCalled",
      role: "advisory",
    });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("ghost_tool");
  });

  it("refuses to clear a destructive check it could not read", () => {
    const result = evaluatePredicate(outOfBand, {
      type: "noDestructiveToolCalled",
    });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("ghost_tool");
  });

  it("still reports a violation it DID see, over a tool it could not read", () => {
    // The one-sided rule: a destructive call is proof. An unreadable call
    // beside it does not downgrade a defect to "we could not tell".
    const withViolation: IterationTranscript = buildIterationTranscript({
      toolCalls: [
        { toolName: "delete_all", arguments: {} },
        { toolName: "ghost_tool", arguments: {} },
      ],
      toolInventory: [
        {
          name: "delete_all",
          description: "Delete everything.",
          annotations: { destructiveHint: true },
        },
      ],
      inventoryCaptured: true,
    });
    const result = evaluatePredicate(withViolation, {
      type: "noDestructiveToolCalled",
    });
    expect(result.passed).toBe(false);
    expect(result).not.toHaveProperty("status");
    expect(result.reason).toContain("delete_all");
  });
});

describe("a reason never carries a credential out of the run", () => {
  /**
   * Reasons are persisted to `testIteration.metadata.predicates` and read by
   * the UI, the API and every agent surface. `redact()` walks object KEYS, so
   * it is a no-op on the two places this branch added: a tool error message
   * and the model's own last line, both of which are free text with the
   * secret in the middle of the sentence.
   */
  it("masks a credential echoed back inside a tool error message", () => {
    const leaky: IterationTranscript = buildIterationTranscript({
      toolCalls: [{ toolName: "fetch_report", arguments: {} }],
      toolInventory: [
        { name: "fetch_report", inputSchema: { type: "object" } },
      ],
      inventoryCaptured: true,
      toolErrors: [
        {
          toolName: "fetch_report",
          kind: "content-error",
          message: '401 Unauthorized: api_key "sk-live-4f9d2ba71c33e0" is invalid',
        },
      ],
    });
    const result = evaluatePredicate(leaky, {
      type: "toolErrorNamesInput",
      role: "advisory",
    });
    expect(result.reason).not.toContain("sk-live-4f9d2ba71c33e0");
    // The message still reads as an error a human can act on.
    expect(result.reason).toContain("401 Unauthorized");
  });

  it("leaves ordinary error prose intact", () => {
    // The scrubber is deliberately narrow. "Rate limited" and "token expired"
    // are the messages that make a finding actionable, and a masker that ate
    // them would trade a real leak for a useless reason on every other row.
    const ordinary: IterationTranscript = buildIterationTranscript({
      toolCalls: [{ toolName: "fetch_report", arguments: {} }],
      toolInventory: [
        { name: "fetch_report", inputSchema: { type: "object" } },
      ],
      inventoryCaptured: true,
      toolErrors: [
        {
          toolName: "fetch_report",
          kind: "content-error",
          message: "429 Rate limited. Your token expired; retry in 30 seconds.",
        },
      ],
    });
    const result = evaluatePredicate(ordinary, {
      type: "toolErrorNamesInput",
      role: "advisory",
    });
    expect(result.reason).toContain("Rate limited");
    expect(result.reason).toContain("token expired");
    expect(result.reason).not.toContain("«redacted»");
  });

  it("masks a credential the model repeated in its final line", () => {
    const chatty: IterationTranscript = buildIterationTranscript({
      toolCalls: [],
      finalAssistantMessage:
        "I could not authenticate. Should I retry with token=ghp_A1b2C3d4E5f6G7h8?",
    });
    const result = evaluatePredicate(chatty, {
      type: "noEndingQuestion",
      role: "advisory",
    });
    expect(result.passed).toBe(false);
    expect(result.reason).not.toContain("ghp_A1b2C3d4E5f6G7h8");
  });
});
