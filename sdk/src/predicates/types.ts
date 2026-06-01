/**
 * State-based predicate system for deterministic eval gating.
 *
 * A {@link Predicate} is a declarative assertion over a single iteration's
 * transcript. Predicates are the **gate**: a pure function of the transcript
 * yields the same verdict every time (same transcript → same result), which is
 * the property a CI release gate requires and a stochastic LLM judge cannot
 * provide. The `serverQuality` LLM judge remains the advisory **insight** layer.
 *
 * The union is intentionally small (8 types). It grows only when a real corpus
 * task demands a new one — not speculatively.
 *
 * Hosted in `@mcpjam/sdk` (browser-safe; reuses the `../matchers` argument
 * engine) so the inspector GUI runner and the `mcpjam eval` CLI share one
 * implementation.
 */

import type { EvalMatchOptions } from "../matchers.js";

/**
 * Argument-matching mode reused from the eval matcher
 * (`EvalMatchOptions.argumentMatching`):
 *
 *   - `"partial"` (default) — only the keys present in `args` are checked;
 *     the actual call may carry extra keys; placeholder strings like
 *     `"string"`/`"number"`/`"any"` are interpreted as type checks.
 *   - `"exact"`   — deep equality on the args object; no extras, no placeholders.
 *   - `"ignore"`  — arguments are not compared (only the tool name matters).
 */
export type ArgMatchMode = NonNullable<EvalMatchOptions["argumentMatching"]>;

/**
 * Expected-argument matcher for {@link Predicate} `toolCalledWith`.
 *
 * `args` is the expected argument shape; `argumentMatching` selects the
 * semantics. Reuses the exact same engine as the tool-call matcher so a
 * predicate and the existing `expectedToolCalls` matcher agree on what
 * "these args match" means.
 */
export type ArgMatcher = {
  args: Record<string, unknown>;
  /** Defaults to `"partial"` when omitted. */
  argumentMatching?: ArgMatchMode;
};

/**
 * The deterministic predicate library.
 *
 * Discriminated on `type`. Each variant is evaluated by a pure function over
 * the {@link IterationTranscript}.
 */
export type Predicate =
  /** A call to `toolName` whose args satisfy `args` occurred at least `minCount` (default 1) times. */
  | { type: "toolCalledWith"; toolName: string; args: ArgMatcher; minCount?: number }
  /** `toolName` was called at least once (args irrelevant). */
  | { type: "toolCalledAtLeastOnce"; toolName: string }
  /** `toolName` was never called (forbidden tool). */
  | { type: "toolNeverCalled"; toolName: string }
  /** The final assistant message contains `needle`. Case-insensitive unless `caseSensitive`. */
  | { type: "responseContains"; needle: string; caseSensitive?: boolean }
  /** The final assistant message matches the regular expression `pattern` (regex source, no flags). */
  | { type: "responseMatches"; pattern: string }
  /** No tool produced an error (neither MCP `isError: true` nor a JSON-RPC/transport failure). */
  | { type: "noToolErrors" }
  /** The final assistant message is a non-empty (non-whitespace) string. */
  | { type: "finalAssistantMessageNonEmpty" }
  /** Total token usage for the iteration is strictly under `tokens`. */
  | { type: "tokenBudgetUnder"; tokens: number };

/** The `type` discriminants of {@link Predicate}, for validators. */
export type PredicateType = Predicate["type"];

/**
 * How a tool failure surfaced. The plan requires `noToolErrors` to distinguish
 * these two cases (and report which fired), matching the runner's existing
 * `traceIndicatesToolExecutionFailure` gate, which treats both as failures:
 *
 *   - `"content-error"`  — an MCP `CallToolResult` with `isError: true`. The
 *     tool executed and reported a domain error the protocol-correct way.
 *   - `"protocol-error"` — a JSON-RPC / transport-level failure (the AI SDK
 *     `tool-error` stream part, or an errored tool span). The call itself
 *     failed; no protocol-correct result was produced.
 */
export type ToolErrorKind = "content-error" | "protocol-error";

/** A single detected tool failure, used by the `noToolErrors` predicate. */
export type ToolErrorRecord = {
  toolName?: string;
  kind: ToolErrorKind;
  /** Optional human-readable detail surfaced in the predicate reason. */
  message?: string;
};

/** Token usage totals for an iteration. */
export type TranscriptUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** A tool call observed in the transcript: `{ toolName, arguments }`. */
export type TranscriptToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

/**
 * The stable input shape predicates evaluate against.
 *
 * Deliberately minimal: it carries exactly what the 8 V1 predicates need and
 * nothing else, so it can be produced both by the live eval runner (which maps
 * its internal per-iteration state onto this shape) and by hand-authored test
 * fixtures. New predicates that need more signal extend this type.
 */
export type IterationTranscript = {
  /** Ordered tool calls across all turns of the iteration. */
  toolCalls: TranscriptToolCall[];
  /** Tool failures detected over the iteration trace. Absent/empty ⇒ no errors. */
  toolErrors?: ToolErrorRecord[];
  /** Text of the final assistant message of the iteration, if any. */
  finalAssistantMessage?: string;
  /** Token usage totals for the whole iteration, if measured. */
  usage?: TranscriptUsage;
};

/** Per-predicate verdict row, persisted to `testIteration.metadata.predicates`. */
export type PredicateResult = {
  predicate: Predicate;
  passed: boolean;
  /** Structured, deterministic explanation — names the expected vs actual on failure. */
  reason: string;
};
