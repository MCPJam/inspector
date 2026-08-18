/**
 * Unified test-step model — the authored unit of an MCP-app synthetic test.
 *
 * ── The union itself now lives in the SDK ────────────────────────────────────
 *
 * `TestStep` and everything that defines it (the four step schemas, the
 * interact actions, the widget assertions, the caps and the narrowing helpers)
 * were RELOCATED to `@mcpjam/sdk/contract` — `sdk/src/contract/steps.ts` — and
 * are re-exported below. Every existing importer of `shared/steps` is
 * unchanged; there is still exactly ONE definition, it just moved repos-of-
 * record from this app to the published SDK.
 *
 * Why it had to move: the step union is part of the evaluation CONTRACT (it is
 * what a suite file carries and what the hosted API accepts), and the SDK's
 * suite-file schema reuses it. The SDK cannot import this directory — the
 * dependency direction is shared → sdk, never the reverse — so the alternative
 * was a hand-mirrored copy inside the SDK, i.e. a THIRD sibling beside this
 * file and the Convex validator. A re-export leaves one definition.
 *
 * What still lives here: the UI copy (`WIDGET_ASSERTION_LABELS`), the
 * case-level selectors and derived display projections, and the legacy
 * `PromptTurn` bridge — none of which are contract, all of which are this app's.
 *
 * The four authored kinds:
 *   - `prompt`   — a user message; the model decides which tools to call.
 *   - `toolCall` — a deterministic, model-free tool call (= the old pinnedToolCall).
 *   - `interact` — ONE pure widget action (click/type/key/scroll/wait). No assertions.
 *   - `assert`   — the ONE place assertions live: a model-level `Predicate`
 *                  (toolCalledWith / widgetRendered / responseContains / …) OR a
 *                  DOM-level `WidgetAssertion` (textVisible / elementVisible / …).
 *
 * NAMING: this union is `TestStep`, NOT `Step`. The AI SDK already owns "step"
 * = one LLM round-trip (onStepFinish / stepNumber). Our authoring unit is a
 * different level — a single `prompt` TestStep may expand into several AI SDK
 * steps at runtime. The persisted/UI field stays `steps`.
 *
 * Mirrored by the Convex validator in mcpjam-backend `convex/lib/steps.ts`
 * (same hand-mirroring arrangement as `scriptedSteps` / `probeConfig` / the
 * predicate validators) — edit the SDK module and the mirror in the same PR.
 */

import type { z } from "zod";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  isAssertStep,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  testStepSchema,
  type InteractAction,
  type TestStep,
  type ToolCallStep,
  type WidgetAssertion,
} from "@mcpjam/sdk/contract";
import type {
  ScriptedStep,
  StepAssertion,
  ScriptedWidgetCheck,
} from "./scripted-steps";
import type { ProbeConfig } from "./probe-config";

// ── the canonical step union, re-exported ────────────────────────────────────
export {
  MAX_TEST_STEPS,
  TEST_STEP_KINDS,
  assertStepSchema,
  interactActionSchema,
  interactStepSchema,
  isAssertStep,
  isInteractStep,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  promptStepSchema,
  stepAssertionPayloadSchema,
  stepsSchema,
  testStepSchema,
  toolCallStepSchema,
  widgetAssertionSchema,
} from "@mcpjam/sdk/contract";
export type {
  AssertStep,
  InteractAction,
  InteractStep,
  PromptStep,
  StepAssertionPayload,
  TestStep,
  TestStepKind,
  ToolCallStep,
  WidgetAssertion,
} from "@mcpjam/sdk/contract";

/**
 * The ONE human label per widget-assertion kind — the DOM-level counterpart of
 * `PREDICATE_KIND_LABELS` in `shared/predicate-kinds.ts`.
 *
 * Presentation, not contract, which is why it stayed behind when the union
 * moved to the SDK. It lives beside the re-exported union so a new `kind`
 * cannot be added without the exhaustive `Record` forcing a label for it. Every
 * authoring surface (the step-list sub-editor, the Add Step picker catalog, the
 * click-to-assert chooser) imports these rather than keeping private copies —
 * three copies is how "Input value equals" and "Input equals…" ended up on
 * screen for the same assertion.
 */
export const WIDGET_ASSERTION_LABELS: Record<WidgetAssertion["kind"], string> =
  {
    textVisible: "Text visible",
    elementVisible: "Element visible",
    elementHidden: "Element hidden",
    inputValue: "Input value equals",
    widgetToolCalled: "View called tool",
  };

