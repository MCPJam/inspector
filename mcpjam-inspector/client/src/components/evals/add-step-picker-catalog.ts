/**
 * Authoring catalog for the eval Add Step picker.
 *
 * Pure data — no Lucide icons (those live in add-step-picker.tsx).
 * Every inline scenario predicate kind MUST appear exactly once here;
 * see add-step-picker-catalog.test.ts for the load-bearing integrity check.
 */

import type { WidgetAssertion } from "@/shared/steps";
import {
  PREDICATE_KIND_LABELS,
  labelForInlineAssert,
} from "@/shared/predicate-kinds";
import type { Kind } from "./predicate-kind-meta";

/** Discriminated union emitted when the user picks an item. */
export type AddStepPickerChoice =
  | { kind: "step"; stepKind: "prompt" | "interact" | "toolCall" }
  | { kind: "check"; predicateKind: Kind }
  | { kind: "widget-check"; widgetKind: WidgetAssertion["kind"] };

export type PickerTier = "primary" | "secondary";

export type PickerGroupId =
  | "drive"
  | "transcriptEssentials"
  | "transcriptMore"
  | "viewLifecycle"
  | "viewContent"
  | "health";

export type PickerCatalogEntry = {
  key: string;
  group: PickerGroupId;
  tier: PickerTier;
  label: string;
  /** Optional one-line hint shown under the label (essentials only). */
  hint?: string;
  keywords: string[];
  choice: AddStepPickerChoice;
};

export const PICKER_GROUP_ORDER: readonly PickerGroupId[] = [
  "drive",
  "transcriptEssentials",
  "transcriptMore",
  "viewLifecycle",
  "viewContent",
  "health",
] as const;

export const PICKER_GROUP_LABELS: Record<PickerGroupId, string> = {
  drive: "Actions",
  transcriptEssentials: "Checks",
  transcriptMore: "More conversation checks",
  viewLifecycle: "Did the view load",
  viewContent: "What's on screen",
  health: "Run health",
};

export const PICKER_GROUP_DESCRIPTIONS: Record<PickerGroupId, string> = {
  drive: "Send a message, call a tool directly, or interact with the view",
  transcriptEssentials: "What the AI did or said",
  transcriptMore: "Tool-call order and assistant message patterns",
  viewLifecycle: "Whether the view rendered correctly",
  viewContent: "What's visible in the rendered view",
  health: "Must hold so far in the run",
};

