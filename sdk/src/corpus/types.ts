/**
 * Reference eval corpus case shape.
 *
 * Corpus cases live as checked-in JSON at `eval-corpus/v1/<task>.json` (version
 * control, not Convex) so they are PR-reviewable, forkable/citeable on GitHub,
 * and readable without Convex auth. A {@link CorpusCase} is a thin wrapper
 * around the inspector/SDK `EvalCase` fields (`title`, `query`,
 * `expectedToolCalls`, `successPredicates`) plus corpus-only metadata
 * (`reviewStatus`, `provenance`, `notes`). At run time a corpus case is
 * projected into an eval case — the harness supplies `model`/`provider`/`runs`
 * — and goes through the same runner as user-defined cases.
 *
 * The load-bearing rule lives in `validate.ts`: only `human_reviewed` cases may
 * be used as CI gates. `llm_draft` cases are an authoring/review queue, never a
 * gate.
 */

import type { Predicate } from "../predicates/types.js";
import type { ToolCall } from "../types.js";

/**
 * `llm_draft` — drafted by an LLM from a trace or ToolBench seed; a review-queue
 * entry, never a gate. `human_reviewed` — a human verified, sanitized, and
 * promoted the case; the only status usable with `--gate`.
 */
export type ReviewStatus = "llm_draft" | "human_reviewed";

/** Where a draft was sourced from. Human review is metadata layered on top. */
export type ProvenanceSource = "trace" | "toolbench";

/**
 * Privacy-review record for trace-derived cases. Trace mining must not commit
 * raw private prompts/responses/secrets/workspace ids; the committed case is a
 * sanitized, runnable workflow with enough provenance to audit internally.
 */
export type PrivacyReview = {
  /** True once a human confirmed the case carries no private/customer data. */
  reviewed: boolean;
  reviewedBy?: string;
  /** ISO-8601 timestamp. */
  reviewedAt?: string;
  notes?: string;
};

/** Fields common to every provenance variant. */
type ProvenanceBase = {
  source: ProvenanceSource;
  /**
   * Model that drafted the case. Should NOT be the production `serverQuality`
   * judge model — avoiding self-reinforcement improves the review queue.
   */
  draftingModel: string;
  /** Set when a human promotes the draft to `human_reviewed`. */
  reviewedBy?: string;
  /** ISO-8601 timestamp; set on promotion. */
  reviewedAt?: string;
};

/** Provenance for a case mined from real `chatSessionTurnTraces` + `hostConfigs`. */
export type TraceProvenance = ProvenanceBase & {
  source: "trace";
  traceId: string;
  chatSessionId: string;
  promptIndex: number;
  modelId?: string;
  hostConfigId: string;
  /**
   * Hash of the tool inventory available at the original turn. Required for
   * automated trace mining; when absent, {@link manualToolInventoryNote} must
   * explain how tool availability was reconstructed/verified by hand.
   */
  toolSnapshotHashAtTurn?: string;
  /** Required iff {@link toolSnapshotHashAtTurn} is absent. */
  manualToolInventoryNote?: string;
  /** Sampled span / tool-call summary captured for audit. */
  spanSummary?: string;
  /** Mandatory privacy review for trace-derived cases. */
  privacyReview: PrivacyReview;
};

/** Provenance for a fallback/public case drafted from a ToolBench seed. */
export type ToolBenchProvenance = ProvenanceBase & {
  source: "toolbench";
  toolbenchSnapshotKey: string;
  toolbenchId: string;
  /** Source issue ids the seed was derived from. */
  originalIssueIds: string[];
};

export type Provenance = TraceProvenance | ToolBenchProvenance;

/**
 * Stratification category. Tasks should spread across these so the corpus
 * exercises read-only, mutating, multi-step, recovery, and large-output paths.
 */
export type CorpusCategory =
  | "read-only"
  | "single-mutation"
  | "multi-step"
  | "error-recovery"
  | "large-output";

export type CorpusCase = {
  /** Stable identifier, e.g. `booking.cancel.refund`. */
  id: string;
  title: string;
  /** Target MCP server identifier the task runs against. */
  server: string;
  /** The user prompt that drives the agent. */
  query: string;
  expectedToolCalls: ToolCall[];
  /** The deterministic gate. Must be non-empty to promote to `human_reviewed`. */
  successPredicates: Predicate[];
  reviewStatus: ReviewStatus;
  provenance: Provenance;
  category?: CorpusCategory;
  /** Human-authored intent / design notes. */
  notes?: string;
};