// ── case-level selectors (replace isPinnedTurn / isPinnedOnly / countModelTurns) ─
type MaybeStep = { kind?: unknown };
function rawSteps(steps: unknown): MaybeStep[] {
  return Array.isArray(steps) ? (steps as MaybeStep[]) : [];
}

/** Number of model-driven (`prompt`) steps — the unit the LLM-call cap counts. */
export function countModelSteps(steps: unknown): number {
  return rawSteps(steps).filter((s) => s?.kind === "prompt").length;
}

/** True when at least one step needs the model. */
export function needsModel(steps: unknown): boolean {
  return countModelSteps(steps) > 0;
}

/** True when the case is entirely model-free (no `prompt` step). */
export function isModelFree(steps: unknown): boolean {
  const list = rawSteps(steps);
  return list.length > 0 && !list.some((s) => s?.kind === "prompt");
}

// ── normalization ─────────────────────────────────────────────────────────────
/**
 * Collect every `unrecognized_keys` issue in an error tree, including the ones
 * nested inside union branches.
 *
 * Union branches disagree by construction — an `assert` step's payload is
 * matched against both the (strict) widget-assertion union and the (open)
 * predicate union — so a key one branch calls unrecognized may be perfectly
 * declared by another. That is safe here ONLY because the caller re-validates
 * after stripping and keeps nothing that fails: an over-eager strip produces a
 * step that no longer parses, which is dropped exactly as it would have been.
 */
function unrecognizedKeyIssues(
  issues: readonly z.core.$ZodIssue[],
  basePath: PropertyKey[] = []
): Array<{ path: PropertyKey[]; keys: string[] }> {
  const found: Array<{ path: PropertyKey[]; keys: string[] }> = [];
  for (const issue of issues) {
    // A union branch reports paths RELATIVE to that branch, so the enclosing
    // `invalid_union`'s own path has to be carried down. Without it every
    // nested strip lands at the wrong depth and — being re-validated — the
    // step is silently dropped anyway, which is the bug this whole function
    // exists to prevent.
    if (issue.code === "unrecognized_keys") {
      found.push({ path: [...basePath, ...issue.path], keys: [...issue.keys] });
    } else if (issue.code === "invalid_union") {
      for (const branch of issue.errors) {
        found.push(
          ...unrecognizedKeyIssues(branch, [...basePath, ...issue.path])
        );
      }
    }
  }
  return found;
}

/**
 * Delete `keys` from the object at `path`, in a structural clone of `value`.
 *
 * Returns `undefined` when the value cannot be cloned. `structuredClone`
 * throws on a function, a symbol or a class instance it does not know — and
 * the values under UNRECOGNIZED keys are exactly the ones nothing has
 * validated, so that is reachable (a client draft holding an event handler,
 * say). Letting it escape would take down the whole array over one bad step,
 * which is worse than the drop it replaced.
 */
function withoutKeys(
  value: unknown,
  removals: Array<{ path: PropertyKey[]; keys: string[] }>
): unknown {
  let clone: unknown;
  try {
    clone = structuredClone(value);
  } catch {
    return undefined;
  }
  for (const { path, keys } of removals) {
    let target: unknown = clone;
    for (const segment of path) {
      if (!target || typeof target !== "object") {
        target = undefined;
        break;
      }
      target = (target as Record<PropertyKey, unknown>)[segment];
    }
    if (!target || typeof target !== "object") continue;
    for (const key of keys) {
      delete (target as Record<string, unknown>)[key];
    }
  }
  return clone;
}

/**
 * Structurally normalize a steps array (round-trip shape only; semantic
 * validation is the route Zod boundary + Convex mutation's job). Drops anything
 * that isn't a known step kind.
 *
 * ── Why this STRIPS unknown keys rather than dropping the step ───────────────
 *
 * The step union is `.strict()`, so a step carrying an undeclared key does not
 * parse. That strictness is aimed at the CONTRACT boundaries — the route Zod
 * schemas and the Convex `v.object` validators — where an importer's mis-mapped
 * field must fail loudly rather than vanish.
 *
 * This function is not one of those boundaries. It is the shared normalizer on
 * the editor load path, the execution paths, and the LLM case-GENERATION path
 * (`server/routes/v1/evals.ts`), where the input is model output that nobody
 * validated. Letting strictness reach here would turn "the generator invented a
 * field" into "the whole step disappeared", and a generated case silently
 * losing a prompt is a worse outcome than the stray key ever was.
 *
 * So: parse; if the only complaint is unrecognized keys, remove exactly those
 * and re-validate. Re-validating is what makes this safe — nothing is kept
 * unless it parses cleanly afterwards, so a step that was broken for any other
 * reason is dropped exactly as before, and the strict boundaries above are
 * untouched.
 */
