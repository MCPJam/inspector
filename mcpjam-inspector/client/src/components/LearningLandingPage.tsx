import { ChevronRight, Clock } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
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
        className={`w-5 shrink-0 text-xs tabular-nums ${completed ? "text-muted-foreground/60" : "text-muted-foreground"}`}
      >
        {number}.
      </span>
      <span
        className={`flex-1 text-sm ${completed ? "text-muted-foreground/60" : "text-foreground"}`}
      >
        {concept.title}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70">
        <Clock className="h-3 w-3" />~{concept.estimatedMinutes} min
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function GroupSection({
  group,
  groupIndex,
  isCompleted,
  onSelect,
  onToggleComplete,
}: {
  group: LearningGroup;
  groupIndex: number;
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
    <div className="mb-4">
      {/* Group header */}
      <div className="flex items-baseline justify-between px-3 pb-1.5 pt-2">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {group.title}
          </h3>
          <p className="text-[11px] text-muted-foreground">{group.subtitle}</p>
        </div>
        <span
          className={`text-[11px] font-medium tabular-nums ${allDone ? "text-primary" : "text-muted-foreground"}`}
        >
          {completedInGroup}/{total}
          {allDone && " \u2713"}
        </span>
      </div>

      {/* Module rows */}
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
    </div>
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
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Learning</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Master MCP from fundamentals to advanced topics
        </p>

        {/* Overall progress */}
        <div className="mt-3 flex items-center gap-3">
          <Progress value={progressPercent} className="h-1.5 flex-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {completionCount} of {TOTAL_MODULES} completed
          </span>
        </div>
      </div>

      {/* Grouped checklist */}
      <div className="flex-1 overflow-auto p-2">
        {LEARNING_GROUPS.map((group: LearningGroup, gi: number) => (
          <GroupSection
            key={group.title}
            group={group}
            groupIndex={gi}
            isCompleted={isCompleted}
            onSelect={onSelect}
            onToggleComplete={onToggleComplete}
          />
        ))}
      </div>
    </div>
  );
}
