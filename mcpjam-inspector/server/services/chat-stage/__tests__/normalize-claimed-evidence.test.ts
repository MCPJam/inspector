/**
 * Claimed wire data → adapter input.
 *
 * The rule every test here enforces: a field that does not narrow is ABSENT,
 * never defaulted. Absent evidence derives `notMeasured`; a defaulted zero
 * derives a verdict, and a verdict manufactured out of a missing field is
 * exactly the failure the chain exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeClaimedEvidence,
  normalizeCriteria,
  normalizeGoalJudge,
  normalizeLifecycle,
  normalizeReadiness,
  normalizeSpans,
  normalizeStageSource,
  transcriptHasUserAsk,
} from "../normalize-claimed-evidence.js";

const claim = (over: Record<string, unknown> = {}) => ({
  source: "user_testing",
  evidence: {},
  envelope: { messages: [{ role: "user", content: "hi" }] },
  ...over,
});

describe("the envelope is required, not guessed around", () => {
  it("reports evidence_unavailable when the envelope is null", () => {
    expect(normalizeClaimedEvidence(claim({ envelope: null }))).toEqual({
      ok: false,
      errorCode: "evidence_unavailable",
    });
  });

  it("reports evidence_unavailable when messages are unreadable", () => {
    expect(
      normalizeClaimedEvidence(claim({ envelope: { messages: "nope" } }))
    ).toEqual({ ok: false, errorCode: "evidence_unavailable" });
  });

  it("reports evidence_unavailable for an unknown source", () => {
    expect(normalizeClaimedEvidence(claim({ source: "eval" }))).toEqual({
      ok: false,
      errorCode: "evidence_unavailable",
    });
  });

  it("an empty transcript still derives — it just has no ask", () => {
    const result = normalizeClaimedEvidence(
      claim({ envelope: { messages: [] } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.hasUserAsk).toBe(false);
  });
});

describe("hasUserAsk is read from the transcript, not from a preview", () => {
  it("true for a user turn with text", () => {
    expect(
      transcriptHasUserAsk([{ role: "user", content: "book a room" }])
    ).toBe(true);
  });

  it("true for structured content parts", () => {
    expect(
      transcriptHasUserAsk([
        { role: "user", content: [{ type: "text", text: "book a room" }] },
      ])
    ).toBe(true);
  });

  it("false when only the assistant spoke", () => {
    expect(
      transcriptHasUserAsk([{ role: "assistant", content: "hello there" }])
    ).toBe(false);
  });

  it("false for a whitespace-only user turn", () => {
    expect(transcriptHasUserAsk([{ role: "user", content: "   " }])).toBe(
      false
    );
  });

  it("false for junk", () => {
    expect(transcriptHasUserAsk("nope")).toBe(false);
    expect(transcriptHasUserAsk([null, 7, { role: "user" }])).toBe(false);
  });
});

describe("spans are narrowed to what the analyzer reads", () => {
  it("keeps the six declared fields and drops everything else", () => {
    expect(
      normalizeSpans([
        {
          id: "s1",
          category: "tool",
          status: "ok",
          toolName: "search",
          promptIndex: 0,
          mcpErrorCode: -32603,
          // Advisory display only, and explicitly never a gate.
          finishReason: "stop",
          startMs: 1,
          inputTokens: 99,
        },
      ])
    ).toEqual([
      {
        id: "s1",
        category: "tool",
        status: "ok",
        toolName: "search",
        promptIndex: 0,
        mcpErrorCode: -32603,
      },
    ]);
  });

  it("drops non-objects and non-finite numbers rather than coercing", () => {
    expect(
      normalizeSpans([null, "x", { id: "s", mcpErrorCode: Number.NaN }])
    ).toEqual([{ id: "s" }]);
  });

  it("returns nothing for junk", () => {
    expect(normalizeSpans(undefined)).toEqual([]);
    expect(normalizeSpans({ spans: [] })).toEqual([]);
  });
});

describe("readiness: an unknown inventory establishes nothing", () => {
  it("forwards the count only alongside advertisedToolsKnown", () => {
    expect(
      normalizeReadiness({
        status: "partial",
        advertisedToolCount: 12,
        advertisedToolsKnown: false,
      })
    ).toEqual({ status: "partial" });
  });

  it("forwards both when the inventory IS known", () => {
    expect(
      normalizeReadiness({
        status: "completed",
        toolCallCount: 3,
        advertisedToolCount: 12,
        advertisedToolsKnown: true,
      })
    ).toEqual({
      status: "completed",
      toolCallCount: 3,
      advertisedToolsKnown: true,
      advertisedToolCount: 12,
    });
  });

  it("drops a record with an unknown status", () => {
    expect(normalizeReadiness({ status: "weird" })).toBeUndefined();
    expect(normalizeReadiness(null)).toBeUndefined();
  });
});

describe("criteria: unreadable results are not a pass", () => {
  it("a completed grade with unreadable results degrades to pending", () => {
    expect(normalizeCriteria({ status: "completed", results: "nope" })).toEqual(
      {
        status: "pending",
      }
    );
  });

  it("keeps only well-formed rows", () => {
    expect(
      normalizeCriteria({
        status: "completed",
        results: [
          { criterionId: "a", passed: true },
          { criterionId: "b" },
          { passed: false },
          null,
        ],
      })
    ).toEqual({
      status: "completed",
      results: [{ criterionId: "a", passed: true }],
    });
  });

  it("carries pending and failed through untouched", () => {
    expect(normalizeCriteria({ status: "pending" })).toEqual({
      status: "pending",
    });
    expect(normalizeCriteria({ status: "failed" })).toEqual({
      status: "failed",
    });
  });
});

describe("goal judge: a completed verdict with no boolean is silence", () => {
  it("drops a non-boolean passed", () => {
    expect(normalizeGoalJudge({ status: "completed", passed: "yes" })).toEqual({
      status: "completed",
    });
  });

  it("keeps a real verdict and its reason", () => {
    expect(
      normalizeGoalJudge({
        status: "completed",
        passed: false,
        reason: "never booked",
      })
    ).toEqual({ status: "completed", passed: false, reason: "never booked" });
  });

  it("never invents a verdict for a running or failed judge", () => {
    expect(normalizeGoalJudge({ status: "running", passed: true })).toEqual({
      status: "running",
    });
    expect(normalizeGoalJudge({ status: "failed", passed: true })).toEqual({
      status: "failed",
    });
  });
});

describe("lifecycle and source", () => {
  it("defaults to settled — the conservative reading", () => {
    expect(normalizeLifecycle(undefined)).toBe("settled");
    expect(normalizeLifecycle("nonsense")).toBe("settled");
    expect(normalizeLifecycle("running")).toBe("running");
    expect(normalizeLifecycle("stopped")).toBe("stopped");
  });

  it("accepts only the three pinned sources", () => {
    expect(normalizeStageSource("swarm")).toBe("swarm");
    expect(normalizeStageSource("direct")).toBe("direct");
    expect(normalizeStageSource("user_testing")).toBe("user_testing");
    expect(normalizeStageSource("eval")).toBeNull();
    expect(normalizeStageSource(undefined)).toBeNull();
  });
});

describe("the assembled input", () => {
  it("carries only the evidence that actually narrowed", () => {
    const result = normalizeClaimedEvidence(
      claim({
        source: "swarm",
        evidence: {
          lifecycle: "settled",
          readiness: { status: "junk" },
          criteria: null,
          goalScore: { status: "completed", passed: true },
        },
        envelope: {
          messages: [{ role: "user", content: "book" }],
          spans: [{ id: "s1", category: "tool", status: "ok" }],
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toEqual({
      source: "swarm",
      hasUserAsk: true,
      lifecycle: "settled",
      spans: [{ id: "s1", category: "tool", status: "ok" }],
      goalJudge: { status: "completed", passed: true },
    });
  });
});