export function normalizeSteps(value: unknown): TestStep[] {
  if (!Array.isArray(value)) return [];
  const out: TestStep[] = [];
  for (let i = 0; i < value.length; i++) {
    const parsed = testStepSchema.safeParse(value[i]);
    if (parsed.success) {
      out.push(parsed.data);
      continue;
    }
    const removals = unrecognizedKeyIssues(parsed.error.issues);
    if (removals.length === 0) continue;
    const cleaned = withoutKeys(value[i], removals);
    if (cleaned === undefined) continue;
    const retry = testStepSchema.safeParse(cleaned);
    if (retry.success) out.push(retry.data);
  }
  return out;
}

/**
 * Canonical projection fed to the case-identity hash. Steps ARE the case
 * definition, so the whole (normalized) sequence participates — changing any
 * step yields a distinct case identity. Mirror in the backend signature builder.
 */
export function normalizeStepsForSignature(value: unknown): TestStep[] {
  return normalizeSteps(value);
}

// ── derived display fields (write-time projection; never authored/run) ──────────
/** First `prompt` step's text — the legacy `query` display field. */
export function deriveQuery(steps: TestStep[]): string {
  const firstPrompt = steps.find(isPromptStep);
  if (firstPrompt) return firstPrompt.prompt;
  const firstCall = steps.find(isToolCallStep);
  return firstCall
    ? `Tool call: ${firstCall.toolName} on "${firstCall.serverName}"`
    : "";
}

/** Flattened expected tool calls (from `toolCalledWith` asserts) for list views. */
export function deriveExpectedToolCalls(
  steps: TestStep[]
): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  return steps
    .filter(isAssertStep)
    .map((s) => s.assertion)
    .filter(
      (a): a is Extract<Predicate, { type: "toolCalledWith" }> =>
        !isWidgetAssertion(a) && a.type === "toolCalledWith"
    )
    .map((a) => ({ toolName: a.toolName, arguments: a.args.args ?? {} }));
}

/**
 * Expected tool calls for display (e.g. the Tools tab). Prefers a completed
 * iteration snapshot over the live case template; reads the authored `steps`
 * when present, else the denormalized `expectedToolCalls` projection (which the
 * backend writes from `steps`). Negative tests expose no expected calls.
 * Steps-native replacement for the prompt-turns
 * `resolveIterationDisplayExpectedToolCalls` / `flattenAssertedExpectedToolCalls`.
 */
type DisplayExpectedInput = {
  steps?: unknown;
  expectedToolCalls?: unknown;
  isNegativeTest?: boolean;
};
export function resolveDisplayExpectedToolCalls(
  snapshot: DisplayExpectedInput | null | undefined,
  fallbackTestCase: DisplayExpectedInput | null | undefined
): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  const src = snapshot ?? fallbackTestCase;
  if (!src || src.isNegativeTest === true) return [];
  if (Array.isArray(src.steps) && src.steps.length > 0) {
    return deriveExpectedToolCalls(normalizeSteps(src.steps));
  }
  return Array.isArray(src.expectedToolCalls)
    ? (src.expectedToolCalls as Array<{
        toolName: string;
        arguments: Record<string, unknown>;
      }>)
    : [];
}

// ════════════════════════════════════════════════════════════════════════════
// LEGACY PromptTurn model (relocated from the deleted `shared/prompt-turns.ts`).
//
// `TestStep[]` is the authored/persisted/wire model. These turn types + helpers
// remain ONLY as the in-memory bridge the runner/editor still use transiently
// (steps ⇄ turns via `promptTurnsToSteps` / `stepsToPromptTurns`) plus the
// turn-shaped verdict/cap/grading selectors. They live here, next to the
// converters, so the legacy module can be deleted. Mirrors the backend's
// `convex/lib/steps.ts` relocation.
// ════════════════════════════════════════════════════════════════════════════

export type PromptTurnToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

