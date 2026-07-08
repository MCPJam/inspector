/**
 * Shared tool call matching for the inspector.
 *
 * Thin re-export of the richer `evaluateToolCalls` matcher from the SDK
 * (`@mcpjam/sdk/matchers`, a browser-safe subpath). The historical
 * `matchToolCalls` function and `ToolCallMatchResult` type are preserved
 * as compatibility aliases so existing inspector call sites keep working
 * unchanged — call sites can migrate to `evaluateToolCalls` deliberately.
 *
 * Defaults preserve today's inspector behavior precisely:
 *   - order-agnostic
 *   - extra/unexpected calls reported but non-fatal
 *   - partial argument matching with placeholder type checks (e.g.
 *     `"string"` matches any string)
 */

import { z } from "zod";
import {
  evaluateToolCalls,
  MATCH_OPTIONS_DEFAULTS,
  resolveMatchOptions,
  type EvalArgumentMismatch,
  type EvalMatchOptions,
  type EvalOutOfOrderToolCall,
  type EvalToolCall,
  type EvalToolCallMatchResult,
} from "@mcpjam/sdk/matchers";

export type ToolCall = EvalToolCall;
export type ArgumentMismatch = EvalArgumentMismatch;
export type OutOfOrderToolCall = EvalOutOfOrderToolCall;

/**
 * Zod schema mirroring `EvalMatchOptions` for transport boundaries
 * (HTTP request bodies, Convex args). Keep field names + value enums in
 * lockstep with `@mcpjam/sdk/matchers`.
 */
export const matchOptionsSchema = z
  .object({
    toolCallOrder: z.enum(["ignore", "strict", "superset"]).optional(),
    /**
     * Bound on extra actual tool calls beyond what was paired with
     * expected. `null` = unlimited; a non-negative integer caps the count.
     * Must be `Number.isInteger(n) && n >= 0` when not null — the
     * Zod refinement here rejects -1 / 0.5 / NaN / Infinity at the
     * wire boundary before the matcher's runtime guard fires.
     */
    maxExtraToolCalls: z
      .union([
        z
          .number()
          .refine(
            (n) => Number.isInteger(n) && n >= 0,
            "maxExtraToolCalls must be a non-negative integer or null",
          ),
        z.null(),
      ])
      .optional(),
    /**
     * LEGACY: prefer `maxExtraToolCalls`. Accepted on the wire so older
     * persisted rows and in-flight clients keep working; the SDK matcher
     * shims `true -> null`, `false -> 0`. Remove after v<NEXT_MINOR>.
     */
    allowExtraToolCalls: z.boolean().optional(),
    argumentMatching: z.enum(["exact", "partial", "ignore"]).optional(),
  })
  .strict();

/**
 * Transport DTO — narrow Pick from the SDK type so server/client wire
 * payloads import a stable name from this boundary module.
 */
export type MatchOptionsDTO = z.infer<typeof matchOptionsSchema>;

/**
 * Inspector-shaped result that the existing tests + UI consume.
 *
 * Note: the inspector has historically used `unexpected` as the field
 * name; the SDK matcher returns `extra`. We surface both here so the
 * field rename can happen gradually. New code should prefer
 * `evaluateToolCalls()` directly and read `extra` + `outOfOrder`.
 */
export type ToolCallMatchResult = {
  missing: ToolCall[];
  unexpected: ToolCall[];
  argumentMismatches: ArgumentMismatch[];
  passed: boolean;
};

export type { EvalMatchOptions, EvalToolCallMatchResult };
export { evaluateToolCalls, MATCH_OPTIONS_DEFAULTS, resolveMatchOptions };

/**
 * Compatibility alias for the inspector's historical matcher.
 *
 * Returns the legacy shape (missing/unexpected/argumentMismatches/passed)
 * by delegating to {@link evaluateToolCalls} with the default
 * order-agnostic / extras-allowed / partial-args options.
 *
 * Prefer {@link evaluateToolCalls} in new code.
 */
