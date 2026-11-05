import { Fragment } from "react";
import {
  ChevronRight,
  FileText,
  FlaskConical,
  FolderOpen,
  ListChecks,
  Play,
  Repeat,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import {
  HOW_SUITES_WORK_LAYERS,
  HOW_SUITES_WORK_STEPS,
  isLayerReached,
  stepOfLayer,
  type HowSuitesWorkLayer,
} from "./how-suites-work-model";

const LAYER_ICONS: Record<HowSuitesWorkLayer, LucideIcon> = {
  suite: FolderOpen,
  suiteRun: Play,
  testRun: ListChecks,
  iteration: Repeat,
};

const FADE = "motion-safe:transition-all motion-safe:duration-300 ease-out";

/** The four layers as one chain: the current one is lit and each one jumps to its step. */
export function LayerSpine({
  step,
  onJump,
}: {
  step: number;
  onJump: (step: number) => void;
}) {
  const focus = HOW_SUITES_WORK_STEPS[step]?.focus ?? null;
  return (
    <ol
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Eval layers"
    >
      {HOW_SUITES_WORK_LAYERS.map((layer, index) => {
        const Icon = LAYER_ICONS[layer.key];
        const current = focus === layer.key;
        const reached = isLayerReached(step, layer.key);
        return (
          <Fragment key={layer.key}>
            {index > 0 ? (
              <li
                aria-hidden="true"
                className={cn(
                  "text-muted-foreground",
                  FADE,
                  !reached && "opacity-40",
                )}
              >
                <ChevronRight className="size-4" />
              </li>
            ) : null}
            <li className={cn(FADE, !reached && "opacity-40")}>
              <button
                type="button"
                onClick={() => onJump(stepOfLayer(layer.key))}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                  current
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-card-foreground hover:bg-muted",
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

const SAMPLE_TEST_RUNS = [
  { name: "Draw a rectangle", iterations: [true, true, false, true] },
  { name: "Sketch a two-node flow", iterations: [true, true, true, true] },
  { name: "Draw and share a diagram", iterations: [false, false, true, false] },
];

/** A sample suite drawn as nested boxes, down to `depth` layers, with `focus` lit. */
export function LayerDiagram({
  depth,
  focus,
}: {
  depth: number;
  focus: HowSuitesWorkLayer | null;
}) {
  const lit = (layer: HowSuitesWorkLayer) =>
    focus === layer ? "border-primary ring-2 ring-primary/30" : "border-border";
  const shown = (minDepth: number) =>
    depth >= minDepth ? "opacity-100" : "pointer-events-none opacity-0";
  return (
    <div
      className="w-full"
      aria-hidden="true"
      data-testid="how-suites-work-diagram"
    >
      <div className={cn("rounded-2xl border-2 bg-card p-4", lit("suite"))}>
        <div className="flex items-center gap-2 text-sm font-semibold text-card-foreground">
          <FolderOpen className="size-4 text-primary" />
          Excalidraw quickstart
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            Suite
          </span>
        </div>
        <div className="relative mt-3 min-h-56">
          <ul
            className={cn(
              "absolute inset-0 flex flex-col justify-center gap-2",
              FADE,
              depth === 1 ? "opacity-100" : "opacity-0",
            )}
          >
            {SAMPLE_TEST_RUNS.map((row) => (
              <li
                key={row.name}
                className="flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground"
              >
                <FileText className="size-3.5" />
                {row.name}
              </li>
            ))}
          </ul>
          <div
            className={cn(
              "relative rounded-xl border bg-background p-3",
              lit("suiteRun"),
              FADE,
              shown(2),
            )}
          >
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Play className="size-3.5 text-primary" />
              Run #6
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                Suite run
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {SAMPLE_TEST_RUNS.map((row) => (
                <li
                  key={row.name}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    lit("testRun"),
                    FADE,
                    shown(3),
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {row.name}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-1.5 py-1",
                      focus === "iteration" && "ring-2 ring-primary/40",
                    )}
                  >
                    {row.iterations.map((passed, index) => (
                      <span
                        key={index}
                        className={cn(
                          "size-2.5 rounded-full",
                          passed ? "bg-success" : "bg-destructive",
                          FADE,
                          shown(4),
                        )}
                      />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A sample breadcrumb for the page where the current layer lives. */
export function SampleTrail({ items }: { items: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {items.map((item, index) => (
        <Fragment key={item}>
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          <span
            className={cn(
              "rounded px-1.5 py-0.5",
              index === items.length - 1 &&
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

/** Stand-in for the MCPJam possum until final mascot art exists. */
export function MascotPlaceholder() {
  return (
    <div
      aria-hidden="true"
      data-testid="how-suites-work-mascot"
      className="flex size-28 items-center justify-center rounded-full bg-primary/10"
    >
      <FlaskConical className="size-12 text-primary" />
    </div>
  );
}
