import { ChevronDown, ChevronRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  LEARNING_GROUPS,
  type LearningGroup,
  type LearningConcept,
} from "@/components/lifecycle/learning-concepts";

interface LearningLandingPageProps {
  onSelect: (conceptId: string) => void;
  isCompleted: (id: string) => boolean;
  onToggleComplete: (id: string) => void;
  completionCount: number;
}

const TOTAL_MODULES = LEARNING_GROUPS.reduce(
  (sum: number, g: LearningGroup) => sum + g.modules.length,
  0,
);

const TOTAL_TRACKS = LEARNING_GROUPS.length;

const TOTAL_ESTIMATED_MINUTES = LEARNING_GROUPS.reduce(
  (sum, g: LearningGroup) =>
    sum + g.modules.reduce((s, m) => s + m.estimatedMinutes, 0),
  0,
);

const FIRST_GROUP = LEARNING_GROUPS[0];
const FIRST_LESSON = FIRST_GROUP.modules[0];

/** Keeps syllabus readable on ultrawide / full-screen layouts */
const LEARNING_LANDING_MAX =
  "mx-auto w-full max-w-2xl px-4 sm:max-w-3xl sm:px-6";

/** Running module number across all groups */
function getModuleNumber(groupIndex: number, moduleIndex: number): number {
  let n = moduleIndex + 1;
  for (let i = 0; i < groupIndex; i++) {
    n += LEARNING_GROUPS[i].modules.length;
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
  concept: LearningConcept;
  number: number;
  completed: boolean;
  onSelect: (id: string) => void;
  onToggleComplete: (id: string) => void;
}) {
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
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70">
        <Clock className="h-3 w-3" />~{concept.estimatedMinutes} min
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function GroupSection({
  group,
  groupIndex,
  defaultOpen,
  isCompleted,
  onSelect,
  onToggleComplete,
}: {
  group: LearningGroup;
  groupIndex: number;
  defaultOpen?: boolean;
  isCompleted: (id: string) => boolean;
  onSelect: (id: string) => void;
  onToggleComplete: (id: string) => void;
}) {
  const completedInGroup = group.modules.filter((m: LearningConcept) =>
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
          {group.modules.map((concept: LearningConcept, mi: number) => (
            <ModuleRow
              key={concept.id}
              concept={concept}
              number={getModuleNumber(groupIndex, mi)}
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
  const progressPercent = Math.round((completionCount / TOTAL_MODULES) * 100);

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
            {TOTAL_TRACKS} tracks · {TOTAL_MODULES} lessons · ~
            {TOTAL_ESTIMATED_MINUTES} min total
          </p>

          {/* Overall progress */}
          <div className="mt-3 flex items-center gap-3">
            <Progress value={progressPercent} className="h-1.5 flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {completionCount} of {TOTAL_MODULES} completed
            </span>
          </div>
          {completionCount === 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="m-0 w-fit max-w-full text-xs leading-relaxed text-muted-foreground">
                New here? Start with{" "}
                <span className="font-medium text-foreground/90">
                  {FIRST_GROUP.title}
                </span>{" "}
                and open the first lesson below.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => onSelect(FIRST_LESSON.id)}
              >
                Open “{FIRST_LESSON.title}”
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Grouped checklist */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={`pb-10 pt-2 ${LEARNING_LANDING_MAX}`}>
          {LEARNING_GROUPS.map((group: LearningGroup, gi: number) => (
            <GroupSection
              key={group.title}
              group={group}
              groupIndex={gi}
              defaultOpen={completionCount === 0 && gi === 0}
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
