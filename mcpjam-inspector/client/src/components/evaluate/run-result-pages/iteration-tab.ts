import { ITERATION_TABS, type IterationTab } from "@/lib/eval-route-types";
import type { IterationReportMode } from "../../evals/iteration-details";

/** Links name tabs as users see them; `IterationDetails` names its views. */
const MODE_BY_TAB: Record<IterationTab, IterationReportMode> = {
  scorecard: "scorecard",
  steps: "steps",
  chat: "chat",
  tools: "tools",
  trace: "timeline",
  replay: "browser",
  raw: "raw",
};

export function modeForTab(
  tab: IterationTab | undefined,
): IterationReportMode | undefined {
  return tab ? MODE_BY_TAB[tab] : undefined;
}

export function tabForMode(mode: IterationReportMode): IterationTab {
  return ITERATION_TABS.find((tab) => MODE_BY_TAB[tab] === mode) ?? "chat";
}
