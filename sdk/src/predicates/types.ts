/**
 * State-based predicate system for deterministic eval gating.
 *
 * A {@link Predicate} is a declarative assertion over a single iteration's
 * transcript. Predicates are the **gate**: a pure function of the transcript
 * yields the same verdict every time (same transcript → same result), which is
 * the property a CI release gate requires and a stochastic LLM judge cannot
 * provide. The `serverQuality` LLM judge remains the advisory **insight** layer.
 *
 * The union grows only when a real corpus task demands a new kind — not
 * speculatively. Kinds split three ways by METHOD, and the method decides
 * what a kind may claim: measurement against an author-set threshold,
 * deterministic validation, or a heuristic. Heuristics are named in
 * {@link OBSERVATION_PREDICATE_KINDS} and may never gate.
 *
 * Hosted in `@mcpjam/sdk` (browser-safe; reuses the `../matchers` argument
 * engine) so the inspector GUI runner and the `mcpjam cloud eval` CLI share one
 * implementation.
 */

import { z } from "zod";
import type { EvalMatchOptions } from "../matchers.js";
import type { CheckPolicy } from "./policy.js";

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
 * the {@link IterationTranscript}. Intersected with {@link CheckPolicy} so
 * any kind can be marked advisory (`role: "advisory"`, `severity: "warn"`)
 * without a parallel field.
 */
export type Predicate = (
  /** A call to `toolName` whose args satisfy `args` occurred at least `minCount` (default 1) times. */
  | {
      type: "toolCalledWith";
      toolName: string;
      args: ArgMatcher;
      minCount?: number;
    }
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
  | { type: "widgetNoConsoleErrors"; toolName?: string }
  /**
   * The iteration used STRICTLY FEWER than `turns` user turns.
   *
   * A "turn" is one user-role message in the transcript, so this expresses
   * "resolved in under N turns" without conflating it with a run's `maxTurns`
   * cap — that bounds the agent loop, this grades the outcome. Fails closed
   * when the transcript carries no turn count: an unmeasured budget is not a
   * met budget.
   */
  | { type: "turnCountUnder"; turns: number }
  /**
   * OBSERVATION. The final assistant message does not end with a question.
   *
   * What it sees is exactly what it says: the last non-empty line of the final
   * message, and whether it ends in `?`. It does NOT distinguish an answer that
   * stopped to ask for a missing parameter from a complete answer that ends by
   * offering more ("Would you like a breakdown?"), and the label must never
   * call it "clarifying". Report-only for that reason; the corpus holds both
   * shapes.
   */
  | { type: "noEndingQuestion" }
  /**
   * Every observed call in scope settled in strictly under `ms`.
   *
   * MEASUREMENT against an author-set threshold, so it may gate. Latency alone
   * is never a verdict: nothing derives one from a duration unless the author
   * wrote the ceiling down here.
   *
   * `status: "error"` — never a pass, never a fail — when the capture carries
   * no timing for the calls in scope. A harness that narrated its calls has no
   * measurement to attest, and an unmeasured budget is not a met budget.
   */
  | { type: "toolLatencyUnder"; ms: number; toolName?: string }
  /** A tool result in scope contains `needle`. Case-insensitive unless set. */
  | {
      type: "toolResultContains";
      needle: string;
      caseSensitive?: boolean;
      toolName?: string;
    }
  /**
   * Every tool result in scope validates against the authored JSON Schema.
   *
   * Any JSON root: protocol 2026-07-28 dropped 2025-11-25's object-only
   * restriction on `structuredContent`, so requiring an object here would fail
   * servers that are correct under the current spec.
   */
  | { type: "toolResultMatchesSchema"; schema: unknown; toolName?: string }
  /**
   * Every tool result in scope is strictly under `maxBytes`.
   *
   * Graded on what the SERVER returned, measured before our own storage cap —
   * see {@link TranscriptToolResultSize}. Bytes, not tokens: tokens are an
   * estimate and a budget must be graded on a measurement.
   */
  | { type: "toolResultSizeUnder"; maxBytes: number; toolName?: string }
  /**
   * Every observed call's arguments validate against the tool's DECLARED
   * `inputSchema`.
   *
   * Deterministic validation of the server's own contract, so it may gate.
   * Violations are classified — a missing required property, a wrong type, a
   * value outside an enum, a key a closed schema forbids — because those are
   * four different notes to a server developer.
   *
   * WHAT IT DOES NOT DO: schema validity does not establish that the arguments
   * match the user's intent. A search for closed web tickets when the user
   * asked about open mobile bugs is schema-perfect. Semantic mismatch stays a
   * judged question.
   */
  | { type: "argumentsMatchToolSchema"; toolName?: string }
  /**
   * OBSERVATION. No call repeated the one immediately before it with equal
   * arguments.
   *
   * A poll loop and a retry after a transient failure are both exactly this
   * shape, and both are correct. Report-only for that reason; the corpus holds
   * both counterexamples.
   */
  | { type: "noRepeatedIdenticalCall"; toolName?: string }
  /** Strictly fewer than `count` calls in scope. Measurement vs a ceiling. */
  | { type: "toolCallCountUnder"; count: number; toolName?: string }
  /**
   * Every call to `beforeToolName` was preceded by a call to `toolName`.
   *
   * Deterministic validation of an authored route. Vacuously true when
   * `beforeToolName` never ran — the rule has nothing to violate.
   */
  | { type: "toolCalledBefore"; toolName: string; beforeToolName: string }
  /**
   * OBSERVATION. No called tool's own description marks it deprecated.
   *
   * A regex over a description is a heuristic: "Replaces the deprecated
   * `old_search` tool" describes a CURRENT tool. Anchored to self-deprecation
   * to keep that case out, and Report/Warn only because the anchor is still a
   * guess about prose.
   */
  | { type: "noDeprecatedToolCalled" }
  /**
   * No called tool declares `annotations.destructiveHint: true`.
   *
   * Deterministic validation, not a guess: an annotation is the server's own
   * DECLARATION. The author asserts the prompt is read-only by adding this
   * check; the predicate only reads the hint. `status: "error"` when no tool
   * in the inventory carries annotations at all — a pass there would read as
   * "nothing destructive was called".
   */
  | { type: "noDestructiveToolCalled" }
  /**
   * OBSERVATION. Every tool error message names one of that tool's input keys,
   * or a value the call actually sent.
   *
   * NOT a measure of recovery quality. "Rate limited. Retry in 30 seconds." is
   * exactly what a good error looks like and names nothing; naming an input
   * would add nothing to it. The label says what was seen — "a tool error did
   * not name an input" — and the quality question stays with the judge.
   */
  | { type: "toolErrorNamesInput"; toolName?: string }
  /**
   * OBSERVATION. A page whose length equals its requested limit carries
   * recognized continuation metadata.
   *
   * A FULL PAGE IS NOT PROOF MORE RESULTS EXIST — 25 of 25 may be all there
   * is. The label therefore reads "a full page carried no continuation
   * metadata" and never "truncated".
   */
  | { type: "fullPageHasContinuation"; toolName?: string }
) & CheckPolicy;

