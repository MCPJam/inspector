/**
 * Predicate kind metadata shared between client authoring UI and migration helpers.
 */

import type { Predicate } from "@/shared/eval-matching";
import {
  isTurnScopablePredicateKind,
  TURN_SCOPABLE_PREDICATE_KINDS,
} from "@mcpjam/sdk/predicates";

export type PredicateKind = Predicate["type"];

export const PREDICATE_KIND_LABELS: Record<PredicateKind, string> = {
  toolCalledWith: "Tool was called with…",
  toolCalledAtLeastOnce: "Tool was called at least once",
  toolNeverCalled: "Tool was never called",
  firstToolWas: "First tool called was…",
  responseContains: "Response contains…",
  responseMatches: "Response matches regex…",
  noToolErrors: "No tool errors",
  finalAssistantMessageNonEmpty: "Final message non-empty",
  tokenBudgetUnder: "Token budget under N",
  widgetRendered: "View rendered",
  widgetRenderLatencyUnder: "View rendered under N ms",
  widgetNoConsoleErrors: "No view console errors",
};

export const INLINE_ASSERT_LABELS: Partial<Record<PredicateKind, string>> = {
  noToolErrors: "No tool errors so far",
  widgetNoConsoleErrors: "No view console errors so far",
};

export const STEP_ASSERT_PREDICATE_KINDS: readonly PredicateKind[] = [
  ...TURN_SCOPABLE_PREDICATE_KINDS,
] as PredicateKind[];

export function isScenarioPredicateKind(kind: PredicateKind): boolean {
  return isTurnScopablePredicateKind(kind) && kind !== "tokenBudgetUnder";
}

export const PREDICATE_KIND_ORDER: PredicateKind[] = [
  "toolCalledWith",
  "toolCalledAtLeastOnce",
  "toolNeverCalled",
  "firstToolWas",
  "responseContains",
  "responseMatches",
  "noToolErrors",
  "finalAssistantMessageNonEmpty",
  "tokenBudgetUnder",
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
];

export const SYNTHETIC_MONITOR_KINDS: ReadonlySet<PredicateKind> = new Set([
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
]);

export const GLOBAL_POLICY_MENU_KINDS: readonly PredicateKind[] = [
  "tokenBudgetUnder",
  "noToolErrors",
  "widgetNoConsoleErrors",
];

/** Authoring catalog for whole-run global gates — short labels + tooltip copy. */
export type GlobalGateCatalogEntry = {
  kind: PredicateKind;
  label: string;
  /** One-line summary (tooltip title line). */
  description: string;
  /** Longer tooltip body for progressive disclosure. */
  detail: string;
};

export const GLOBAL_GATES_SECTION_HELP = {
  title: "Global gates",
  paragraphs: [
    "Whole-run rules evaluated after the scenario finishes, using the full transcript.",
    "Step checks run inline at a specific point in the flow — use those for conversation and view assertions.",
    "Case gates extend suite defaults. Add here only for policies that must hold across the entire run.",
  ],
} as const;

export const GLOBAL_GATE_CATALOG: GlobalGateCatalogEntry[] = [
  {
    kind: "tokenBudgetUnder",
    label: "Token budget",
    description: "Keep total tokens under a limit",
    detail:
      "Counts input and output tokens across the whole iteration. Fails when the total is greater than or equal to your limit.",
  },
  {
    kind: "noToolErrors",
    label: "No tool errors",
    description: "No MCP or transport tool failures",
    detail:
      "Passes when no tool reported an error anywhere in the run — neither MCP isError nor a transport failure.",
  },
  {
    kind: "widgetNoConsoleErrors",
    label: "No view console errors",
    description: "Rendered views must not log console errors",
    detail:
      "Passes when no rendered view logged console errors. Fails when the run recorded no view renders. Optionally limit to one view tool.",
  },
];

export function isGlobalPolicyKind(kind: PredicateKind): boolean {
  return (GLOBAL_POLICY_MENU_KINDS as readonly string[]).includes(kind);
}

export function globalGateLabel(kind: PredicateKind): string {
  const entry = GLOBAL_GATE_CATALOG.find((g) => g.kind === kind);
  return entry?.label ?? PREDICATE_KIND_LABELS[kind];
}

export function globalGateDescription(kind: PredicateKind): string | undefined {
  return GLOBAL_GATE_CATALOG.find((g) => g.kind === kind)?.description;
}

export function globalGateDetail(kind: PredicateKind): string | undefined {
  return GLOBAL_GATE_CATALOG.find((g) => g.kind === kind)?.detail;
}

export function labelForGlobalGate(kind: PredicateKind): string {
  return globalGateLabel(kind);
}

export function labelForInlineAssert(kind: PredicateKind): string {
  return INLINE_ASSERT_LABELS[kind] ?? PREDICATE_KIND_LABELS[kind];
}

export function blankPredicate(kind: PredicateKind): Predicate {
  switch (kind) {
    case "toolCalledWith":
      return { type: "toolCalledWith", toolName: "", args: { args: {} } };
    case "toolCalledAtLeastOnce":
      return { type: "toolCalledAtLeastOnce", toolName: "" };
    case "toolNeverCalled":
      return { type: "toolNeverCalled", toolName: "" };
    case "firstToolWas":
      return { type: "firstToolWas", toolName: "" };
    case "responseContains":
      return { type: "responseContains", needle: "" };
    case "responseMatches":
      return { type: "responseMatches", pattern: "" };
    case "noToolErrors":
      return { type: "noToolErrors" };
    case "finalAssistantMessageNonEmpty":
      return { type: "finalAssistantMessageNonEmpty" };
    case "tokenBudgetUnder":
      return { type: "tokenBudgetUnder", tokens: 1000 };
    case "widgetRendered":
      return { type: "widgetRendered" };
    case "widgetRenderLatencyUnder":
      return { type: "widgetRenderLatencyUnder", ms: 3000 };
    case "widgetNoConsoleErrors":
      return { type: "widgetNoConsoleErrors" };
  }
}

export function filterKindsForMenu(
  kinds: readonly PredicateKind[],
  syntheticMonitorsEnabled: boolean,
  allowed?: readonly PredicateKind[] | null,
): PredicateKind[] {
  const allowedSet = allowed ? new Set(allowed) : null;
  return kinds.filter(
    (kind) =>
      (syntheticMonitorsEnabled || !SYNTHETIC_MONITOR_KINDS.has(kind)) &&
      (!allowedSet || allowedSet.has(kind)),
  );
}