export function matchToolCalls(
  expected: ToolCall[],
  actual: ToolCall[],
  isNegativeTest?: boolean,
): ToolCallMatchResult {
  const result = evaluateToolCalls(expected, actual, {
    isNegativeTest,
  });
  return {
    missing: result.missing,
    unexpected: result.extra,
    argumentMismatches: result.argumentMismatches,
    passed: result.passed,
  };
}

/**
 * Argument compatibility check kept for callers that depended on the
 * standalone helper. Implements partial-match semantics with placeholder
 * type checks (matches today's behavior).
 */
export function argumentsMatch(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
): boolean {
  const result = evaluateToolCalls(
    [{ toolName: "__probe__", arguments: expectedArgs }],
    [{ toolName: "__probe__", arguments: actualArgs }],
  );
  return result.argumentMismatches.length === 0;
}

/**
 * Re-exports of the state-based predicate system (`@mcpjam/sdk/predicates`).
 *
 * Predicates are the deterministic eval **gate** layer that complements the
 * tool-call matcher above: a pure function of the iteration transcript with
 * the same verdict every time, which is the property a CI release gate
 * requires. The implementation lives in `@mcpjam/sdk` so the inspector GUI
 * runner and the `mcpjam eval` CLI share one implementation; this boundary
 * module surfaces it alongside tool-call matching for inspector call sites.
 */
export {
  evaluatePredicate,
  evaluatePredicates,
  allPredicatesPassed,
  evaluateTurnChecks,
  buildIterationTranscript,
  buildTurnTranscript,
  extractFinalAssistantMessage,
  extractToolErrors,
  predicateSchema,
  predicateArraySchema,
  argMatcherSchema,
  casePredicatesSchema,
  predicateScopeSchema,
  PREDICATE_PLACEHOLDER_STRINGS,
  TURN_SCOPABLE_PREDICATE_KINDS,
  isTurnScopablePredicateKind,
} from "@mcpjam/sdk/predicates";
export type {
  Predicate,
  PredicateType,
  PredicateResult,
  PredicateScope,
  ArgMatcher,
  ArgMatchMode,
  IterationTranscript,
  TranscriptToolCall,
  TranscriptUsage,
  ToolErrorRecord,
  ToolErrorKind,
  RenderObservationStatus,
  RenderObservationSummary,
  CasePredicates,
  PredicatePlaceholder,
  TurnChecksInput,
  TurnTranscriptInput,
} from "@mcpjam/sdk/predicates";

import type {
  CasePredicates as CasePredicatesType,
  Predicate as PredicateType,
  RenderObservationSummary as RenderObservationSummaryType,
} from "@mcpjam/sdk/predicates";
import type {
  EvalTraceWidgetToolCall,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "./eval-trace";

/**
 * Map the runner's widget render observations onto the screenshot-free
 * summaries the SDK `widget*` predicates evaluate against. Drops the
 * transient base64 screenshot and other replay-only fields; predicates only
 * need outcome, latency, and console errors.
 */
export function summarizeRenderObservations(
  observations: readonly RunnerWidgetRenderObservation[] | undefined,
): RenderObservationSummaryType[] {
  return (observations ?? []).map((o) => ({
    toolCallId: o.toolCallId,
    toolName: o.toolName,
    serverId: o.serverId,
    status: o.status,
    elapsedMs: o.elapsedMs,
    ...(o.consoleErrors && o.consoleErrors.length > 0
      ? { consoleErrors: o.consoleErrors }
      : {}),
  }));
}

/**
 * Map ONE widget→host tool call (recorded by the browser harness when a widget
 * invokes an MCP tool, e.g. in response to a click) onto a transcript
 * {@link ToolCall}. This is what lets a single "tool was called" check
 * (`toolCalledWith`/`toolCalledAtLeastOnce`/…) cover BOTH model-initiated and
 * widget-initiated calls: widget calls live outside the model transcript, so
 * without this mapping the predicate engine never sees them.
 */
export function widgetCallToToolCall(
  call: Pick<EvalTraceWidgetToolCall, "name" | "args">,
): ToolCall {
  return {
    toolName: call.name,
    // `args` is `unknown` (sanitized at the trace boundary); predicates expect a
    // plain record. Coerce non-object payloads to `{}` so arg matching is sound.
    arguments:
      call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>)
        : {},
  };
}