/** The `type` discriminants of {@link Predicate}, for validators. */
export type PredicateType = Predicate["type"];

/**
 * Predicate kinds that may be authored on an individual prompt turn (evaluated
 * against that turn's slice of the transcript).
 *
 * A kind is turn-scopable when its EVIDENCE exists in a turn slice.
 * `buildTurnTranscript` carries the turn's tool calls, tool errors, assistant
 * message and render observations — and nothing else. So the case-only kinds
 * are:
 *
 *   - `tokenBudgetUnder` / `turnCountUnder` — per-turn token usage is not
 *     captured, and a turn's own turn count is always 1;
 *   - every kind that reads tool RESULTS, per-call TIMINGS or the tool
 *     INVENTORY — a turn slice carries none of the three, so a turn-scoped
 *     one would report `status: "error"` on every turn.
 *
 * Mirrored in `mcpjam-backend/convex/lib/predicates.ts`
 * (`TURN_SCOPABLE_PREDICATE_KINDS`). Used by the per-turn "Add check" menu and
 * the backend write-time guard.
 */
export const TURN_SCOPABLE_PREDICATE_KINDS = [
  "toolCalledWith",
  "toolCalledAtLeastOnce",
  "toolNeverCalled",
  "firstToolWas",
  "responseContains",
  "responseMatches",
  "noToolErrors",
  "finalAssistantMessageNonEmpty",
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
  "noEndingQuestion",
  // Read only the turn's own calls, which `buildTurnTranscript` carries.
  "toolCallCountUnder",
  "toolCalledBefore",
  "noRepeatedIdenticalCall",
] as const satisfies readonly PredicateType[];

