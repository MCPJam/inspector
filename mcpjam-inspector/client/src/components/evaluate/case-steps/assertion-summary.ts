/**
 * The one-line summary of an assertion row in the steps editor.
 *
 * Labels come from the product's existing tables (INLINE_ASSERT_LABELS,
 * PREDICATE_KIND_LABELS, WIDGET_ASSERTION_LABELS, formatCriterion); this
 * module only splits a label from the operand it names.
 */
import { ShieldCheck, type LucideIcon } from "lucide-react";
import { EVAL_ADD_CATALOG } from "@/components/evals/eval-add-catalog";
import {
  checkRole,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import {
  formatCriterion,
  INLINE_ASSERT_LABELS,
  PREDICATE_KIND_LABELS,
} from "@/shared/predicate-kinds";
import {
  isWidgetAssertion,
  WIDGET_ASSERTION_LABELS,
  type WidgetAssertion,
} from "@/shared/steps";
import { quoted, trimmed, where } from "./case-steps-model";

export type AssertionSummary = {
  label: string;
  /** The operand, shown in a code chip. */
  value?: string;
  extra?: string;
  /** Shown in red when the operand is still blank. */
  missing?: string;
  Icon: LucideIcon;
};

const FILL_IN = "Fill in the assertion";
const NAMED_IN_LABEL: ReadonlySet<Predicate["type"]> = new Set<
  Predicate["type"]
>(["widgetRendered", "toolInputMatches", "toolResultMatches"]);
const PICK_VIEW = "Pick a view";

const ICON_BY_KEY = new Map(
  EVAL_ADD_CATALOG.map((entry) => [entry.key, entry.Icon]),
);

function iconFor(key: string): LucideIcon {
  return ICON_BY_KEY.get(key) ?? ShieldCheck;
}

type ArgumentMatching = EvalMatchOptions["argumentMatching"];

function argsExtra(
  predicate: Extract<Predicate, { type: "toolCalledWith" }>,
  routeMatching: ArgumentMatching,
): string {
  const count = Object.keys(predicate.args?.args ?? {}).length;
  // A gating assert is graded by the case's match options, not its own.
  const own = predicate.args?.argumentMatching;
  const gating = checkRole(predicate) !== "advisory";
  const mode = (gating && routeMatching ? routeMatching : own) ?? "partial";
  if (mode === "ignore") return "any arguments";
  // Exact matching compares the whole object: no arguments means none allowed.
  if (count === 0) return mode === "exact" ? "no arguments" : "any arguments";
  return `${count} argument${count === 1 ? "" : "s"}, ${mode} match`;
}

/** The operand a "…" label stops at. */
function ellipsisOperand(predicate: Predicate): string {
  switch (predicate.type) {
    case "toolCalledWith":
    case "firstToolWas":
      return trimmed(predicate.toolName);
    case "responseContains":
    case "toolResultContains":
      return trimmed(predicate.needle);
    case "responseCloseTo":
      return trimmed(predicate.reference);
    case "responseMatches":
      return predicate.pattern ? `/${predicate.pattern}/` : "";
    case "toolResultMatchesSchema":
      return trimmed(predicate.toolName);
    default:
      return "";
  }
}

/** The operand of a label that names no placeholder but does name tools. */
function toolOperand(predicate: Predicate): string | null {
  switch (predicate.type) {
    case "toolCalledAtLeastOnce":
    case "toolNeverCalled":
      return trimmed(predicate.toolName);
    case "onlyToolsCalled":
      return (predicate.toolNames ?? []).join(", ");
    case "toolCalledBefore": {
      const first = trimmed(predicate.toolName);
      const then = trimmed(predicate.beforeToolName);
      return first && then ? `${first} → ${then}` : "";
    }
    default:
      return null;
  }
}

function predicateSummary(
  predicate: Predicate,
  inline: boolean,
  routeMatching: ArgumentMatching,
): AssertionSummary {
  const Icon = iconFor(`check:${predicate.type}`);
  // A kind from a newer build has no label here; show its name, not a crash.
  if (!Object.hasOwn(PREDICATE_KIND_LABELS, predicate.type)) {
    return { label: String(predicate.type), Icon };
  }
  const base = PREDICATE_KIND_LABELS[predicate.type];
  const extra =
    predicate.type === "toolCalledWith"
      ? argsExtra(predicate, routeMatching)
      : undefined;
  if (base.endsWith("…")) {
    const value = ellipsisOperand(predicate);
    // toolResultMatchesSchema's operand (a tool) is optional: blank is "any tool".
    const optional = predicate.type === "toolResultMatchesSchema";
    return {
      label: base.slice(0, -1),
      ...(value ? { value } : optional ? {} : { missing: FILL_IN }),
      ...(extra ? { extra } : {}),
      Icon,
    };
  }
  if (/ N\b/.test(base)) {
    return { label: formatCriterion({ predicate }), Icon };
  }
  // These name their tool and patterns in the label itself. An empty
  // onlyToolsCalled list is a whole claim: "No tool should be called".
  const noTool =
    predicate.type === "onlyToolsCalled" &&
    Array.isArray(predicate.toolNames) &&
    predicate.toolNames.length === 0;
  if (noTool || NAMED_IN_LABEL.has(predicate.type)) {
    return { label: formatCriterion({ predicate }), Icon };
  }
  const label =
    (inline ? INLINE_ASSERT_LABELS[predicate.type] : undefined) ?? base;
  const operand = toolOperand(predicate);
  if (operand === null) return { label, Icon };
  return {
    label,
    ...(operand ? { value: operand } : { missing: FILL_IN }),
    Icon,
  };
}

function widgetValue(assertion: WidgetAssertion): string {
  switch (assertion.kind) {
    case "textVisible":
      return trimmed(assertion.text);
    case "inputValue": {
      const at = where(assertion.target);
      const equals = trimmed(assertion.equals);
      return at ? `${at} = ${quoted(equals)}` : "";
    }
    case "widgetToolCalled":
      return trimmed(assertion.calledToolName);
    case "elementVisible":
    case "elementHidden":
      return where(assertion.target);
  }
}

function widgetSummary(assertion: WidgetAssertion): AssertionSummary {
  const Icon = iconFor(`widget:${assertion.kind}`);
  // A kind from a newer build has no label here; show its name, as above.
  if (!Object.hasOwn(WIDGET_ASSERTION_LABELS, assertion.kind)) {
    return { label: String(assertion.kind), Icon };
  }
  const view = trimmed(assertion.toolName);
  const value = widgetValue(assertion);
  return {
    label: WIDGET_ASSERTION_LABELS[assertion.kind],
    ...(!view
      ? { missing: PICK_VIEW }
      : value
        ? { value }
        : { missing: FILL_IN }),
    ...(view ? { extra: `in ${view}` } : {}),
    Icon,
  };
}

/**
 * `inline`: the assertion sits under a step, so the "so far" labels apply.
 * `routeMatching`: the case's resolved argument matching, which grades a
 * gating `toolCalledWith`.
 */
export function assertionSummary(
  assertion: Predicate | WidgetAssertion,
  inline: boolean,
  routeMatching?: ArgumentMatching,
): AssertionSummary {
  return isWidgetAssertion(assertion)
    ? widgetSummary(assertion)
    : predicateSummary(assertion, inline, routeMatching);
}
