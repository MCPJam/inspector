/**
 * State-based predicate system for deterministic eval gating.
 *
 * A {@link Predicate} is a declarative assertion over a single iteration's
 * transcript. Predicates are the **gate**: a pure function of the transcript
 * yields the same verdict every time (same transcript → same result), which is
 * the property a CI release gate requires and a stochastic LLM judge cannot
 * provide. The `serverQuality` LLM judge remains the advisory **insight** layer.
 *
 * The union is intentionally small (12 types). It grows only when a real corpus
 * task demands a new one — not speculatively.
 *
 * Hosted in `@mcpjam/sdk` (browser-safe; reuses the `../matchers` argument
 * engine) so the inspector GUI runner and the `mcpjam eval` CLI share one
 * implementation.
 */

import { z } from "zod";
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
  /** The first tool call observed in the transcript was `toolName`. */
  | { type: "firstToolWas"; toolName: string }
  /** The final assistant message contains `needle`. Case-insensitive unless `caseSensitive`. */
  | { type: "responseContains"; needle: string; caseSensitive?: boolean }
  /** The final assistant message matches the regular expression `pattern` (regex source, no flags). */
  | { type: "responseMatches"; pattern: string }
  /** No tool produced an error (neither MCP `isError: true` nor a JSON-RPC/transport failure). */
  | { type: "noToolErrors" }
  /** The final assistant message is a non-empty (non-whitespace) string. */
  | { type: "finalAssistantMessageNonEmpty" }
  /** Total token usage for the iteration is strictly under `tokens`. */
  | { type: "tokenBudgetUnder"; tokens: number }
  /**
   * At least one widget render observation (narrowed to `toolName` when set)
   * has `status === "rendered"`. Fails closed when the iteration recorded no
   * render observations in scope.
   */
  | { type: "widgetRendered"; toolName?: string }
  /**
   * Every rendered widget observation (narrowed to `toolName` when set) mounted
   * in strictly under `ms` milliseconds. Fails closed when no observation in
   * scope rendered — an unrendered widget has no latency to attest.
   */
  | { type: "widgetRenderLatencyUnder"; ms: number; toolName?: string }
  /**
   * No widget render observation (narrowed to `toolName` when set) captured
   * console errors. Fails closed when the iteration recorded no render
   * observations in scope.
   */
  | { type: "widgetNoConsoleErrors"; toolName?: string };

/** The `type` discriminants of {@link Predicate}, for validators. */
export type PredicateType = Predicate["type"];

// ─── Zod schemas ──────────────────────────────────────────────────────────
//
// The predicate union is the wire shape both the inspector forms and the
// `mcpjam eval` CLI persist into Convex. Convex has its own hand-mirrored
// `v.union` (Hard Constraint 1: no `@mcpjam/sdk` imports in `convex/`).
// Parity between the two is proven via the JSON fixtures in
// `sdk/tests/fixtures/predicates-parity-fixtures.json` (and its sibling in
// `mcpjam-backend`). Adding a 10th kind requires editing both validator files
// and the fixtures in the same PR.

/**
 * Placeholder strings the matcher's `partial` mode treats as type checks
 * instead of literal equality. Exposed as a Zod literal union so authoring
 * UIs can offer them as drop-down options when constructing arg matchers.
 *
 * The actual leaf may also be any JSON literal (string/number/boolean/object/
 * array/null) — that's not captured here because the args blob is
 * `z.record(z.string(), z.unknown())` at the wire boundary.
 */
export const PREDICATE_PLACEHOLDER_STRINGS = [
  "any",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
] as const;

/** Zod schema for {@link ArgMatcher}. `args` is unrestricted JSON. */
export const argMatcherSchema = z.object({
  args: z.record(z.string(), z.unknown()),
  argumentMatching: z.enum(["exact", "partial", "ignore"]).optional(),
});

/**
 * Zod schema for {@link Predicate}. Uses `z.discriminatedUnion` on `type`
 * so authoring-side validation surfaces a precise error (e.g. "unknown
 * predicate type 'firstToolWass'") rather than a generic union failure.
 */
export const predicateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("toolCalledWith"),
    toolName: z.string().min(1),
    args: argMatcherSchema,
    minCount: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("toolCalledAtLeastOnce"),
    toolName: z.string().min(1),
  }),
  z.object({
    type: z.literal("toolNeverCalled"),
    toolName: z.string().min(1),
  }),
  z.object({
    type: z.literal("firstToolWas"),
    toolName: z.string().min(1),
  }),
  z.object({
    type: z.literal("responseContains"),
    needle: z.string().min(1),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("responseMatches"),
    pattern: z
      .string()
      .min(1)
      .refine(
        (p) => {
          try {
            new RegExp(p);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Invalid regular expression" },
      ),
  }),
  z.object({
    type: z.literal("noToolErrors"),
  }),
  z.object({
    type: z.literal("finalAssistantMessageNonEmpty"),
  }),
  z.object({
    type: z.literal("tokenBudgetUnder"),
    tokens: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("widgetRendered"),
    toolName: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("widgetRenderLatencyUnder"),
    ms: z.number().int().positive(),
    toolName: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("widgetNoConsoleErrors"),
    toolName: z.string().min(1).optional(),
  }),
]);

/** Array of predicates — used for both suite defaults and case overrides. */
export const predicateArraySchema = z.array(predicateSchema);

/**
 * Case-level predicate override envelope. The {@link mode} eliminates the
 * `predicates`/`additionalPredicates` ambiguity (see plan Phase 2):
 *
 *   - `inherit` — effective predicates = suite defaults (`list` ignored).
 *   - `replace` — effective predicates = `list`.
 *   - `extend`  — effective predicates = suite defaults followed by `list`.
 */
export const casePredicatesSchema = z.object({
  mode: z.enum(["inherit", "replace", "extend"]),
  list: z.array(predicateSchema),
});

export type CasePredicates = z.infer<typeof casePredicatesSchema>;
export type PredicatePlaceholder =
  (typeof PREDICATE_PLACEHOLDER_STRINGS)[number];

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
 * Outcome states of an MCP App widget render attempt. Hand-mirror of the
 * inspector's `EvalTraceWidgetRenderStatus` (shared/eval-trace.ts) — the SDK
 * stays import-free of the inspector app, same arrangement as the Convex
 * validator mirror. Only `"rendered"` means success; every other literal names
 * the stage that failed.
 */
export type RenderObservationStatus =
  | "rendered"
  | "no_ui_resource"
  | "resource_read_failed"
  | "mount_failed"
  | "bridge_timeout"
  | "render_error"
  | "blank_screenshot"
  | "screenshot_failed"
  | "browser_unavailable";

/**
 * Screenshot-free summary of one widget render observation, carried on the
 * transcript for the `widget*` predicates. The runner maps its richer
 * `RunnerWidgetRenderObservation` (base64 screenshot, blocked requests, …)
 * down to this shape; fixtures author it directly.
 */
export type RenderObservationSummary = {
  toolCallId?: string;
  toolName: string;
  serverId?: string;
  status: RenderObservationStatus;
  elapsedMs: number;
  consoleErrors?: string[];
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
  /**
   * Widget render observations recorded over the iteration, if any. Absent ⇒
   * the `widget*` predicates fail closed (no signal is not a pass).
   */
  renderObservations?: RenderObservationSummary[];
};

/** Per-predicate verdict row, persisted to `testIteration.metadata.predicates`. */
export type PredicateResult = {
  predicate: Predicate;
  passed: boolean;
  /** Structured, deterministic explanation — names the expected vs actual on failure. */
  reason: string;
};