export function isTurnScopablePredicateKind(kind: string): boolean {
  return (TURN_SCOPABLE_PREDICATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Predicates that need `renderObservations` — the widget render status, latency
 * and console errors that ONLY the hosted headless-browser runner captures.
 *
 * They fail closed on an empty scope (a missing observation is not a pass), so
 * authoring one where nothing can produce observations means a guaranteed
 * failure with a confusing reason rather than a skip. Code-first callers get a
 * construction-time error instead; see `assertLocallyEvaluablePredicates`.
 */
export const RENDER_OBSERVATION_PREDICATE_KINDS = [
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
] as const satisfies readonly PredicateType[];

export function requiresRenderObservations(kind: string): boolean {
  return (RENDER_OBSERVATION_PREDICATE_KINDS as readonly string[]).includes(
    kind
  );
}

/**
 * OBSERVATION kinds — heuristics, not objective quality tests.
 *
 * Each of these is a pattern that can be right about what it saw and still be
 * wrong about what it means. "Ends with a question" is true of "Would you like
 * a breakdown?"; an identical repeat is what a poll loop looks like; a full
 * page is not proof that more results exist. A deterministic implementation
 * does not make any of that an objective grade.
 *
 * So the policy is one rule carried through validation and presentation:
 * an observation kind is **Warn or Report only**. It is refused as gating at
 * the write boundary (here, and in the backend's `assertValidPredicate`), it
 * is not offered a Gate segment in the UI, it is never promoted into
 * `expectedToolCalls`, and it never enters `allGatingScorersPassed`.
 *
 * Mirrored in `mcpjam-backend/convex/lib/predicates.ts`
 * (`OBSERVATION_PREDICATE_KINDS`) and proven by the shared parity fixtures.
 */
export const OBSERVATION_PREDICATE_KINDS = [
  "noEndingQuestion",
  "noRepeatedIdenticalCall",
  "noDeprecatedToolCalled",
  "toolErrorNamesInput",
  "fullPageHasContinuation",
] as const satisfies readonly PredicateType[];

export function isObservationPredicateKind(kind: string): boolean {
  return (OBSERVATION_PREDICATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Author-content caps, enforced at the schema so an oversized predicate is
 * refused where it is written rather than truncated where it is read.
 *
 * `schema` and `needle` are AUTHOR content: they are capped, never redacted —
 * redaction would destroy the assertion's meaning. Live-run values
 * interpolated into reasons go through the evaluator's `brief()`/`redact()`.
 * Mirrored by the backend's `assertValidPredicate`.
 */
export const MAX_NEEDLE_CHARS = 1000;
export const MAX_SCHEMA_BYTES = 16 * 1024;

/** UTF-8 byte length of a value's canonical JSON, or `Infinity` if uncanonical. */
function canonicalSize(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return Infinity;
    // `Buffer` is Node-only and this module is browser-safe.
    return new TextEncoder().encode(json).length;
  } catch {
    return Infinity;
  }
}

// ─── Zod schemas ──────────────────────────────────────────────────────────
//
// The predicate union is the wire shape both the inspector forms and the
// `mcpjam cloud eval` CLI persist into Convex. Convex has its own hand-mirrored
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
 * Policy fields spread into every predicate variant. `severity` is only
 * valid with `role: "advisory"` — enforced by {@link predicateSchema}'s
 * `superRefine`, not here, so the underlying discriminated union keeps
 * `.options` for kind lists (do not read `.options` from the refinement).
 */
const checkPolicyShape = {
  role: z.enum(["gating", "advisory"]).optional(),
  severity: z.literal("warn").optional(),
};

/**
 * The underlying discriminated union. {@link PREDICATE_KINDS} and
 * {@link PredicateKind} read `.options` from THIS, never from the
 * refinement wrapper — a ZodEffects has no `.options`.
 */
export const predicateUnion = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("toolCalledWith"),
    toolName: z.string().min(1),
    args: argMatcherSchema,
    minCount: z.number().int().positive().optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolCalledAtLeastOnce"),
    toolName: z.string().min(1),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolNeverCalled"),
    toolName: z.string().min(1),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("firstToolWas"),
    toolName: z.string().min(1),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("responseContains"),
    needle: z.string().min(1),
    caseSensitive: z.boolean().optional(),
    ...checkPolicyShape,
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
        { message: "Invalid regular expression" }
      ),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("noToolErrors"),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("finalAssistantMessageNonEmpty"),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("tokenBudgetUnder"),
    tokens: z.number().int().positive(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("widgetRendered"),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("widgetRenderLatencyUnder"),
    ms: z.number().int().positive(),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("widgetNoConsoleErrors"),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("turnCountUnder"),
    // Positive: `< 0` and `< 1` with a zero floor can never be satisfied, so a
    // non-positive budget is an authoring mistake, not a strict gate.
    turns: z.number().int().positive(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("noEndingQuestion"),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolLatencyUnder"),
    ms: z.number().int().positive(),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolResultContains"),
    needle: z.string().min(1).max(MAX_NEEDLE_CHARS),
    caseSensitive: z.boolean().optional(),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolResultMatchesSchema"),
    // Author content, capped rather than inspected: a schema is a document,
    // and the cap is what keeps an unbounded one out of every persisted
    // predicate row. Shape is the validator engine's problem at evaluate time.
    schema: z
      .unknown()
      .refine(
        (value) => canonicalSize(value) <= MAX_SCHEMA_BYTES,
        `schema must canonicalize to at most ${MAX_SCHEMA_BYTES} bytes`
      ),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolResultSizeUnder"),
    maxBytes: z.number().int().positive(),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("argumentsMatchToolSchema"),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("noRepeatedIdenticalCall"),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolCallCountUnder"),
    count: z.number().int().positive(),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolCalledBefore"),
    toolName: z.string().min(1),
    beforeToolName: z.string().min(1),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("noDeprecatedToolCalled"),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("noDestructiveToolCalled"),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("toolErrorNamesInput"),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
  z.object({
    type: z.literal("fullPageHasContinuation"),
    toolName: z.string().min(1).optional(),
    ...checkPolicyShape,
  }),
]);

/**
 * Zod schema for {@link Predicate}. The discriminated union is refined so
 * `severity` requires `role: "advisory"`. Kind lists must read
 * {@link predicateUnion}.options, not this wrapper.
 */
export const predicateSchema = predicateUnion.superRefine((value, ctx) => {
  if (value.severity !== undefined && value.role !== "advisory") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["severity"],
      message: 'severity requires role: "advisory"',
    });
  }
  // An observation kind is a heuristic; a heuristic must not decide a release.
  // Refused at the schema rather than only hidden in the UI, so a CLI author,
  // a suite file and an API caller all hit the same rule.
  if (isObservationPredicateKind(value.type) && value.role !== "advisory") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["role"],
      message:
        `"${value.type}" is an observation (a heuristic) and cannot gate; ` +
        'set role: "advisory"',
    });
  }
});

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
export type { CheckPolicy } from "./policy.js";

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
  /**
   * The failing call's id, when the producer had it. Joins the error to the
   * ONE call whose arguments it should be read against; without it a check
   * over several calls to the same tool cannot say which invocation failed.
   */
  toolCallId?: string;
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
  /**
   * The AI SDK's call id, when the runner had it. Joins a call to its result
   * and its timing; absent on a fixture or a harness that does not mint one,
   * in which case the join falls back to tool name and order.
   */
  toolCallId?: string;
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
 * WHAT A RESULT'S BYTES WERE MEASURED ON.
 *
 * Three quantities get confused here and they are not the same number, so the
 * basis rides with every measurement rather than being assumed:
 *
 *   - `model_visible_output` — the serialized tool-result part as the model
 *     received it. This is what a payload budget is about.
 *   - `raw_result` — the whole `CallToolResult`, when the runner had it. Larger
 *     than the model-visible output whenever a server returns structured
 *     content beside its text.
 *
 * Neither is "context consumed": what a model's context actually holds is a
 * HOST fact, not a transcript one, and the transcript never claims it.
 *
 * Measured BEFORE the transcript's own text cap. Truncating for storage and
 * then grading the truncated number would report every oversized result as
 * exactly the cap.
 */
