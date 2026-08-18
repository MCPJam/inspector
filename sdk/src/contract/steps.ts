/**
 * Unified test-step model — the authored unit of an MCP-app synthetic test.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * A test case is an ORDERED `TestStep[]` (Datadog-Synthetics-style): you record
 * a scenario by interacting with the live app, and assertions are first-class
 * steps interleaved inline.
 *
 * The four authored kinds:
 *   - `prompt`   — a user message; the model decides which tools to call.
 *   - `toolCall` — a deterministic, model-free tool call.
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
 * ── Why this lives in the SDK contract, not in the inspector app ─────────────
 *
 * The step union is part of the evaluation CONTRACT: it is what a suite file
 * carries, what the hosted API accepts, and what a code-first author writes.
 * It used to live in `mcpjam-inspector/shared/steps.ts`, which the SDK cannot
 * import (the dependency direction is shared → sdk, never the reverse), so
 * putting a suite-file schema in the SDK would have required a hand-mirrored
 * SECOND copy inside the SDK — a third sibling beside `shared/` and Convex.
 * The definition therefore moved HERE and `shared/steps.ts` re-exports it, so
 * there is exactly one definition and the inspector's 50-odd consumers are
 * unchanged.
 *
 * Mirrored by the Convex validator in mcpjam-backend `convex/lib/steps.ts`
 * (same hand-mirroring arrangement as `scriptedSteps` / `probeConfig` / the
 * predicate validators) — edit both in the same PR.
 *
 * ── Every object DECLARED here is `.strict()` ────────────────────────────────
 *
 * A field this union does not declare is an ERROR, never a silently dropped
 * key. Two reasons, and the second is the one that forced the change:
 *
 *  1. The Convex mirror is built from `v.object`, which rejects unknown fields.
 *     A permissive schema here accepted step payloads the backend refuses, so
 *     the two validators disagreed about which files are valid — and the
 *     disagreement was invisible until ingest.
 *  2. Steps are the surface an IMPORTER writes. A converter that mis-maps a
 *     source field into a step (`text` where the contract says `prompt`) must
 *     fail at the line that is wrong, not produce a step that runs and asserts
 *     nothing. Silently discarding half of what was read is the exact failure
 *     the closed-schema rule exists to prevent, and step level is where a
 *     mis-mapped field actually lands.
 *
 * Two things are deliberately NOT closed:
 *
 *  - `toolCallStep.arguments` — the tool's OWN argument object. Its keys come
 *    from the server's input schema, not from this contract; closing it would
 *    mean this file had to know every tool's arguments.
 *  - The reused `predicateSchema` inside an `assert` step. That union is a
 *    separate contract module (`../predicates/types.ts`) with its own Convex
 *    mirror and its own parity fixtures, and it is authored from many more
 *    surfaces than steps (swarm rubrics, the Checks panel, suite defaults).
 *    Closing it is a change to THAT contract, made there with its own consumer
 *    audit — not a side effect of closing this one.
 */

import { z } from "zod";
import { predicateSchema, type Predicate } from "../predicates/types.js";

// ── caps (relocated with the schemas that enforce them) ──────────────────────
/** Max chars for a step's free text (`type` text, assertion text/value). */
export const MAX_SCRIPTED_STEP_TEXT_CHARS = 5_000;
/** Max explicit `wait` duration (ms). */
export const MAX_SCRIPTED_WAIT_MS = 30_000;
/** Tool-call render budget ceiling — matches the backend validator's cap. */
export const MAX_PROBE_RENDER_TIMEOUT_MS = 120_000;
/**
 * Max serialized size (chars) of a tool call's pinned arguments — matches
 * `MAX_PROBE_ARGS_CHARS` in the mcpjam-backend validator
 * (`convex/lib/probeConfig.ts`). Arguments are stored verbatim and snapshotted
 * into every iteration, so an unbounded blob would bloat rows.
 */
export const MAX_PROBE_ARGS_CHARS = 100_000;

