import { Fragment } from "react";
import { FileText, FolderOpen, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  stepTransition,
  type HowSuitesWorkLayer,
  type HowSuitesWorkStep,
} from "./how-suites-work-steps";

/** Fixed sample data. The tutorial never reads the user's own suites. */
const SAMPLE_ROWS = [
  { name: "Draw a rectangle", dots: "PPFP" },
  { name: "Sketch a two-node flow", dots: "PPPP" },
  { name: "Draw and share a diagram", dots: "FFPF" },
] as const;

/**
 * The nested picture: suite ⊃ run ⊃ test runs ⊃ iteration dots, drawn to
 * `show` depth with the `focus` layer lit. Decorative; the step text carries
 * the meaning.
 */
export function Diagram({
  show,
  focus,
  reducedMotion,
}: {
  show: HowSuitesWorkStep["show"];
  focus: HowSuitesWorkLayer | null;
  reducedMotion: boolean;
}) {
  const lit = (layer: HowSuitesWorkLayer) =>
    focus === layer ? "border-primary ring-2 ring-primary/30" : "border-border";
  const ease = (properties: readonly string[], delayMs = 0) =>
    stepTransition(properties, reducedMotion, delayMs);

  return (
    <div className="w-full" aria-hidden="true">
      <div
        className={cn(
          "rounded-2xl border-2 bg-card p-4 transition-shadow",
          lit("suite"),
        )}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FolderOpen className="size-4 text-primary" /> Excalidraw quickstart
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            Suite
          </span>
        </div>
        <div className="relative mt-3" style={{ minHeight: 230 }}>
          <ul
            className="absolute inset-0 flex flex-col justify-center gap-2"
            style={{
              opacity: show === 1 ? 1 : 0,
              transition: ease(["opacity"]),
            }}
          >
            {SAMPLE_ROWS.map((row) => (
              <li
                key={row.name}
                className="w-fit rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground"
              >
                <FileText
                  className="mr-1.5 inline size-3.5"
                  style={{ verticalAlign: -2 }}
                />
                {row.name}
              </li>
            ))}
          </ul>
          {[2, 1].map((back) => (
            <div
              key={back}
              className="absolute inset-x-0 top-0 h-full rounded-xl border border-border bg-muted/40"
              style={{
                opacity: show >= 2 ? 0.6 : 0,
                transform: `translate(${back * 8}px, ${-back * 8}px)`,
                transition: ease(["opacity", "transform"], 60 * back),
              }}
            />
          ))}
          <div
            data-testid="how-suites-work-run-card"
            className={cn(
              "relative rounded-xl border bg-background p-3",
              lit("run"),
            )}
            style={{
              opacity: show >= 2 ? 1 : 0,
              transform: show >= 2 ? "none" : "translateX(32px)",
              transition: ease(["opacity", "transform"]),
            }}
          >
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Play className="size-3.5 text-primary" /> Run #6
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                Suite run
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {SAMPLE_ROWS.map((row, i) => (
                <li
                  key={row.name}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    lit("testRun"),
                  )}
                  style={{
                    opacity: show >= 3 ? 1 : 0,
                    transform: show >= 3 ? "none" : "translateY(8px)",
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
                    {[...row.dots].map((dot, j) => (
                      <span
                        key={j}
                        className={cn(
                          "size-2.5 rounded-full",
                          dot === "P" ? "bg-success" : "bg-destructive",
                        )}
                        style={{
                          opacity: show >= 4 ? 1 : 0,
                          transform: show >= 4 ? "scale(1)" : "scale(0.2)",
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

/** Where the layer's page sits; the last item is the page itself. */
export function Trail({ items }: { items: readonly string[] }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      aria-label="Where you'll see it"
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