export type ToolResultSizeBasis = "model_visible_output" | "raw_result";

export type TranscriptToolResultSize = {
  bytes: number;
  basis: ToolResultSizeBasis;
  /**
   * False when the capture could not measure — a narration-only harness call,
   * an evidence row that spilled and could not be read back. A size check over
   * an incomplete row is `status: "error"`, never a pass.
   */
  complete: boolean;
};

/** One observed tool result, as far as the runner could capture it. */
export type TranscriptToolResult = {
  toolCallId?: string;
  toolName: string;
  /** Flattened model-visible text, capped. See `truncated`. */
  text?: string;
  /** True when `text` was capped for storage. Never changes `size.bytes`. */
  truncated?: boolean;
  /** `CallToolResult.structuredContent`, when the server returned it. */
  structuredContent?: unknown;
  /** The tool-result part's JSON output, when it carried one. */
  json?: unknown;
  /** MCP `isError` on the result. */
  isError?: boolean;
  size: TranscriptToolResultSize;
  /** Bytes of the raw `CallToolResult`, when the runner had it. */
  rawBytes?: number;
};

/**
 * How long one call took.
 *
 * `provenance` is load-bearing rather than decorative: `span` is a measured
 * envelope, `evidence` is a harness wire row's own timestamps. A harness that
 * only NARRATED a call produces neither, and emits no row at all — better an
 * absent measurement than a fabricated one.
 */