/**
 * Flatten every widget→host tool call across a run's browser interaction steps
 * into transcript {@link ToolCall}s, in step order. Merge the result into the
 * `toolCalls` fed to {@link buildIterationTranscript} so case-level predicates
 * see widget-initiated calls. Pure model transcript inputs are unaffected.
 */
export function widgetToolCallsToToolCalls(
  steps: readonly RunnerBrowserInteractionStep[],
): ToolCall[] {
  const out: ToolCall[] = [];
  for (const step of steps) {
    for (const call of step.widgetToolCalls ?? []) {
      out.push(widgetCallToToolCall(call));
    }
  }
  return out;
}

/**
 * Same flatten as {@link widgetToolCallsToToolCalls}, but grouped by each step's
 * `promptIndex` so per-turn checks (evaluated against a single turn's transcript
 * slice) see the widget calls that happened during THAT turn. Sparse: indexes
 * with no widget calls are left empty.
 */
export function widgetToolCallsByPromptIndex(
  steps: readonly RunnerBrowserInteractionStep[],
): ToolCall[][] {
  const byPrompt: ToolCall[][] = [];
  for (const step of steps) {
    const calls = (step.widgetToolCalls ?? []).map(widgetCallToToolCall);
    if (calls.length === 0) continue;
    const i = step.promptIndex ?? 0;
    (byPrompt[i] ??= []).push(...calls);
  }
  return byPrompt;
}

/**
 * Append a turn's model tool calls into its per-prompt bucket, indexing by
 * `promptIndex` rather than appending a new array slot.
 *
 * This is load-bearing for widget `ui/message` follow-up turns: a follow-up
 * reuses its parent authored turn's `promptIndex` (it is NOT a new authored
 * prompt). A naive `toolsCalledByPrompt.push()` would land the follow-up's
 * calls at a fresh array index with no corresponding authored turn, so
 * `evaluateMultiTurnResults` (which maps only over authored `promptTurns`)
 * silently drops them — and, with multiple authored turns, the orphan slot
 * shifts every later turn's bucket out of alignment with its position in the
 * `promptTurns` array. Folding by `promptIndex` keeps the invariant
 * `toolsCalledByPrompt[i]` == "all model calls for the turn whose ordinal is
 * `i`, follow-ups included". Negative `promptIndex` (no active turn) is a no-op.
 *
 * Mutates `toolsCalledByPrompt` in place; preserves call order and duplicates.
 */
export function appendToolCallsForPrompt(
  toolsCalledByPrompt: ToolCall[][],
  promptIndex: number,
  calls: readonly ToolCall[],
): void {
  if (promptIndex < 0) return;
  (toolsCalledByPrompt[promptIndex] ??= []).push(...calls);
}

/**
 * Merge two per-prompt-index `ToolCall[][]` slices (model calls + widget calls)
 * into one, preserving model calls first within each turn. Used to feed per-turn
 * checks without mutating the matcher's pristine model-call input.
 */
export function mergeToolCallsByPromptIndex(
  base: readonly ToolCall[][],
  extra: readonly ToolCall[][],
): ToolCall[][] {
  const n = Math.max(base.length, extra.length);
  const out: ToolCall[][] = [];
  for (let i = 0; i < n; i++) {
    out[i] = [...(base[i] ?? []), ...(extra[i] ?? [])];
  }
  return out;
}

