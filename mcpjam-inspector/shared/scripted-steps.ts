/**
 * Scripted interaction steps for "Widget interaction checks" — Datadog-style
 * synthetic steps replayed against a rendered MCP App widget.
 *
 * The stored shape is per-widget groups: `PromptTurn.widgetChecks: [{ toolName,
 * steps }]`, valid on ANY turn — the widget a group targets can come from a
 * model tool call OR a `pinnedToolCall`. The runner replays a group's steps the
 * moment its widget mounts; an `assert` step's failure gates the iteration. A
 * group's `toolName` must reference a tool the turn uses (pinned or expected) —
 * enforced at the route Zod boundary and the backend
 * `assertValidResolvedTestCaseState`. v1 invariant: a tool renders at most one
 * widget per turn (a second render fails closed; see browser-session-context).
 *
 * Locators are intentionally a BUNDLE of semantic reference points
 * (role / text / css / testId) rather than coordinates: the widget authored
 * against (client preview render) and the widget executed against (headless
 * harness render) are different render instances, so only semantic locators
 * transfer. Resolved in order for v1 (self-healing deferred).
 *
 * Mirrored by the Convex validator in mcpjam-backend
 * `convex/lib/scriptedSteps.ts` (same hand-mirroring arrangement as
 * `probeConfig` / the predicate validators) — edit both in the same PR.
 */

import { z } from "zod";

/** Max scripted steps per turn — keeps snapshotted rows bounded. */
export const MAX_SCRIPTED_STEPS = 50;
/** Max chars for a step's free text (`type` text, assertion text/value). */
export const MAX_SCRIPTED_STEP_TEXT_CHARS = 5_000;
/** Max explicit `wait` duration (ms). */
export const MAX_SCRIPTED_WAIT_MS = 30_000;

/**
 * A bundle of semantic locators for one target element. At least one of
 * role/text/css/testId must be present; they are resolved in priority order
 * (testId → role → text → css) by the harness. `nth` disambiguates when a
 * locator matches multiple elements.
 */
export const elementLocatorSchema = z
  .object({
    // ARIA role + optional accessible name — getByRole(role, { name, exact }).
    // `role` is the ARIA role string ("button"); `name` is separate.
    role: z
      .object({
        role: z.string().min(1),
        name: z.string().optional(),
        exact: z.boolean().optional(),
      })
      .optional(),
    text: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    nth: z.number().int().nonnegative().optional(),
  })
  .refine((loc) => !!(loc.role || loc.text || loc.css || loc.testId), {
    message: "locator must specify at least one of role/text/css/testId",
  });

export type ElementLocator = z.infer<typeof elementLocatorSchema>;

/**
 * An assertion evaluated against the live widget after the preceding steps.
 * A failing assertion fails the iteration (runner verdict gate).
 */
export const stepAssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("textVisible"),
    text: z.string().min(1).max(MAX_SCRIPTED_STEP_TEXT_CHARS),
  }),
  z.object({ type: z.literal("elementVisible"), target: elementLocatorSchema }),
  z.object({ type: z.literal("elementHidden"), target: elementLocatorSchema }),
  z.object({
    type: z.literal("inputValue"),
    target: elementLocatorSchema,
    equals: z.string().max(MAX_SCRIPTED_STEP_TEXT_CHARS),
  }),
  // Reuses the widget→host tool calls the harness already captures.
  z.object({ type: z.literal("widgetToolCalled"), toolName: z.string().min(1) }),
]);

export type StepAssertion = z.infer<typeof stepAssertionSchema>;

/** A single scripted interaction step. */
export const scriptedStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    target: elementLocatorSchema,
    clickType: z.enum(["left", "double", "right"]).optional(),
  }),
  z.object({
    kind: z.literal("type"),
    target: elementLocatorSchema,
    text: z.string().max(MAX_SCRIPTED_STEP_TEXT_CHARS),
  }),
  z.object({ kind: z.literal("key"), key: z.string().min(1) }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("wait"),
    ms: z.number().int().positive().max(MAX_SCRIPTED_WAIT_MS),
  }),
  z.object({ kind: z.literal("assert"), assertion: stepAssertionSchema }),
]);

export type ScriptedStep = z.infer<typeof scriptedStepSchema>;