export type TranscriptToolCallTiming = {
  toolCallId?: string;
  toolName: string;
  durationMs: number;
  provenance: "span" | "evidence";
};

/** The MCP tool annotations a check can read. */
export type TranscriptToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * One advertised tool, as the model saw it this iteration.
 *
 * The inventory is what lets a check compare a CALL against what the server
 * DECLARED — arguments against the input schema, a called tool against its own
 * `destructiveHint`. Absent ⇒ those checks are `status: "error"`: a rule about
 * a declaration cannot be evaluated where no declaration was captured.
 */
export type TranscriptToolInventoryEntry = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: TranscriptToolAnnotations;
};

/**
 * Whether each evidence channel was fully captured.
 *
 * `absent` and `partial` are different from an empty list, and the difference
 * decides whether a check reports a scored absence or an error. "Zero calls
 * were made" is a measurement; "we did not record the calls" is not.
 */
export type TranscriptCaptureState = "complete" | "partial" | "absent";

export type TranscriptCapture = {
  toolResults: TranscriptCaptureState;
  toolCallTimings: TranscriptCaptureState;
  toolInventory: TranscriptCaptureState;
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
  /**
   * User turns observed over the iteration — user-role messages in the
   * transcript. Absent ⇒ `turnCountUnder` fails closed, same rule as
   * `usage` and `tokenBudgetUnder`.
   */
  turnCount?: number;
  /** Observed tool results, in call order. See {@link capture}. */
  toolResults?: TranscriptToolResult[];
  /** Observed per-call durations. See {@link capture}. */
  toolCallTimings?: TranscriptToolCallTiming[];
  /** The tools advertised to the model this iteration. See {@link capture}. */
  toolInventory?: TranscriptToolInventoryEntry[];
  /**
   * Whether each evidence channel above was fully captured.
   *
   * ABSENT ⇒ treated as `absent` on every channel, which is the honest reading
   * for a transcript built before these channels existed: it did not record
   * them, and a check that needs them must say so rather than pass.
   */
  capture?: TranscriptCapture;
};

/**
 * Where a check runs ("scope"). Absent ⇒ the check is case-level (evaluated
 * against the whole-iteration transcript). `{ kind: "turn", promptIndex }`
 * marks a check authored on a single prompt turn and evaluated against that
 * turn's slice of the transcript. An object (not a bare index) so future scope
 * kinds can be added without a wire break.
 *
 * Mirrored in `mcpjam-backend/convex/lib/predicates.ts` (`PredicateScope`).
 */
export type PredicateScope = { kind: "turn"; promptIndex: number };

/** Zod schema for {@link PredicateScope}. */
export const predicateScopeSchema = z.object({
  kind: z.literal("turn"),
  promptIndex: z.number().int().nonnegative(),
});

/**
 * Per-predicate verdict row, persisted to `testIteration.metadata.predicates`.
 *
 * `status` distinguishes "we measured and it failed" from "we could not
 * measure". Both carry `passed: false` on the wire — the field stays required
 * so every existing reader keeps working — but only a `scored` row is a
 * statement about the server. An `error` row becomes an ERROR score result
 * (no value) and leaves its stage `notMeasured`; it never establishes a
 * failure, because a measurement we could not take must not manufacture
 * attribution.
 *
 * Absent ⇒ `scored`. Legacy rows predate the field and were all real verdicts.
 */
export type PredicateResult = {
  predicate: Predicate;
  passed: boolean;
  /** Absent ⇒ `"scored"`. `"error"` ⇒ no evidence; never a verdict. */
  status?: "scored" | "error";
  /** Structured, deterministic explanation — names the expected vs actual on failure. */
  reason: string;
  /** Absent ⇒ case-level; `{ kind: "turn", promptIndex }` ⇒ per-turn. */
  scope?: PredicateScope;
};