export const PICKER_CATALOG: readonly PickerCatalogEntry[] = [
  // ── Tier 1: Actions ───────────────────────────────────────────────────────
  {
    key: "prompt",
    group: "drive",
    tier: "primary",
    label: "Prompt",
    keywords: ["message", "user", "chat"],
    choice: { kind: "step", stepKind: "prompt" },
  },
  {
    key: "interact",
    group: "drive",
    tier: "primary",
    label: "Interact",
    keywords: ["click", "widget", "ui"],
    choice: { kind: "step", stepKind: "interact" },
  },
  {
    key: "toolCall",
    group: "drive",
    tier: "primary",
    label: "Call tool",
    keywords: ["tool", "direct", "deterministic", "pinned", "probe"],
    choice: { kind: "step", stepKind: "toolCall" },
  },
  // ── Tier 1: Check essentials ──────────────────────────────────────────────
  {
    key: "check:toolCalledWith",
    group: "transcriptEssentials",
    tier: "primary",
    label: PREDICATE_KIND_LABELS.toolCalledWith,
    hint: "Model or app → server",
    keywords: [
      "tool",
      "call",
      "args",
      "widget",
      "clicked",
      "callback",
      "tool-input",
      "app",
      "structuredContent",
    ],
    choice: { kind: "check", predicateKind: "toolCalledWith" },
  },
  {
    key: "check:responseContains",
    group: "transcriptEssentials",
    tier: "primary",
    label: PREDICATE_KIND_LABELS.responseContains,
    keywords: ["text", "assistant", "contains", "message"],
    choice: { kind: "check", predicateKind: "responseContains" },
  },
  {
    key: "check:widgetRendered",
    group: "transcriptEssentials",
    tier: "primary",
    label: PREDICATE_KIND_LABELS.widgetRendered,
    hint: "Host mounted the view",
    keywords: ["widget", "render", "initialize", "iframe", "mount"],
    choice: { kind: "check", predicateKind: "widgetRendered" },
  },
  // ── Tier 2: More conversation checks ──────────────────────────────────────
  {
    key: "check:toolCalledAtLeastOnce",
    group: "transcriptMore",
    tier: "secondary",
    label: labelForInlineAssert("toolCalledAtLeastOnce"),
    keywords: ["tool", "call", "at least"],
    choice: { kind: "check", predicateKind: "toolCalledAtLeastOnce" },
  },
  {
    key: "check:toolNeverCalled",
    group: "transcriptMore",
    tier: "secondary",
    label: labelForInlineAssert("toolNeverCalled"),
    keywords: ["tool", "never", "negative"],
    choice: { kind: "check", predicateKind: "toolNeverCalled" },
  },
  {
    key: "check:firstToolWas",
    group: "transcriptMore",
    tier: "secondary",
    label: labelForInlineAssert("firstToolWas"),
    keywords: ["tool", "first", "order"],
    choice: { kind: "check", predicateKind: "firstToolWas" },
  },
  {
    key: "check:responseMatches",
    group: "transcriptMore",
    tier: "secondary",
    label: labelForInlineAssert("responseMatches"),
    keywords: ["regex", "pattern", "assistant"],
    choice: { kind: "check", predicateKind: "responseMatches" },
  },
  {
    key: "check:finalAssistantMessageNonEmpty",
    group: "transcriptMore",
    tier: "secondary",
    label: labelForInlineAssert("finalAssistantMessageNonEmpty"),
    keywords: ["assistant", "reply", "non-empty", "message"],
    choice: { kind: "check", predicateKind: "finalAssistantMessageNonEmpty" },
  },
  // ── Tier 2: Did the view load ─────────────────────────────────────────────
  {
    key: "check:widgetRenderLatencyUnder",
    group: "viewLifecycle",
    tier: "secondary",
    label: labelForInlineAssert("widgetRenderLatencyUnder"),
    keywords: ["widget", "render", "latency", "performance", "ms"],
    choice: { kind: "check", predicateKind: "widgetRenderLatencyUnder" },
  },
  {
    key: "check:widgetNoConsoleErrors",
    group: "viewLifecycle",
    tier: "secondary",
    label: labelForInlineAssert("widgetNoConsoleErrors"),
    keywords: ["console", "error", "widget", "csp"],
    choice: { kind: "check", predicateKind: "widgetNoConsoleErrors" },
  },
  // ── Tier 2: What's on screen ────────────────────────────────────────────────
  {
    key: "widget:textVisible",
    group: "viewContent",
    tier: "secondary",
    label: "Text visible",
    keywords: ["text", "visible", "dom"],
    choice: { kind: "widget-check", widgetKind: "textVisible" },
  },
  {
    key: "widget:elementVisible",
    group: "viewContent",
    tier: "secondary",
    label: "Element visible",
    keywords: ["element", "visible", "selector"],
    choice: { kind: "widget-check", widgetKind: "elementVisible" },
  },
  {
    key: "widget:elementHidden",
    group: "viewContent",
    tier: "secondary",
    label: "Element hidden",
    keywords: ["element", "hidden"],
    choice: { kind: "widget-check", widgetKind: "elementHidden" },
  },
  {
    key: "widget:inputValue",
    group: "viewContent",
    tier: "secondary",
    label: "Input value equals",
    keywords: ["input", "value", "form"],
    choice: { kind: "widget-check", widgetKind: "inputValue" },
  },
  // ── Tier 2: Run health ──────────────────────────────────────────────────────
  {
    key: "check:noToolErrors",
    group: "health",
    tier: "secondary",
    label: labelForInlineAssert("noToolErrors"),
    keywords: ["tool", "error", "mcp", "transport"],
    choice: { kind: "check", predicateKind: "noToolErrors" },
  },
];

export function primaryItems(): PickerCatalogEntry[] {
  return PICKER_CATALOG.filter((e) => e.tier === "primary");
}

export function secondaryItems(): PickerCatalogEntry[] {
  return PICKER_CATALOG.filter((e) => e.tier === "secondary");
}

export function secondaryCount(): number {
  return secondaryItems().length;
}

export function catalogPredicateKinds(): Kind[] {
  return PICKER_CATALOG.filter(
    (e): e is PickerCatalogEntry & { choice: { kind: "check" } } =>
      e.choice.kind === "check",
  ).map((e) => e.choice.predicateKind);
}

export function catalogStepKinds(): Array<"prompt" | "interact" | "toolCall"> {
  return PICKER_CATALOG.filter(
    (
      e,
    ): e is PickerCatalogEntry & {
      choice: { kind: "step"; stepKind: "prompt" | "interact" | "toolCall" };
    } => e.choice.kind === "step",
  ).map((e) => e.choice.stepKind);
}

export function catalogWidgetCheckKinds(): WidgetAssertion["kind"][] {
  return PICKER_CATALOG.filter(
    (e): e is PickerCatalogEntry & { choice: { kind: "widget-check" } } =>
      e.choice.kind === "widget-check",
  ).map((e) => e.choice.widgetKind);
}