export const scriptedStepsSchema = z
  .array(scriptedStepSchema)
  .max(MAX_SCRIPTED_STEPS);

/** Max widget-check groups per turn (one per rendered widget). */
export const MAX_WIDGET_CHECKS = 20;

/**
 * One group of scripted steps targeting the widget rendered by `toolName`.
 * Checks are authored per turn, per rendered widget; the runner replays a
 * group's steps against its widget the moment that widget is mounted (model
 * tool call OR pinned tool call). `toolName` is the stable author-time
 * identifier (runtime toolCallIds don't exist yet at authoring).
 */
export const scriptedWidgetCheckSchema = z.object({
  toolName: z.string().min(1),
  steps: scriptedStepsSchema,
});

export type ScriptedWidgetCheck = z.infer<typeof scriptedWidgetCheckSchema>;

export const widgetChecksSchema = z
  .array(scriptedWidgetCheckSchema)
  .max(MAX_WIDGET_CHECKS);

/** True when any group contains an `assert` step (verdict-bearing). */
export function hasScriptedAssertion(
  widgetChecks: ScriptedWidgetCheck[] | undefined,
): boolean {
  return !!widgetChecks?.some((g) => g.steps.some((s) => s.kind === "assert"));
}

/** A locator has at least one usable reference point (no empty strings). */
export function isLocatorComplete(loc: ElementLocator | undefined): boolean {
  if (!loc) return false;
  return !!(
    loc.testId ||
    (loc.role && loc.role.role) ||
    loc.text ||
    loc.css
  );
}

/** A step is complete enough to persist + run (its required locator is filled).
 *  Used to drop half-authored placeholder rows at save time so the route's
 *  strict validator never 400s on an unfinished step. */
export function isStepComplete(step: ScriptedStep): boolean {
  switch (step.kind) {
    case "click":
    case "type":
      return isLocatorComplete(step.target);
    case "key":
      return step.key.trim().length > 0;
    case "scroll":
    case "wait":
      return true;
    case "assert": {
      const a = step.assertion;
      if (a.type === "textVisible") return a.text.trim().length > 0;
      if (a.type === "widgetToolCalled") return a.toolName.trim().length > 0;
      return isLocatorComplete(a.target);
    }
  }
}

/**
 * Drop half-authored steps and empty groups before persisting. Forgiving
 * authoring UX: an unfinished placeholder row (e.g. a fresh `click` with an
 * empty locator) is dropped at save rather than rejected with a 400 by the
 * route's strict validator.
 */
export function sanitizeWidgetChecks(
  widgetChecks: ScriptedWidgetCheck[] | undefined,
): ScriptedWidgetCheck[] | undefined {
  if (!widgetChecks?.length) return undefined;
  const cleaned = widgetChecks
    .map((g) => ({ ...g, steps: g.steps.filter(isStepComplete) }))
    .filter((g) => g.toolName.trim().length > 0 && g.steps.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Append one step to a tool's widgetChecks group (creating the group if absent),
 * preserving every other group. Pure + shared so the live-preview recorder
 * (test-template-editor) and the manual slot editor (expected-conversation)
 * attribute recorded/edited steps the same way. The caller keys by `toolName`
 * (the recorder event's host-tagged tool) — never by editor selection.
 *
 * If the input already holds several groups for the same `toolName`, their steps
 * are merged (none dropped) into the first occurrence's position, so authored
 * group order and any replay that follows array order are preserved.
 */
export function appendWidgetCheckStep(
  groups: ScriptedWidgetCheck[] | undefined,
  toolName: string,
  step: ScriptedStep,
): ScriptedWidgetCheck[] {
  const current = groups ?? [];
  // Gather every step already attributed to this tool across duplicate groups
  // so merging never loses steps.
  const mergedSteps = current
    .filter((g) => g.toolName === toolName)
    .flatMap((g) => g.steps);
  const target: ScriptedWidgetCheck = {
    toolName,
    steps: [...mergedSteps, step],
  };

  let placed = false;
  const result: ScriptedWidgetCheck[] = [];
  for (const g of current) {
    if (g.toolName === toolName) {
      // Keep the first match in place; drop later duplicates (already merged in).
      if (!placed) {
        result.push(target);
        placed = true;
      }
    } else {
      result.push(g);
    }
  }
  if (!placed) result.push(target); // brand-new tool: append at the end.
  return result;
}