/**
 * A reference to one of a turn's non-primary children (an expected tool call, a
 * per-widget interaction/assert step, or a per-turn check), used to record the
 * order the author arranged them in the flat step list. See `PromptTurn.childOrder`.
 */
export type PromptTurnChildRef =
  | { bucket: "expect"; index: number }
  | { bucket: "widget"; toolName: string; index: number }
  | { bucket: "check"; index: number };

/** A pinned (model-free) tool call attached to a turn. Same shape as `ProbeConfig`. */
export type PinnedToolCall = ProbeConfig;

export type PromptTurn = {
  id: string;
  prompt: string;
  expectedToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
  /** When present, the turn is model-free: the runner executes this exact call. */
  pinnedToolCall?: PinnedToolCall;
  /** Per-widget interaction checks, replayed against each widget the turn renders. */
  widgetChecks?: ScriptedWidgetCheck[];
  /** Per-turn deterministic checks evaluated against this turn's transcript slice. */
  checks?: Predicate[];
  /** Authored interleave order of non-primary children. In-memory ONLY (never persisted). */
  childOrder?: PromptTurnChildRef[];
};

function normalizeToolCalls(value: unknown): PromptTurnToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as { toolName?: unknown }).toolName === "string"
    )
    .map((item) => {
      const call = item as { toolName: string; arguments?: unknown };
      return {
        toolName: call.toolName,
        arguments:
          call.arguments && typeof call.arguments === "object"
            ? (call.arguments as Record<string, any>)
            : {},
      };
    });
}

/**
 * Structurally normalize a turn's `checks` array: keep only objects with a
 * string `type` discriminator. Round-trip shape only; semantic validation is
 * the Convex mutation boundary's job.
 */
export function normalizePromptTurnChecks(
  value: unknown
): Predicate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const checks = value.filter(
    (item): item is Predicate =>
      !!item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { type?: unknown }).type === "string"
  );
  return checks.length > 0 ? checks : undefined;
}

function normalizePromptTurn(value: unknown, index: number): PromptTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const pinnedToolCall = raw.pinnedToolCall;
  const checks = normalizePromptTurnChecks(raw.checks);
  const widgetChecks =
    Array.isArray(raw.widgetChecks) && raw.widgetChecks.length > 0
      ? (raw.widgetChecks as ScriptedWidgetCheck[])
      : undefined;
  const childOrder =
    Array.isArray(raw.childOrder) && raw.childOrder.length > 0
      ? (raw.childOrder.filter(
          (r) =>
            !!r &&
            typeof r === "object" &&
            ((r as { bucket?: unknown }).bucket === "expect" ||
              (r as { bucket?: unknown }).bucket === "widget" ||
              (r as { bucket?: unknown }).bucket === "check")
        ) as PromptTurnChildRef[])
      : undefined;
  return {
    id:
      typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id.trim()
        : `turn-${index + 1}`,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    expectedToolCalls: normalizeToolCalls(raw.expectedToolCalls),
    expectedOutput:
      typeof raw.expectedOutput === "string" ? raw.expectedOutput : undefined,
    ...(pinnedToolCall && typeof pinnedToolCall === "object"
      ? { pinnedToolCall: pinnedToolCall as PinnedToolCall }
      : {}),
    ...(widgetChecks ? { widgetChecks } : {}),
    ...(checks ? { checks } : {}),
    ...(childOrder && childOrder.length > 0 ? { childOrder } : {}),
  };
}

export function normalizePromptTurns(value: unknown): PromptTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((turn, index) => normalizePromptTurn(turn, index))
    .filter((turn): turn is PromptTurn => turn !== null);
}

function extractPromptTurnsFromAdvancedConfig(
  advancedConfig: unknown
): PromptTurn[] {
  if (
    !advancedConfig ||
    typeof advancedConfig !== "object" ||
    Array.isArray(advancedConfig)
  ) {
    return [];
  }
  return normalizePromptTurns(
    (advancedConfig as { promptTurns?: unknown }).promptTurns
  );
}