/**
 * A bundle of semantic locators for one target element. At least one of
 * role/text/css/testId must be present; they are resolved in priority order
 * (testId → role → text → css) by the harness. `nth` disambiguates when a
 * locator matches multiple elements.
 *
 * Locators are intentionally a BUNDLE of semantic reference points rather than
 * coordinates: the widget authored against (client preview render) and the
 * widget executed against (headless harness render) are different render
 * instances, so only semantic locators transfer.
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
      .strict()
      .optional(),
    text: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    nth: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((loc) => !!(loc.role || loc.text || loc.css || loc.testId), {
    message: "locator must specify at least one of role/text/css/testId",
  });

export type ElementLocator = z.infer<typeof elementLocatorSchema>;

export const TEST_STEP_KINDS = [
  "prompt",
  "toolCall",
  "interact",
  "assert",
] as const;
export type TestStepKind = (typeof TEST_STEP_KINDS)[number];

// ── prompt ──────────────────────────────────────────────────────────────────
export const promptStepSchema = z
  .object({
    id: z.string(),
    kind: z.literal("prompt"),
    prompt: z.string(),
  })
  .strict();
export type PromptStep = z.infer<typeof promptStepSchema>;

// ── toolCall (deterministic, model-free) ────────────────────────────────────
const toolCallArgumentsSchema = z.record(z.string(), z.unknown()).refine(
  (v) => {
    try {
      return JSON.stringify(v).length <= MAX_PROBE_ARGS_CHARS;
    } catch {
      return false;
    }
  },
  {
    message: `arguments must be ≤ ${MAX_PROBE_ARGS_CHARS} characters when serialized`,
  }
);

export const toolCallStepSchema = z
  .object({
    id: z.string(),
    kind: z.literal("toolCall"),
    // `serverId` is the stable project-server reference (resolved against the
    // run environment's serverBindings at execution time); `serverName` is the
    // display fallback. Id wins when both are present.
    serverId: z.string().min(1).optional(),
    serverName: z.string().min(1),
    toolName: z.string().min(1),
    // NOT closed, and never should be: this is the tool's OWN argument object,
    // whose keys belong to the server's input schema rather than to ours.
    arguments: toolCallArgumentsSchema,
    /** Per-call render budget override (ms); harness default applies when absent. */
    renderTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PROBE_RENDER_TIMEOUT_MS)
      .optional(),
  })
  .strict();
export type ToolCallStep = z.infer<typeof toolCallStepSchema>;

// ── interact (PURE actions — never an assertion) ─────────────────────────────
export const interactActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("click"),
      target: elementLocatorSchema,
      clickType: z.enum(["left", "double", "right"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("type"),
      target: elementLocatorSchema,
      text: z.string().max(MAX_SCRIPTED_STEP_TEXT_CHARS),
    })
    .strict(),
  z.object({ kind: z.literal("key"), key: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down"]),
      amount: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wait"),
      ms: z.number().int().positive().max(MAX_SCRIPTED_WAIT_MS),
    })
    .strict(),
]);
export type InteractAction = z.infer<typeof interactActionSchema>;

export const interactStepSchema = z
  .object({
    id: z.string(),
    kind: z.literal("interact"),
    /** The widget this action targets (the tool that rendered it). */
    toolName: z.string().min(1),
    action: interactActionSchema,
  })
  .strict();
export type InteractStep = z.infer<typeof interactStepSchema>;

// ── assert ───────────────────────────────────────────────────────────────────
/**
 * DOM/widget-level assertions evaluated against the live widget by the headless
 * harness (NOT the transcript predicate engine). `toolName` is always the WIDGET
 * being asserted against. `widgetToolCalled.calledToolName` is the tool the
 * widget invoked (distinct from the widget's own tool).
 *
 * ── Why this is a SEPARATE union from `Predicate`, and stays one ─────────────
 *
 * The dividing line is what the assertion is evaluated AGAINST, and therefore
 * what can re-run it later:
 *
 *  - A `Predicate` is evaluated against a persisted TRANSCRIPT. Anything
 *    holding one — the eval runner, the swarm checks runner, an on-demand
 *    re-grade months later — can re-derive the same verdict from stored data
 *    by calling the SDK's pure evaluator. That is why swarm rubrics, whole-run
 *    checks and the per-session Checks panel are all predicate-shaped.
 *  - A `WidgetAssertion` is evaluated against a LIVE DOM inside the browser
 *    harness, at the moment the step runs. Nothing is persisted that could
 *    reproduce it: the transcript records that a widget rendered, not what was
 *    on screen inside it. Re-running the assertion means re-running the
 *    session.
 *
 * That is the whole reason `widgetRendered` is a `Predicate` while
 * `textVisible` is not, even though both sound like claims about a view.
 * "Did the host mount this widget?" is answered by a render observation the
 * transcript already carries; "is the word 'Refunded' visible in it?" is
 * answered only by looking at the live document.
 *
 * The consequence is not cosmetic: swarms have no `TestStep[]` and no browser
 * harness, so they cannot author or evaluate widget assertions at all. Merging
 * the two unions would put kinds in the swarm rubric menu that can never
 * produce a verdict there.
 *
 * Re-evaluate this split if a persisted-DOM-snapshot capability lands (a
 * serialized document per render observation, not just a screenshot). At that
 * point widget assertions become transcript-replayable and the argument for
 * two vocabularies goes away.
 */
