import { Fragment } from "react";
import {
  ChevronRight,
  FolderOpen,
  ListChecks,
  Play,
  Repeat,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HOW_SUITES_WORK_LAYERS,
  HOW_SUITES_WORK_STEPS,
  stepOfLayer,
  stepTransition,
  type HowSuitesWorkLayer,
} from "./how-suites-work-steps";

const LAYER_ICONS: Record<HowSuitesWorkLayer, LucideIcon> = {
  suite: FolderOpen,
  run: Play,
  testRun: ListChecks,
  iteration: Repeat,
};

/**
 * The four layers as one chain. The focused layer is filled, the ones after
 * it are dimmed, and each chip jumps to its step.
 */
export function Spine({
  step,
  onJump,
  reducedMotion,
}: {
  step: number;
  onJump: (step: number) => void;
  reducedMotion: boolean;
}) {
  const focus = HOW_SUITES_WORK_STEPS[step].focus;
  const focusIndex = HOW_SUITES_WORK_LAYERS.findIndex(
    (layer) => layer.key === focus,
  );
  const reached = (i: number) => focus === null || i <= focusIndex;

  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="The flow">
      {HOW_SUITES_WORK_LAYERS.map((layer, i) => {
        const Icon = LAYER_ICONS[layer.key];
        const current = focus === layer.key;
        return (
          <Fragment key={layer.key}>
            {i > 0 ? (
              <li
                aria-hidden="true"
                className="text-muted-foreground"
                style={{
                  opacity: reached(i) ? 1 : 0.35,
                  transition: stepTransition(
                    ["opacity"],
                    reducedMotion,
                    80 * i,
                  ),
                }}
              >
                <ChevronRight className="size-4" />
              </li>
            ) : null}
            <li
              style={{
                opacity: reached(i) ? 1 : 0.4,
                transform: reached(i) ? "none" : "translateY(2px)",
                transition: stepTransition(
                  ["opacity", "transform"],
                  reducedMotion,
                  80 * i,
                ),
              }}
            >
              <button
                type="button"
                onClick={() => onJump(stepOfLayer(layer.key))}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                  current
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:bg-muted",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {layer.label}
              </button>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
