import { describe, it, expect } from "vitest";
import {
  isGateEligible,
  validateCorpusCase,
  validatePredicate,
  validateSuite,
} from "../src/corpus/validate";
import type { CorpusCase } from "../src/corpus/types";

const validTraceHumanReviewed: CorpusCase = {
  id: "booking.cancel.refund",
  title: "Cancel booking issues refund",
  server: "booking-mcp",
  query: "Cancel my flight and confirm the refund.",
  expectedToolCalls: [{ toolName: "cancel_booking", arguments: { id: "abc" } }],
  successPredicates: [
    { type: "toolCalledAtLeastOnce", toolName: "cancel_booking" },
    { type: "responseContains", needle: "refund issued" },
  ],
  reviewStatus: "human_reviewed",
  category: "single-mutation",
  provenance: {
    source: "trace",
    draftingModel: "claude-haiku-4-5",
    reviewedBy: "marcelo",
    reviewedAt: "2026-05-31T00:00:00Z",
    traceId: "trace_1",
    chatSessionId: "sess_1",
    promptIndex: 0,
    hostConfigId: "host_1",
    toolSnapshotHashAtTurn: "deadbeef",
    privacyReview: {
      reviewed: true,
      reviewedBy: "marcelo",
      reviewedAt: "2026-05-31T00:00:00Z",
    },
  },
};

const validToolbenchDraft: CorpusCase = {
  id: "search.empty-result",
  title: "Search returns empty without erroring",
  server: "search-mcp",
  query: "Find unicorns in inventory.",
  expectedToolCalls: [{ toolName: "search", arguments: {} }],
  successPredicates: [{ type: "noToolErrors" }],
  reviewStatus: "llm_draft",
  provenance: {
    source: "toolbench",
    draftingModel: "gpt-5-mini",
    toolbenchSnapshotKey: "toolbench-2026-05-31-fast-v1",
    toolbenchId: "tb_123",
    originalIssueIds: ["issue_1"],
  },
};

const clone = <T>(v: T): T => structuredClone(v);

describe("validateCorpusCase — happy paths", () => {
  it("accepts a complete human_reviewed trace case", () => {
    const result = validateCorpusCase(validTraceHumanReviewed);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a complete toolbench llm_draft case", () => {
    expect(validateCorpusCase(validToolbenchDraft).ok).toBe(true);
  });

  it("accepts a trace case that uses a manual tool-inventory note instead of a hash", () => {
    const c = clone(validTraceHumanReviewed);
    delete (c.provenance as { toolSnapshotHashAtTurn?: string }).toolSnapshotHashAtTurn;
    (c.provenance as { manualToolInventoryNote?: string }).manualToolInventoryNote =
      "Verified booking-mcp exposed cancel_booking at the original turn.";
    expect(validateCorpusCase(c).ok).toBe(true);
  });
});

describe("gate eligibility — only human_reviewed may gate", () => {
  it("human_reviewed valid case is gate eligible", () => {
    expect(isGateEligible(validTraceHumanReviewed)).toBe(true);
  });

  it("llm_draft case is NOT gate eligible even when otherwise complete", () => {
    const c = clone(validTraceHumanReviewed);
    c.reviewStatus = "llm_draft";
    // Still structurally valid…
    expect(validateCorpusCase(c).ok).toBe(true);
    // …but never a gate.
    expect(isGateEligible(c)).toBe(false);
  });

  it("toolbench draft is not gate eligible", () => {
    expect(isGateEligible(validToolbenchDraft)).toBe(false);
  });
});

describe("human_reviewed requires reviewer metadata and non-empty predicates", () => {
  it("fails when reviewer metadata is missing", () => {
    const c = clone(validTraceHumanReviewed);
    delete (c.provenance as { reviewedBy?: string }).reviewedBy;
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("reviewedBy");
    expect(isGateEligible(c)).toBe(false);
  });

  it("fails when the predicate set is empty", () => {
    const c = clone(validTraceHumanReviewed);
    c.successPredicates = [];
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("successPredicates");
    expect(isGateEligible(c)).toBe(false);
  });

  it("fails when reviewedAt timestamp is missing", () => {
    const c = clone(validTraceHumanReviewed);
    delete (c.provenance as { reviewedAt?: string }).reviewedAt;
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("reviewedAt");
    expect(isGateEligible(c)).toBe(false);
  });
});

