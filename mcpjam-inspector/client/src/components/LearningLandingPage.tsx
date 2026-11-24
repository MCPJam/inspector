import { ChevronDown, ChevronRight, Clock, Play } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Progress } from "@mcpjam/design-system/progress";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@mcpjam/design-system/collapsible";
import {
  LEARNING_GROUPS,
  isGuidedTour,
  type LearningGroup,
  type LearningModule,
} from "@/components/lifecycle/learning-concepts";
import { isPlatformAgentEnabled } from "@/lib/runtime-config";

interface LearningLandingPageProps {
  onSelect: (conceptId: string) => void;
  isCompleted: (id: string) => boolean;
  onToggleComplete: (id: string) => void;
  completionCount: number;
}

/**
 * The groups this page lists. A guided tour runs in the MCPJam agent's side
 * panel, which `MCPJAM_PLATFORM_AGENT=off` removes, so tours are left out then
 * rather than listed as rows that open nothing.
 */
function visibleGroups(): LearningGroup[] {
  if (isPlatformAgentEnabled()) return LEARNING_GROUPS;
  return LEARNING_GROUPS.map((group) => ({
    ...group,
    modules: group.modules.filter((m) => !isGuidedTour(m)),
  })).filter((group) => group.modules.length > 0);
}

/** Keeps syllabus readable on ultrawide / full-screen layouts */
const LEARNING_LANDING_MAX =
  "mx-auto w-full max-w-2xl px-4 sm:max-w-3xl sm:px-6";

/** The running number of a group's first module, across the listed groups */
function firstModuleNumber(
  groups: LearningGroup[],
  groupIndex: number,
): number {
  let n = 1;
  for (let i = 0; i < groupIndex; i++) {
    n += groups[i].modules.length;
  }
  return n;
}

function ModuleRow({
  concept,
  number,
  completed,
  onSelect,
  onToggleComplete,
}: {
  concept: LearningModule;
  number: number;
  completed: boolean;
  onSelect: (id: string) => void;
  onToggleComplete: (id: string) => void;
}) {
  const guided = isGuidedTour(concept);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/50 group"
      onClick={() => onSelect(concept.id)}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          onToggleComplete(concept.id);
        }}
        className="flex shrink-0 items-center"
      >
        <Checkbox checked={completed} />
      </div>
      <span
        className={`w-5 shrink-0 text-sm tabular-nums ${completed ? "text-muted-foreground/60" : "text-muted-foreground"}`}
      >
        {number}.
      </span>
      <span
        className={`flex-1 text-base ${completed ? "text-muted-foreground/60" : "text-foreground"}`}
      >
        {concept.title}
      </span>
      {guided ? (
        <Badge
          variant="outline"
          className="shrink-0 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Guided
        </Badge>
      ) : null}
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70">
        <Clock className="h-3 w-3" />~{concept.estimatedMinutes} min
      </span>
      {guided ? (
        <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      )}
    </button>
  );
}

function GroupSection({
  group,
  firstNumber,
  defaultOpen,
  isCompleted,
  onSelect,
  onToggleComplete,
}: {
  group: LearningGroup;
  firstNumber: number;
  defaultOpen?: boolean;
  isCompleted: (id: string) => boolean;
  onSelect: (id: string) => void;
  onToggleComplete: (id: string) => void;
}) {
  const completedInGroup = group.modules.filter((m: LearningModule) =>
    isCompleted(m.id),
  ).length;
  const total = group.modules.length;
  const allDone = completedInGroup === total;

  return (
    <Collapsible defaultOpen={defaultOpen ?? false} className="group mb-4">
      {/* Group header */}
      <CollapsibleTrigger className="flex w-full cursor-pointer items-baseline justify-between rounded-md px-3 pb-1.5 pt-2 hover:bg-muted/50">
        <div className="flex items-center gap-2">
          <ChevronDown
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90"
          />
          <div className="text-left">
            <h3 className="text-sm font-semibold text-foreground">
              {group.title}
            </h3>
            <p className="text-xs text-muted-foreground">{group.subtitle}</p>
          </div>
        </div>
        <span
          className={`text-xs font-medium tabular-nums ${allDone ? "text-primary" : "text-muted-foreground"}`}
        >
          {completedInGroup}/{total}
          {allDone && " \u2713"}
        </span>
      </CollapsibleTrigger>

      {/* Module rows */}
      <CollapsibleContent>
        <div className="flex flex-col">
          {group.modules.map((concept: LearningModule, mi: number) => (
            <ModuleRow
              key={concept.id}
              concept={concept}
              number={firstNumber + mi}
              completed={isCompleted(concept.id)}
              onSelect={onSelect}
              onToggleComplete={onToggleComplete}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function LearningLandingPage({
  onSelect,
  isCompleted,
  onToggleComplete,
  completionCount,
}: LearningLandingPageProps) {
  const groups = visibleGroups();
  const totalModules = groups.reduce((sum, g) => sum + g.modules.length, 0);
  const totalMinutes = groups.reduce(
    (sum, g) => sum + g.modules.reduce((s, m) => s + m.estimatedMinutes, 0),
    0,
  );
  const firstGroup = groups[0];
  const firstLesson = firstGroup.modules[0];
  // Tours finished before the agent was turned off stay in progress storage.
  const hiddenCompleted =
    groups === LEARNING_GROUPS
      ? 0
      : LEARNING_GROUPS.flatMap((g) => g.modules).filter(
          (m) => isGuidedTour(m) && isCompleted(m.id),
        ).length;
  const shownCompleted = completionCount - hiddenCompleted;
  const progressPercent = Math.round((shownCompleted / totalModules) * 100);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b">
        <div className={`py-3 ${LEARNING_LANDING_MAX}`}>
          <h2 className="text-base font-semibold">Learning</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Learn MCP step by step
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground/90">
            {groups.length} tracks · {totalModules} lessons · ~{totalMinutes}{" "}
            min total
          </p>

          {/* Overall progress */}
          <div className="mt-3 flex items-center gap-3">
            <Progress value={progressPercent} className="h-1.5 flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {shownCompleted} of {totalModules} completed
            </span>
          </div>
          {shownCompleted === 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="m-0 w-fit max-w-full text-xs leading-relaxed text-muted-foreground">
                New here? Start with{" "}
                <span className="font-medium text-foreground/90">
                  {firstGroup.title}
                </span>{" "}
                and open the first lesson below.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => onSelect(firstLesson.id)}
              >
                Open “{firstLesson.title}”
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Grouped checklist */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={`pb-10 pt-2 ${LEARNING_LANDING_MAX}`}>
          {groups.map((group: LearningGroup, gi: number) => (
            <GroupSection
              key={group.title}
              group={group}
              firstNumber={firstModuleNumber(groups, gi)}
              defaultOpen={shownCompleted === 0 && gi === 0}
              isCompleted={isCompleted}
              onSelect={onSelect}
              onToggleComplete={onToggleComplete}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
