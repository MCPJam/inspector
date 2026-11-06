/**
 * The one-line summary of an assertion row in the steps editor.
 *
 * Labels come from the product's existing tables (INLINE_ASSERT_LABELS,
 * PREDICATE_KIND_LABELS, WIDGET_ASSERTION_LABELS, formatCriterion); this
 * module only splits a label from the operand it names.
 */
import { ShieldCheck, type LucideIcon } from "lucide-react";
import { describeLocator } from "@/components/evals/assert-pick-chooser";
import { EVAL_ADD_CATALOG } from "@/components/evals/eval-add-catalog";
import type { Predicate } from "@/shared/eval-matching";
import {
  formatCriterion,
  INLINE_ASSERT_LABELS,
  PREDICATE_KIND_LABELS,
} from "@/shared/predicate-kinds";
import { isLocatorComplete } from "@/shared/scripted-steps";
import {
  isWidgetAssertion,
  WIDGET_ASSERTION_LABELS,
  type WidgetAssertion,
} from "@/shared/steps";

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
const PICK_VIEW = "Pick a view";

const ICON_BY_KEY = new Map(
  EVAL_ADD_CATALOG.map((entry) => [entry.key, entry.Icon]),
);

function iconFor(key: string): LucideIcon {
  return ICON_BY_KEY.get(key) ?? ShieldCheck;
}

const trimmed = (value: string | undefined) => (value ?? "").trim();
const quoted = (text: string) => `“${text}”`;

function where(target: Parameters<typeof isLocatorComplete>[0]): string {
  return target && isLocatorComplete(target) ? describeLocator(target) : "";
}

function argsExtra(
  predicate: Extract<Predicate, { type: "toolCalledWith" }>,
): string {
  const count = Object.keys(predicate.args?.args ?? {}).length;
  const mode = predicate.args?.argumentMatching ?? "partial";
  if (mode === "ignore" || count === 0) return "any arguments";
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
): AssertionSummary {
  const Icon = iconFor(`check:${predicate.type}`);
  const base = PREDICATE_KIND_LABELS[predicate.type];
  const extra =
    predicate.type === "toolCalledWith" ? argsExtra(predicate) : undefined;
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
    Icon: iconFor(`widget:${assertion.kind}`),
  };
}

/** `inline`: the assertion sits under a step, so the "so far" labels apply. */
export function assertionSummary(
  assertion: Predicate | WidgetAssertion,
  inline: boolean,
): AssertionSummary {
  return isWidgetAssertion(assertion)
    ? widgetSummary(assertion)
    : predicateSummary(assertion, inline);
}
