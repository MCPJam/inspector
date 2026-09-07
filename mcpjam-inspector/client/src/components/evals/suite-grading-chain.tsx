import {
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGES,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { Tabs, TabsList, TabsTrigger } from "@mcpjam/design-system/tabs";
import { cn } from "@/lib/utils";
import type { StageConfigState } from "./suite-grading-model";

function gateLabel(count: number): string {
  return count === 1 ? "1 gate" : `${count} gates`;
}

function judgeSubLabel(mode: NonNullable<StageConfigState["judge"]>): string {
  switch (mode) {
    case "off":
      return "judge off";
    case "manual":
      return "judge on request";
    case "automatic":
      return "judge, advisory";
    case "gating":
      return "judge gates";
  }
}

function subLabel(state: StageConfigState): string {
  if (state.stage === "userValue") {
    if (state.gates >= 1 && state.judge && state.judge !== "gating") {
      return `${gateLabel(state.gates)} · ${judgeSubLabel(state.judge)}`;
    }
    if (state.state === "gated") {
      return state.gates >= 1 ? gateLabel(state.gates) : "judge gates";
    }
  }
  switch (state.state) {
    case "runner":
      return "runner";
    case "gated":
      return gateLabel(state.gates);
    case "gap":
      return "no grader";
    case "judgeOnRequest":
      return "judge on request";
    case "judgeAutomatic":
      return "judge, advisory";
    case "judgeOff":
      return "judge off";
  }
}

function markClass(state: StageConfigState): string {
  switch (state.state) {
    case "gated":
      return "bg-foreground";
    case "judgeAutomatic":
      return "border-2 border-foreground bg-transparent";
    case "judgeOnRequest":
      return "border-2 border-dotted border-foreground bg-transparent";
    case "runner":
      return "border border-muted-foreground/50 bg-transparent";
    case "gap":
    case "judgeOff":
      return "border border-dashed border-muted-foreground/50 bg-transparent";
  }
}

/**
 * The six links of the user-value chain, each carrying its CONFIG state, as
 * one segmented tab strip from the design system.
 *
 * The strip is the navigation between stage groups: `activeStage` is the
 * selected tab and `onSelectStage` receives a click. Without a selector the
 * strip still shows every link's state and selecting does nothing — the
 * reader gets the whole chain either way.
 */
export function SuiteGradingChain({
  states,
  activeStage,
  onSelectStage,
}: {
  states: StageConfigState[];
  activeStage?: UserValueStage;
  onSelectStage?: (stage: UserValueStage) => void;
}) {
  const ordered = USER_VALUE_STAGES.map((stage) =>
    states.find((candidate) => candidate.stage === stage)!,
  );
  return (
    <Tabs
      value={activeStage ?? ""}
      onValueChange={(value) => onSelectStage?.(value as UserValueStage)}
      className="gap-0"
    >
      <TabsList
        aria-label="User value chain"
        className="h-auto w-full flex-wrap items-stretch justify-start gap-0.5 sm:w-fit"
      >
        {ordered.map((state) => (
          <TabsTrigger
            key={state.stage}
            value={state.stage}
            data-stage-state={state.state}
            className="h-auto flex-none flex-col items-start gap-0 px-2.5 py-1.5 text-left"
          >
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  markClass(state),
                )}
              />
              <span className="text-xs font-medium" data-stage-label>
                {USER_VALUE_STAGE_LABELS[state.stage]}
              </span>
            </span>
            <span className="pl-3 text-[11px] font-normal text-muted-foreground">
              {subLabel(state)}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
