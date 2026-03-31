import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type PlaygroundSurface = "explore" | "runs";

/**
 * Playground-only control: switch between authoring/running cases (Explore)
 * and the run drill-down surface (Runs). CI evals do not use this pattern yet.
 */
export function PlaygroundSurfaceToggle({
  value,
  onExplore,
  onRuns,
}: {
  value: PlaygroundSurface;
  onExplore: () => void;
  onRuns: () => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      variant="outline"
      size="sm"
      className="min-w-0 w-full max-w-[min(100%,280px)] shrink-0"
      onValueChange={(next) => {
        if (!next || next === value) return;
        if (next === "explore") onExplore();
        else onRuns();
      }}
    >
      <ToggleGroupItem
        value="explore"
        className="flex-1 px-2.5 text-xs sm:px-3 sm:text-sm"
        aria-label="Explore — edit cases, models, and run prompts"
      >
        Explore
      </ToggleGroupItem>
      <ToggleGroupItem
        value="runs"
        className="flex-1 px-2.5 text-xs sm:px-3 sm:text-sm"
        aria-label="Runs — pass rates, charts, and per-case traces"
      >
        Runs
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
