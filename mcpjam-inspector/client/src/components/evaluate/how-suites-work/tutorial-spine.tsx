import { Fragment } from "react";
import {
  ChevronRight,
  FolderOpen,
  ListChecks,
  Play,
  Repeat,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import {
  TUTORIAL_COPY,
  TUTORIAL_LAYERS,
  TUTORIAL_STEPS,
  stepOfLayer,
  type TutorialLayerIcon,
} from "./how-suites-work-copy";
import type { TutorialEase } from "./tutorial-motion";

const LAYER_ICONS: Record<TutorialLayerIcon, LucideIcon> = {
  FolderOpen,
  Play,
  ListChecks,
  Repeat,
};

/**
 * The four layers as one chain. The current layer is filled, later layers
 * fade, and each pill jumps to its step.
 */
export function TutorialSpine({
  step,
  onJump,
  ease,
}: {
  step: number;
  onJump: (step: number) => void;
  ease: TutorialEase;
}) {
  const focus = TUTORIAL_STEPS[step].focus;
  const current = TUTORIAL_LAYERS.findIndex((layer) => layer.key === focus);
  const reached = (i: number) => focus === null || i <= current;

  return (
    <ol
      className="flex flex-wrap items-center gap-1.5"
      aria-label={TUTORIAL_COPY.spineLabel}
    >
      {TUTORIAL_LAYERS.map((layer, i) => {
        const Icon = LAYER_ICONS[layer.icon];
        const on = layer.key === focus;
        return (
          <Fragment key={layer.key}>
            {i > 0 ? (
              <li
                aria-hidden="true"
                className="text-muted-foreground"
                style={{
                  opacity: reached(i) ? 1 : 0.35,
                  transition: ease(["opacity"], 80 * i),
                }}
              >
                <ChevronRight className="size-4" />
              </li>
            ) : null}
            <li
              style={{
                opacity: reached(i) ? 1 : 0.4,
                transform: reached(i) ? "none" : "translateY(2px)",
                transition: ease(["opacity", "transform"], 80 * i),
              }}
            >
              <button
                type="button"
                onClick={() => onJump(stepOfLayer(layer.key))}
                aria-current={on ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                  on
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

/** Where the step's layer appears in the product, last item highlighted. */
export function TutorialTrail({ items }: { items: readonly string[] }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      aria-label={TUTORIAL_COPY.trailLabel}
    >
      {items.map((item, i) => (
        <Fragment key={item}>
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          <span
            className={cn(
              "rounded px-1.5 py-0.5",
              i === items.length - 1 &&
                "bg-primary/10 font-medium text-foreground",
            )}
          >
            {item}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
