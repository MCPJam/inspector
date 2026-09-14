import type { LucideIcon } from "lucide-react";
import {
  MessageSquare,
  MousePointerClick,
  Wrench,
  CheckCheck,
  Ban,
  ListFilter,
  ListStart,
  ListOrdered,
  ShieldCheck,
  Braces,
  TextSearch,
  FileJson,
  MessageSquareText,
  Regex,
  Target,
  LayoutPanelTop,
  Type,
  Eye,
  EyeOff,
  FormInput,
  Timer,
  FileDigit,
  Coins,
  MessagesSquare,
  Gauge,
  MessageCircleQuestion,
  Repeat2,
  Archive,
  CircleAlert,
  ListEnd,
} from "lucide-react";
import {
  isTurnScopablePredicateKind,
  isObservationPredicateKind,
} from "@mcpjam/sdk/predicates";
import {
  PREDICATE_KIND_LABELS,
  type PredicateKind,
} from "@/shared/predicate-kinds";
import { WIDGET_ASSERTION_LABELS, type WidgetAssertion } from "@/shared/steps";
import {
  LIBRARY_CATEGORY_ORDER,
  SCORER_LIBRARY_CATEGORY_LABELS,
  libraryCategoryOfKind,
  type ScorerLibraryCategoryId,
} from "./suite-scorer-table-model";

/**
 * Sections of the Add drawer, in chain order.
 *
 * Every assertion files under the stage its evidence is reported at
 * (`ASSERTION_STAGE`, via `libraryCategoryOfKind`), so the heading a reader
 * picks it from is the heading its result appears under on the run page.
 * Budgets are the one presentation group the contract carries. Actions are
 * steps, not evaluators, and keep their own section.
 */
export type AddSection =
  | "Actions"
  | `Assertions · ${(typeof SCORER_LIBRARY_CATEGORY_LABELS)[ScorerLibraryCategoryId]}`;

const ASSERTION_SECTIONS: Record<ScorerLibraryCategoryId, AddSection> =
  Object.fromEntries(
    LIBRARY_CATEGORY_ORDER.map((id) => [
      id,
      `Assertions · ${SCORER_LIBRARY_CATEGORY_LABELS[id]}` as const,
    ]),
  ) as Record<ScorerLibraryCategoryId, AddSection>;
export const ADD_SECTIONS: readonly AddSection[] = [
  "Actions",
  ...LIBRARY_CATEGORY_ORDER.map((id) => ASSERTION_SECTIONS[id]),
];
export type EvalAddChoice =
  | { kind: "step"; stepKind: "prompt" | "interact" | "toolCall" }
  | { kind: "check"; predicateKind: PredicateKind }
  | { kind: "widget-check"; widgetKind: WidgetAssertion["kind"] }
  | { kind: "outcome" };
export type EvalAddEntry = {
  key: string;
  label: string;
  section: AddSection;
  Icon: LucideIcon;
  scope: "inline" | "whole-run" | "outcome";
  advisory: boolean;
  choice: EvalAddChoice;
};
const predicateIcons: Record<PredicateKind, LucideIcon> = {
  toolDescriptionsPresent: FileJson,
  toolAnnotationsPresent: FileJson,
  toolNamesUnique: FileJson,
  toolInputSchemasWellFormed: FileJson,
  toolOutputSchemasPresent: FileJson,
  noDeprecatedToolExposed: Archive,
  toolCalledWith: Wrench,
  toolCalledAtLeastOnce: CheckCheck,
  toolNeverCalled: Ban,
  onlyToolsCalled: ListFilter,
  firstToolWas: ListStart,
  toolCalledBefore: ListOrdered,
  noDestructiveToolCalled: ShieldCheck,
  argumentsMatchToolSchema: Braces,
  noToolErrors: ShieldCheck,
  toolResultContains: TextSearch,
  toolResultMatchesSchema: FileJson,
  responseContains: MessageSquareText,
  responseCloseTo: MessageSquareText,
  responseMatches: Regex,
  finalAssistantMessageNonEmpty: CheckCheck,
  widgetRendered: LayoutPanelTop,
  widgetNoConsoleErrors: ShieldCheck,
  toolLatencyUnder: Timer,
  widgetRenderLatencyUnder: Timer,
  toolResultSizeUnder: FileDigit,
  tokenBudgetUnder: Coins,
  turnCountUnder: MessagesSquare,
  toolCallCountUnder: Gauge,
  noEndingQuestion: MessageCircleQuestion,
  noRepeatedIdenticalCall: Repeat2,
  noDeprecatedToolCalled: Archive,
  toolErrorNamesInput: CircleAlert,
  fullPageHasContinuation: ListEnd,
};
const widgetIcons: Record<WidgetAssertion["kind"], LucideIcon> = {
  textVisible: Type,
  elementVisible: Eye,
  elementHidden: EyeOff,
  inputValue: FormInput,
  widgetToolCalled: MousePointerClick,
};
export const EVAL_ADD_CATALOG: EvalAddEntry[] = [
  ...(
    [
      ["prompt", "Prompt", MessageSquare],
      ["interact", "Interact", MousePointerClick],
      ["toolCall", "Call tool", Wrench],
    ] as const
  ).map(
    ([stepKind, label, Icon]): EvalAddEntry => ({
      key: stepKind,
      label,
      Icon,
      section: "Actions",
      scope: "inline",
      advisory: false,
      choice: { kind: "step", stepKind },
    }),
  ),
  ...(Object.keys(PREDICATE_KIND_LABELS) as PredicateKind[]).map(
    (predicateKind): EvalAddEntry => ({
      key: `check:${predicateKind}`,
      label: PREDICATE_KIND_LABELS[predicateKind],
      section: ASSERTION_SECTIONS[libraryCategoryOfKind(predicateKind)],
      Icon: predicateIcons[predicateKind],
      scope: isTurnScopablePredicateKind(predicateKind)
        ? "inline"
        : "whole-run",
      advisory: isObservationPredicateKind(predicateKind),
      choice: { kind: "check", predicateKind },
    }),
  ),
  ...(Object.keys(WIDGET_ASSERTION_LABELS) as WidgetAssertion["kind"][]).map(
    (widgetKind): EvalAddEntry => ({
      key: `widget:${widgetKind}`,
      label: WIDGET_ASSERTION_LABELS[widgetKind],
      section: ASSERTION_SECTIONS.userValue,
      Icon: widgetIcons[widgetKind],
      scope: "inline",
      advisory: false,
      choice: { kind: "widget-check", widgetKind },
    }),
  ),
  {
    key: "outcome",
    label: "Expected outcome / goal completion",
    section: ASSERTION_SECTIONS.userValue,
    Icon: Target,
    scope: "outcome",
    advisory: false,
    choice: { kind: "outcome" },
  },
];
