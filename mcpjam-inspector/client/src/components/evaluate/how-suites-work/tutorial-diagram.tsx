import { FileText, FolderOpen, Play } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import {
  TUTORIAL_COPY,
  TUTORIAL_SAMPLE,
  type TutorialStep,
} from "./how-suites-work-copy";
import type { TutorialEase } from "./tutorial-motion";

/**
 * Suite ⊃ suite run ⊃ test runs ⊃ iterations, drawn to the step's depth with
 * the step's layer outlined. Decorative: the text column says the same thing.
 */
export function TutorialDiagram({
  step,
  ease,
}: {
  step: TutorialStep;
  ease: TutorialEase;
}) {
  const { depth, focus } = step;
  const lit = (layer: TutorialStep["focus"]) =>
    focus === layer ? "border-primary ring-2 ring-primary/30" : "border-border";
  const rows = TUTORIAL_SAMPLE.testRuns;

  return (
    <div className="w-full" aria-hidden="true" data-testid="tutorial-diagram">
      <div
        className={cn(
          "rounded-2xl border-2 bg-card p-4 transition-shadow",
          lit("suite"),
        )}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FolderOpen className="size-4 text-primary" />
          {TUTORIAL_SAMPLE.suite}
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {TUTORIAL_COPY.suiteTag}
          </span>
        </div>
        <div className="relative mt-3 min-h-[230px]">
          <ul
            className="absolute inset-0 flex flex-col justify-center gap-2"
            style={{
              opacity: depth === 1 ? 1 : 0,
              transition: ease(["opacity"]),
            }}
          >
            {rows.map((row) => (
              <li
                key={row.name}
                className="flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground"
              >
                <FileText className="size-3.5" />
                {row.name}
              </li>
            ))}
          </ul>
          {[2, 1].map((back) => (
            <div
              key={back}
              className="absolute inset-x-0 top-0 h-full rounded-xl border border-border bg-muted/40"
              style={{
                opacity: depth >= 2 ? 0.6 : 0,
                transform: `translate(${back * 8}px, ${-back * 8}px)`,
                transition: ease(["opacity", "transform"], 60 * back),
              }}
            />
          ))}
          <div
            className={cn(
              "relative rounded-xl border bg-background p-3",
              lit("run"),
            )}
            style={{
              opacity: depth >= 2 ? 1 : 0,
              transform: depth >= 2 ? "none" : "translateX(32px)",
              transition: ease(["opacity", "transform"]),
            }}
          >
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Play className="size-3.5 text-primary" />
              {TUTORIAL_SAMPLE.run}
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {TUTORIAL_COPY.runTag}
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {rows.map((row, i) => (
                <li
                  key={row.name}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    lit("testRun"),
                  )}
                  style={{
                    opacity: depth >= 3 ? 1 : 0,
                    transform: depth >= 3 ? "none" : "translateY(8px)",
                    transition: ease(["opacity", "transform"], 80 * i),
                  }}
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
                    {[...row.iterations].map((result, j) => (
                      <span
                        key={j}
                        className={cn(
                          "size-2.5 rounded-full",
                          result === "P" ? "bg-success" : "bg-destructive",
                        )}
                        style={{
                          opacity: depth >= 4 ? 1 : 0,
                          transform: depth >= 4 ? "scale(1)" : "scale(0.2)",
                          transition: ease(
                            ["opacity", "transform"],
                            120 + 60 * j + 40 * i,
                          ),
                        }}
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