/**
 * Collapse `matchOptions.maxExtraToolCalls` + the legacy
 * `allowExtraToolCalls` field into a single nullable cap value:
 *
 *   - `null`            → unlimited extras
 *   - a non-negative N  → at most N extras
 *
 * Precedence:
 *   1. Explicit `maxExtraToolCalls` (any value, including 0 / null) wins.
 *   2. Else, legacy `allowExtraToolCalls === false` translates to 0;
 *      any other legacy state (true / undefined) → null.
 *
 * LEGACY: drop the `allowExtraToolCalls` fallback after v<NEXT_MINOR>.
 */
export function resolveExtrasCap(
  matchOptions:
    | {
        maxExtraToolCalls?: number | null;
        allowExtraToolCalls?: boolean;
      }
    | undefined
    | null,
): number | null {
  if (!matchOptions) return null;
  if (matchOptions.maxExtraToolCalls !== undefined) {
    return matchOptions.maxExtraToolCalls;
  }
  return matchOptions.allowExtraToolCalls === false ? 0 : null;
}

/**
 * Resolve the effective predicate list for a single case from suite defaults
 * plus the case's `predicates: { mode, list }` envelope.
 *
 * Mirrors the backend `convex/lib/matchOptions.ts#resolvePredicates`
 * semantics — keep these in lockstep:
 *
 *   - no case envelope        → suite defaults (or empty)
 *   - `mode: "inherit"`       → suite defaults (case `list` ignored)
 *   - `mode: "replace"`       → case `list`
 *   - `mode: "extend"`        → suite defaults followed by case `list`
 *
 * Returns `undefined` when the effective list is empty so the runner's
 * existing `successPredicates?.length` checks keep treating "no gate" as
 * the absence of the field.
 */
export function resolveCasePredicates(
  suiteDefaults: PredicateType[] | undefined,
  caseOverride: CasePredicatesType | undefined,
): PredicateType[] | undefined {
  const defaults = suiteDefaults ?? [];
  const overrideList = (caseOverride?.list ?? []) as PredicateType[];
  let resolved: PredicateType[];
  if (!caseOverride) {
    resolved = defaults;
  } else {
    switch (caseOverride.mode) {
      case "inherit":
        resolved = defaults;
        break;
      case "replace":
        resolved = overrideList;
        break;
      case "extend":
        resolved = [...defaults, ...overrideList];
        break;
      default:
        resolved = defaults;
    }
  }
  return resolved.length > 0 ? resolved : undefined;
}

/**
 * Single source of truth for the per-case `successPredicates` resolution
 * used by both single-case run paths (`runEvalTestCaseWithManager`,
 * `streamEvalTestCaseWithManager`) and the suite-run recorder.
 *
 * Precedence — higher beats lower:
 *
 *   1. `runOverride` — legacy per-run flat list (oldest contract).
 *   2. `envelope` — `{mode,list}` from per-run or persisted case. When
 *      present this is AUTHORITATIVE, including the explicit opt-out
 *      `{mode: "replace", list: []}`. `resolveCasePredicates` collapses
 *      empty lists to `undefined`, so when the envelope says "no gate"
 *      we return `undefined` and the runner sees no `successPredicates`
 *      — which is the user's intent. Falling through to legacy/suite
 *      defaults here would silently re-apply the very checks the user
 *      opted out of.
 *   3. `legacyCase` — pre-envelope persisted `testCase.successPredicates`.
 *      Only consulted when the case has no envelope at all, so adding
 *      a suite-level default doesn't replace existing gates on
 *      un-migrated cases.
 *   4. `suiteDefaults` — last resort when no case-level signal exists.
 */
export function resolveCaseSuccessPredicates(args: {
  suiteDefaults: PredicateType[] | undefined;
  runOverride?: PredicateType[] | undefined;
  envelope?: CasePredicatesType | undefined;
  legacyCase?: PredicateType[] | undefined;
}): PredicateType[] | undefined {
  if (args.runOverride !== undefined) return args.runOverride;
  if (args.envelope !== undefined) {
    return resolveCasePredicates(args.suiteDefaults, args.envelope);
  }
  if (Array.isArray(args.legacyCase) && args.legacyCase.length > 0) {
    return args.legacyCase;
  }
  return args.suiteDefaults;
}