export function stripPromptTurnsFromAdvancedConfig(
  advancedConfig: unknown
): Record<string, unknown> | undefined {
  if (
    !advancedConfig ||
    typeof advancedConfig !== "object" ||
    Array.isArray(advancedConfig)
  ) {
    return undefined;
  }
  const { promptTurns: _promptTurns, ...rest } = advancedConfig as Record<
    string,
    unknown
  >;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function resolvePromptTurns(input: {
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: unknown;
  expectedOutput?: string;
}): PromptTurn[] {
  const topLevelTurns = normalizePromptTurns(input.promptTurns);
  if (topLevelTurns.length > 0) {
    return topLevelTurns;
  }
  const legacyTurns = extractPromptTurnsFromAdvancedConfig(
    input.advancedConfig
  );
  if (legacyTurns.length > 0) {
    return legacyTurns;
  }
  return [
    {
      id: "turn-1",
      prompt: typeof input.query === "string" ? input.query : "",
      expectedToolCalls: normalizeToolCalls(input.expectedToolCalls),
      expectedOutput: input.expectedOutput,
    },
  ];
}

export function deriveLegacyPromptFields(promptTurns: PromptTurn[]): {
  query: string;
  expectedToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
} {
  const firstTurn = promptTurns[0] ?? {
    id: "turn-1",
    prompt: "",
    expectedToolCalls: [],
  };
  const query =
    firstTurn.prompt.trim().length === 0 && firstTurn.pinnedToolCall
      ? `Pinned tool call: ${firstTurn.pinnedToolCall.toolName} on "${firstTurn.pinnedToolCall.serverName}"`
      : firstTurn.prompt;
  return {
    query,
    expectedToolCalls: firstTurn.expectedToolCalls,
    expectedOutput: firstTurn.expectedOutput,
  };
}

type AssertedExpectedInput = {
  promptTurns?: unknown;
  advancedConfig?: unknown;
  query?: string;
  expectedToolCalls?: unknown;
  expectedOutput?: string;
  isNegativeTest?: boolean;
};

/**
 * Expected tool calls aggregated for display, aligned with
 * `evaluateMultiTurnResults`: concatenate expected tools from every turn that
 * asserts at least one tool. Negative tests expose no expected calls.
 */
export function flattenAssertedExpectedToolCalls(
  input: AssertedExpectedInput
): PromptTurnToolCall[] {
  if (input.isNegativeTest === true) {
    return [];
  }
  const turns = resolvePromptTurns(input);
  return turns
    .filter((turn) => turn.expectedToolCalls.length > 0)
    .flatMap((turn) => turn.expectedToolCalls);
}

// ── pinned-turn selectors (model-free detection) ──────────────────────────────
type MaybePinnedTurn = { pinnedToolCall?: unknown };

/** Minimal structural view of a case for the case-level selectors. */
export type PinnedCaseInput = {
  caseType?: string | null;
  promptTurns?: unknown;
};

function rawTurns(promptTurns: unknown): MaybePinnedTurn[] {
  return Array.isArray(promptTurns) ? (promptTurns as MaybePinnedTurn[]) : [];
}

/** True when this turn carries a pinned tool call (model-free). */
export function isPinnedTurn(turn: unknown): boolean {
  return !!(turn && (turn as MaybePinnedTurn).pinnedToolCall);
}

function turnHasModelContent(turn: unknown): boolean {
  const t = turn as { prompt?: unknown; expectedToolCalls?: unknown };
  return (
    (typeof t.prompt === "string" && t.prompt.trim().length > 0) ||
    (Array.isArray(t.expectedToolCalls) && t.expectedToolCalls.length > 0)
  );
}

/** True when the case is entirely model-free (no model turns). */
export function isPinnedOnly(input: PinnedCaseInput): boolean {
  const turns = rawTurns(input.promptTurns);
  if (turns.length === 0) return input.caseType === "widget_probe";
  if (turns.every(isPinnedTurn)) return true;
  if (input.caseType === "widget_probe") {
    return !turns.some(turnHasModelContent);
  }
  return false;
}

/** True when at least one turn needs the model (inverse of pinned-only).
 *  Turn-shaped sibling of {@link needsModel} (which takes steps). */
export function turnsNeedModel(input: PinnedCaseInput): boolean {
  return !isPinnedOnly(input);
}

/** Number of model-driven (non-pinned) turns — the unit the LLM-call cap counts. */
export function countModelTurns(promptTurns: unknown): number {
  return rawTurns(promptTurns).filter((turn) => !isPinnedTurn(turn)).length;
}

/** Adapt a legacy {@link ProbeConfig} into the single pinned turn it equals. */
export function legacyProbeToPinnedTurn(
  probeConfig: ProbeConfig
): PromptTurn & { pinnedToolCall: PinnedToolCall } {
  return {
    id: "turn-1",
    prompt: "",
    expectedToolCalls: [],
    pinnedToolCall: { ...probeConfig },
  };
}

/**
 * Resolve a case's turns, surfacing a legacy `widget_probe` row's top-level
 * `probeConfig` as a single pinned turn so callers see ONE shape.
 */
export function resolvePromptTurnsWithLegacyProbe(
  input: {
    caseType?: string | null;
    probeConfig?: ProbeConfig;
  } & Parameters<typeof resolvePromptTurns>[0]
): PromptTurn[] {
  const turns = resolvePromptTurns(input);
  const hasRealTurn = turns.some(
    (t) =>
      isPinnedTurn(t) ||
      t.prompt.trim().length > 0 ||
      t.expectedToolCalls.length > 0
  );
  if (input.caseType === "widget_probe" && input.probeConfig && !hasRealTurn) {
    return [legacyProbeToPinnedTurn(input.probeConfig)];
  }
  return turns;
}

// ── legacy → steps adapter (migration + editForm seeding only) ──────────────────
function stepId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

/**
 * Stable lookup key for a turn child, shared by `promptTurnsToSteps` (emission)
 * and `stepsToPromptTurns` (recording `childOrder`). Keyed by bucket + index
 * (+ toolName for widgets) — never by position — so the two stay in lockstep.
 */
function childRefKey(ref: PromptTurnChildRef): string {
  return ref.bucket === "expect"
    ? `e:${ref.index}`
    : ref.bucket === "widget"
    ? `w:${ref.toolName}:${ref.index}`
    : `c:${ref.index}`;
}

/** Map a legacy DOM `StepAssertion` (from scriptedSteps) onto a `WidgetAssertion`. */
export function stepAssertionToWidgetAssertion(
  widgetToolName: string,
  a: StepAssertion
): WidgetAssertion {
  switch (a.type) {
    case "textVisible":
      return { kind: "textVisible", toolName: widgetToolName, text: a.text };
    case "elementVisible":
      return {
        kind: "elementVisible",
        toolName: widgetToolName,
        target: a.target,
      };
    case "elementHidden":
      return {
        kind: "elementHidden",
        toolName: widgetToolName,
        target: a.target,
      };
    case "inputValue":
      return {
        kind: "inputValue",
        toolName: widgetToolName,
        target: a.target,
        equals: a.equals,
      };
    case "widgetToolCalled":
      return {
        kind: "widgetToolCalled",
        toolName: widgetToolName,
        calledToolName: a.toolName,
      };
  }
}

/** Map a legacy `ProbeConfig` onto a `toolCall` step. */
export function probeConfigToToolCallStep(
  id: string,
  probe: ProbeConfig
): ToolCallStep {
  return {
    id,
    kind: "toolCall",
    ...(probe.serverId ? { serverId: probe.serverId } : {}),
    serverName: probe.serverName,
    toolName: probe.toolName,
    arguments: probe.arguments as Record<string, unknown>,
    ...(probe.renderTimeoutMs
      ? { renderTimeoutMs: probe.renderTimeoutMs }
      : {}),
  };
}

/**
 * Convert the legacy `PromptTurn[]` model to `TestStep[]`. Used by the one-shot
 * destructive migration and by editForm seeding while the UI is being cut over.
 * Per turn, in order: the action (toolCall OR prompt), expected-tool-call
 * asserts, widget interactions (interact + widget asserts), then per-turn checks.
 */
export function promptTurnsToSteps(turns: PromptTurn[]): TestStep[] {
  const steps: TestStep[] = [];
  turns.forEach((turn, t) => {
    const base = turn.id || `turn-${t + 1}`;

    // The primary action step reuses the turn id VERBATIM (no suffix). It is the
    // only step that keys off the bare `base`; siblings use `expect-N`,
    // `check-N`, `interact-…`, `wassert-…`. Keeping it bare makes the
    // steps↔turns round-trip id-stable: `stepsToPromptTurns` writes
    // `turn.id = step.id`, so re-deriving yields the same id instead of growing
    // a `-prompt`/`-call` suffix each pass (which would remount the editor row
    // and drop input focus on every keystroke).
    if (turn.pinnedToolCall) {
      steps.push(probeConfigToToolCallStep(base, turn.pinnedToolCall));
    } else {
      steps.push({ id: base, kind: "prompt", prompt: turn.prompt });
    }

    // Build each non-primary child once, paired with a stable key. The key is a
    // function of (bucket, index[, toolName]) only — never of emission order —
    // so reordering keeps step ids stable (React row identity / editor focus).
    const entries: Array<{ key: string; step: TestStep }> = [];
    turn.expectedToolCalls.forEach((c, i) => {
      entries.push({
        key: `e:${i}`,
        step: {
          id: stepId(base, `expect-${i}`),
          kind: "assert",
          assertion: {
            type: "toolCalledWith",
            toolName: c.toolName,
            args: { args: c.arguments },
          },
        },
      });
    });
    (turn.widgetChecks ?? []).forEach((group) => {
      (group.steps as ScriptedStep[]).forEach((s, i) => {
        entries.push({
          key: `w:${group.toolName}:${i}`,
          step:
            s.kind === "assert"
              ? {
                  id: stepId(base, `wassert-${group.toolName}-${i}`),
                  kind: "assert",
                  assertion: stepAssertionToWidgetAssertion(
                    group.toolName,
                    s.assertion
                  ),
                }
              : {
                  id: stepId(base, `interact-${group.toolName}-${i}`),
                  kind: "interact",
                  toolName: group.toolName,
                  action: s as InteractAction,
                },
        });
      });
    });
    (turn.checks ?? []).forEach((p, i) => {
      entries.push({
        key: `c:${i}`,
        step: { id: stepId(base, `check-${i}`), kind: "assert", assertion: p },
      });
    });

    // Emit children in the authored order recorded in `childOrder`, then append
    // any not referenced there in the fixed expect→widget→check fallback order.
    // No `childOrder` ⇒ every child falls through to the fallback ⇒ identical to
    // the legacy fixed emission. First key wins (deduped) so a stale/duplicate
    // ref can't emit a child twice.
    const byKey = new Map<string, TestStep>();
    for (const e of entries) if (!byKey.has(e.key)) byKey.set(e.key, e.step);
    const emitted = new Set<string>();
    const emit = (key: string) => {
      const step = byKey.get(key);
      if (step && !emitted.has(key)) {
        emitted.add(key);
        steps.push(step);
      }
    };
    for (const ref of turn.childOrder ?? []) emit(childRefKey(ref));
    for (const e of entries) emit(e.key);
  });
  return steps;
}

// ── inverse: steps → legacy PromptTurn[] (translation boundary) ─────────────────
// The runner's execution loops and the editor's `editForm` still operate on
// `PromptTurn[]`. This adapter lets both keep working while the wire contract
// (route, backend, SDK) speaks `steps` — public `steps` in → internal turns.

/** Inverse of {@link stepAssertionToWidgetAssertion}. */
export function widgetAssertionToStepAssertion(
  a: WidgetAssertion
): StepAssertion {
  switch (a.kind) {
    case "textVisible":
      return { type: "textVisible", text: a.text };
    case "elementVisible":
      return { type: "elementVisible", target: a.target };
    case "elementHidden":
      return { type: "elementHidden", target: a.target };
    case "inputValue":
      return { type: "inputValue", target: a.target, equals: a.equals };
    case "widgetToolCalled":
      return { type: "widgetToolCalled", toolName: a.calledToolName };
  }
}

/** An `InteractAction` is structurally a non-assert `ScriptedStep`. */
export function interactActionToScriptedStep(a: InteractAction): ScriptedStep {
  return a as ScriptedStep;
}

/**
 * Reconstruct `PromptTurn[]` from `TestStep[]`. A `prompt`/`toolCall` step opens
 * a turn; following asserts/interacts attach to it (toolCalledWith → expected
 * calls, other predicates → checks, widget asserts + interacts → widgetChecks
 * grouped by widget toolName). The split into typed buckets loses the authored
 * interleave, so each child's flat-list position is also recorded on
 * `turn.childOrder`, letting {@link promptTurnsToSteps} restore the exact order.
 * Round-trips with {@link promptTurnsToSteps}.
 */
export function stepsToPromptTurns(steps: TestStep[]): PromptTurn[] {
  const turns: PromptTurn[] = [];
  let current: PromptTurn | null = null;
  let widgetGroups = new Map<string, ScriptedStep[]>();

  const flushWidgets = () => {
    if (current && widgetGroups.size > 0) {
      current.widgetChecks = Array.from(widgetGroups.entries()).map(
        ([toolName, s]) => ({ toolName, steps: s })
      );
    }
  };
  const openTurn = (turn: PromptTurn) => {
    flushWidgets();
    current = turn;
    widgetGroups = new Map();
    turns.push(turn);
  };
  const ensureTurn = (): PromptTurn => {
    if (!current) {
      openTurn({
        id: `turn-${turns.length + 1}`,
        prompt: "",
        expectedToolCalls: [],
      });
    }
    return current as PromptTurn;
  };
  // Record the authored position of a child so `promptTurnsToSteps` can re-emit
  // it where the author placed it, instead of the fixed expect→widget→check
  // order. In-memory only; never persisted (see `PromptTurn.childOrder`).
  const pushChild = (turn: PromptTurn, ref: PromptTurnChildRef) => {
    (turn.childOrder ??= []).push(ref);
  };

  for (const step of steps) {
    const tid = `turn-${turns.length + 1}`;
    if (step.kind === "prompt") {
      openTurn({
        id: step.id || tid,
        prompt: step.prompt,
        expectedToolCalls: [],
      });
    } else if (step.kind === "toolCall") {
      openTurn({
        id: step.id || tid,
        prompt: "",
        expectedToolCalls: [],
        pinnedToolCall: {
          ...(step.serverId ? { serverId: step.serverId } : {}),
          serverName: step.serverName,
          toolName: step.toolName,
          arguments: step.arguments as Record<string, any>,
          ...(step.renderTimeoutMs
            ? { renderTimeoutMs: step.renderTimeoutMs }
            : {}),
        },
      });
    } else if (step.kind === "interact") {
      const turn = ensureTurn();
      const g = widgetGroups.get(step.toolName) ?? [];
      // `g.length` is the index this step will occupy in the group's `steps`.
      pushChild(turn, {
        bucket: "widget",
        toolName: step.toolName,
        index: g.length,
      });
      g.push(interactActionToScriptedStep(step.action));
      widgetGroups.set(step.toolName, g);
    } else {
      // assert
      const turn = ensureTurn();
      const a = step.assertion;
      if (isWidgetAssertion(a)) {
        const g = widgetGroups.get(a.toolName) ?? [];
        pushChild(turn, {
          bucket: "widget",
          toolName: a.toolName,
          index: g.length,
        });
        g.push({
          kind: "assert",
          assertion: widgetAssertionToStepAssertion(a),
        });
        widgetGroups.set(a.toolName, g);
      } else if (a.type === "toolCalledWith") {
        // A tool-call assert is represented as an expected tool call so it's
        // evaluated by the matcher (`evaluateMultiTurnResults`), which runs on
        // BOTH the local and hosted/free run paths. (Routing it to `turn.checks`
        // would defeat the hosted path, which does not yet evaluate per-turn
        // checks — see the runner — so the assertion would silently stop gating.
        // Matching is order-agnostic, so this bucket choice doesn't change the
        // result; the authored display position is preserved separately below
        // via `childOrder`.)
        turn.expectedToolCalls.push({
          toolName: a.toolName,
          arguments: a.args.args ?? {},
        });
        pushChild(turn, {
          bucket: "expect",
          index: turn.expectedToolCalls.length - 1,
        });
      } else {
        turn.checks = [...(turn.checks ?? []), a];
        pushChild(turn, { bucket: "check", index: turn.checks.length - 1 });
      }
    }
  }
  flushWidgets();
  return turns;
}

/**
 * For each authored step (by array index), the index of the implicit "turn" it
 * runs in — the SAME turn grouping {@link stepsToPromptTurns} produces. A
 * `prompt`/`toolCall` step opens its own turn; following `interact`/`assert`
 * steps fold into the current turn (or open a fresh turn if none is open yet,
 * mirroring `ensureTurn`). Used to map live `step_status` (emitted at turn
 * granularity) back onto the left-pane step cards. Keep in lockstep with
 * `stepsToPromptTurns`'s turn-opening rules.
 */
export function stepTurnIndices(steps: TestStep[]): number[] {
  const out: number[] = [];
  let turnsOpened = 0;
  let hasOpenTurn = false;
  for (const step of steps) {
    if (step.kind === "prompt" || step.kind === "toolCall") {
      out.push(turnsOpened);
      turnsOpened++;
      hasOpenTurn = true;
    } else if (hasOpenTurn) {
      out.push(turnsOpened - 1);
    } else {
      // interact/assert before any prompt/toolCall → ensureTurn opens turn 0.
      out.push(turnsOpened);
      turnsOpened++;
      hasOpenTurn = true;
    }
  }
  return out;
}
