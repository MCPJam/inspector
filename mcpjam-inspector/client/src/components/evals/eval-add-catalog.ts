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

export const ADD_SECTIONS = [
  "Actions",
  "Assertions · Tool selection",
  "Assertions · Tool inputs and results",
  "Assertions · Answer and outcome",
  "Assertions · View",
  "Limits · Time and usage",
  "Observations · Advisory assertions",
] as const;
export type AddSection = (typeof ADD_SECTIONS)[number];
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
const predicateMeta: Record<PredicateKind, [AddSection, LucideIcon]> = {
  toolCalledWith: [ADD_SECTIONS[1], Wrench],
  toolCalledAtLeastOnce: [ADD_SECTIONS[1], CheckCheck],
  toolNeverCalled: [ADD_SECTIONS[1], Ban],
  onlyToolsCalled: [ADD_SECTIONS[1], ListFilter],
  firstToolWas: [ADD_SECTIONS[1], ListStart],
  toolCalledBefore: [ADD_SECTIONS[1], ListOrdered],
  noDestructiveToolCalled: [ADD_SECTIONS[1], ShieldCheck],
  argumentsMatchToolSchema: [ADD_SECTIONS[2], Braces],
  noToolErrors: [ADD_SECTIONS[2], ShieldCheck],
  toolResultContains: [ADD_SECTIONS[2], TextSearch],
  toolResultMatchesSchema: [ADD_SECTIONS[2], FileJson],
  responseContains: [ADD_SECTIONS[3], MessageSquareText],
  responseMatches: [ADD_SECTIONS[3], Regex],
  finalAssistantMessageNonEmpty: [ADD_SECTIONS[3], CheckCheck],
  widgetRendered: [ADD_SECTIONS[4], LayoutPanelTop],
  widgetNoConsoleErrors: [ADD_SECTIONS[4], ShieldCheck],
  toolLatencyUnder: [ADD_SECTIONS[5], Timer],
  widgetRenderLatencyUnder: [ADD_SECTIONS[5], Timer],
  toolResultSizeUnder: [ADD_SECTIONS[5], FileDigit],
  tokenBudgetUnder: [ADD_SECTIONS[5], Coins],
  turnCountUnder: [ADD_SECTIONS[5], MessagesSquare],
  toolCallCountUnder: [ADD_SECTIONS[5], Gauge],
  noEndingQuestion: [ADD_SECTIONS[6], MessageCircleQuestion],
  noRepeatedIdenticalCall: [ADD_SECTIONS[6], Repeat2],
  noDeprecatedToolCalled: [ADD_SECTIONS[6], Archive],
  toolErrorNamesInput: [ADD_SECTIONS[6], CircleAlert],
  fullPageHasContinuation: [ADD_SECTIONS[6], ListEnd],
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
  ).map(([stepKind, label, Icon]): EvalAddEntry => ({
    key: stepKind,
    label,
    Icon,
    section: "Actions",
    scope: "inline",
    advisory: false,
    choice: { kind: "step", stepKind },
  })),
  ...(Object.keys(PREDICATE_KIND_LABELS) as PredicateKind[]).map(
    (predicateKind): EvalAddEntry => ({
      key: `check:${predicateKind}`,
      label: PREDICATE_KIND_LABELS[predicateKind],
      section: predicateMeta[predicateKind][0],
      Icon: predicateMeta[predicateKind][1],
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
      section: ADD_SECTIONS[4],
      Icon: widgetIcons[widgetKind],
      scope: "inline",
      advisory: false,
      choice: { kind: "widget-check", widgetKind },
    }),
  ),
  {
    key: "outcome",
    label: "Expected outcome / goal completion",
    section: ADD_SECTIONS[3],
    Icon: Target,
    scope: "outcome",
    advisory: false,
    choice: { kind: "outcome" },
  },
];