describe("a completed privacy review must be attributable", () => {
  it("fails when privacyReview.reviewed is true but reviewer is missing", () => {
    const c = clone(validTraceHumanReviewed);
    delete (c.provenance as { privacyReview: { reviewedBy?: string } }).privacyReview
      .reviewedBy;
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("privacyReview.reviewedBy");
  });

  it("fails when privacyReview.reviewed is true but timestamp is missing", () => {
    const c = clone(validTraceHumanReviewed);
    delete (c.provenance as { privacyReview: { reviewedAt?: string } }).privacyReview
      .reviewedAt;
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("privacyReview.reviewedAt");
  });
});

describe("trace provenance requirements", () => {
  it("requires either a tool-snapshot hash or a manual note", () => {
    const c = clone(validTraceHumanReviewed);
    delete (c.provenance as { toolSnapshotHashAtTurn?: string }).toolSnapshotHashAtTurn;
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("toolSnapshotHashAtTurn");
  });

  it("requires privacy review to be completed before promotion", () => {
    const c = clone(validTraceHumanReviewed);
    (c.provenance as { privacyReview: { reviewed: boolean } }).privacyReview.reviewed = false;
    const result = validateCorpusCase(c);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("privacyReview");
  });

  it.each(["traceId", "chatSessionId", "hostConfigId"] as const)(
    "requires structural field %s",
    (field) => {
      const c = clone(validTraceHumanReviewed);
      delete (c.provenance as Record<string, unknown>)[field];
      expect(validateCorpusCase(c).ok).toBe(false);
    },
  );

  it("requires promptIndex to be a non-negative integer", () => {
    const c = clone(validTraceHumanReviewed);
    (c.provenance as { promptIndex: unknown }).promptIndex = -1;
    expect(validateCorpusCase(c).ok).toBe(false);
  });
});

describe("toolbench provenance requirements", () => {
  it.each(["toolbenchSnapshotKey", "toolbenchId"] as const)(
    "requires %s",
    (field) => {
      const c = clone(validToolbenchDraft);
      delete (c.provenance as Record<string, unknown>)[field];
      expect(validateCorpusCase(c).ok).toBe(false);
    },
  );

  it("requires non-empty originalIssueIds", () => {
    const c = clone(validToolbenchDraft);
    (c.provenance as { originalIssueIds: string[] }).originalIssueIds = [];
    expect(validateCorpusCase(c).ok).toBe(false);
  });
});

describe("predicate shape validation", () => {
  it("rejects an unknown predicate type", () => {
    expect(validatePredicate({ type: "totallyMadeUp" }).ok).toBe(false);
  });

  it("rejects a malformed predicate (missing required field)", () => {
    expect(validatePredicate({ type: "toolCalledWith", toolName: "x" }).ok).toBe(false);
  });

  it("rejects an invalid regex in responseMatches", () => {
    expect(
      validatePredicate({ type: "responseMatches", pattern: "([unterminated" }).ok,
    ).toBe(false);
  });

  it("accepts each well-formed predicate type", () => {
    const ok = [
      { type: "toolCalledWith", toolName: "x", args: { args: { a: 1 } } },
      { type: "toolCalledAtLeastOnce", toolName: "x" },
      { type: "toolNeverCalled", toolName: "x" },
      { type: "responseContains", needle: "hi" },
      { type: "responseMatches", pattern: "\\d+" },
      { type: "noToolErrors" },
      { type: "finalAssistantMessageNonEmpty" },
      { type: "tokenBudgetUnder", tokens: 1000 },
    ];
    for (const p of ok) expect(validatePredicate(p).ok).toBe(true);
  });

  it("a case carrying an unknown predicate fails corpus validation", () => {
    const c = clone(validTraceHumanReviewed) as unknown as {
      successPredicates: unknown[];
    };
    c.successPredicates = [{ type: "nope" }];
    expect(validateCorpusCase(c).ok).toBe(false);
  });
});

describe("validateSuite", () => {
  it("reports per-case results and collects only gate-eligible cases", () => {
    const suite = [
      validTraceHumanReviewed, // gate eligible
      validToolbenchDraft, // valid but draft → not eligible
      { ...clone(validTraceHumanReviewed), id: "broken", successPredicates: [] }, // invalid
    ];
    const result = validateSuite(suite);
    expect(result.ok).toBe(false); // one invalid case
    expect(result.cases).toHaveLength(3);
    expect(result.gateEligible.map((c) => c.id)).toEqual(["booking.cancel.refund"]);
  });
});