export const widgetAssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("textVisible"),
      toolName: z.string().min(1),
      text: z.string().min(1).max(MAX_SCRIPTED_STEP_TEXT_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("elementVisible"),
      toolName: z.string().min(1),
      target: elementLocatorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("elementHidden"),
      toolName: z.string().min(1),
      target: elementLocatorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inputValue"),
      toolName: z.string().min(1),
      target: elementLocatorSchema,
      equals: z.string().max(MAX_SCRIPTED_STEP_TEXT_CHARS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("widgetToolCalled"),
      toolName: z.string().min(1),
      calledToolName: z.string().min(1),
    })
    .strict(),
]);
export type WidgetAssertion = z.infer<typeof widgetAssertionSchema>;

/**
 * An assert step's payload is EITHER a model-level `Predicate` (keyed on `type`)
 * OR a DOM-level `WidgetAssertion` (keyed on `kind`). Disjoint discriminator
 * keys — and an object carrying BOTH is refused rather than resolved.
 *
 * That refusal is load-bearing, and it is why the predicate branch is guarded
 * instead of being left as a bare union member. `{ kind: "textVisible", type:
 * "noToolErrors", … }` is ambiguous by construction: the widget branch is
 * closed and rejects the stray `type`, while the predicate branch — open,
 * because predicates are a separate contract — would happily accept it and
 * strip every widget field, silently turning "the word 'Refunded' is on
 * screen" into "no tool errors occurred". The second of those passes almost
 * always. A green eval that checks something nobody asked for is the worst
 * outcome available here, and it is exactly what closing the widget objects
 * would otherwise have introduced.
 *
 * The guard is an object declaring `kind` as `never`, intersected with the
 * predicate branch. It is deliberately NOT a `.refine()` on the union: a
 * refinement runs on the parsed output, by which point `kind` has already been
 * stripped and the evidence is gone. It also projects into the generated JSON
 * Schema (`kind: {not: {}}`), so the published contract and the Convex mirror
 * — whose `v.object` predicate validators reject the extra keys outright —
 * agree with this one about the same payload.
 */
const notAWidgetAssertion = z.object({ kind: z.never().optional() });
export const stepAssertionPayloadSchema = z.union([
  widgetAssertionSchema,
  z.intersection(predicateSchema, notAWidgetAssertion),
]);
export type StepAssertionPayload = WidgetAssertion | Predicate;

export const assertStepSchema = z
  .object({
    id: z.string(),
    kind: z.literal("assert"),
    assertion: stepAssertionPayloadSchema,
  })
  .strict();
export type AssertStep = z.infer<typeof assertStepSchema>;

// ── the union ────────────────────────────────────────────────────────────────
export const testStepSchema = z.discriminatedUnion("kind", [
  promptStepSchema,
  toolCallStepSchema,
  interactStepSchema,
  assertStepSchema,
]);
export type TestStep = z.infer<typeof testStepSchema>;

/** Max steps per case — keeps snapshotted rows bounded. */
export const MAX_TEST_STEPS = 200;
export const stepsSchema = z.array(testStepSchema).max(MAX_TEST_STEPS);

// ── narrowing helpers ────────────────────────────────────────────────────────
export const isPromptStep = (s: TestStep): s is PromptStep =>
  s.kind === "prompt";
export const isToolCallStep = (s: TestStep): s is ToolCallStep =>
  s.kind === "toolCall";
export const isInteractStep = (s: TestStep): s is InteractStep =>
  s.kind === "interact";
export const isAssertStep = (s: TestStep): s is AssertStep =>
  s.kind === "assert";

/** True when `assertion` is a DOM-level WidgetAssertion (vs a transcript Predicate). */
export function isWidgetAssertion(
  a: StepAssertionPayload
): a is WidgetAssertion {
  return typeof (a as { kind?: unknown }).kind === "string";
}
