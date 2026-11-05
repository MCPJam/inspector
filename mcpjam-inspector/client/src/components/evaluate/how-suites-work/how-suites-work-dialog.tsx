import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import possumUrl from "@/assets/evals/possum.svg";
import { cn } from "@/lib/utils";
import { trackEvalNav } from "../nav/evaluate-nav-events";
import {
  clampStep,
  HOW_SUITES_WORK_LAST_STEP,
  HOW_SUITES_WORK_LAYERS,
  HOW_SUITES_WORK_STEPS,
  type HowSuitesWorkTrigger,
} from "./how-suites-work-model";

interface HowSuitesWorkDialogProps {
  /** Opens the dialog when set; comes from `useHowSuitesWork().trigger`. */
  trigger: HowSuitesWorkTrigger | null;
  onClose: () => void;
}

/**
 * Six-step dialog that walks Suite → Suite run → Test run → Iteration.
 * Reports `step` 1-based in analytics.
 */
export function HowSuitesWorkDialog({
  trigger,
  onClose,
}: HowSuitesWorkDialogProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!trigger) return;
    setStep(0);
    trackEvalNav("eval_tutorial_shown", { trigger, step: 1 });
  }, [trigger]);

  if (!trigger) return null;

  const current = HOW_SUITES_WORK_STEPS[step];
  const isLast = step === HOW_SUITES_WORK_LAST_STEP;
  const go = (next: number) => setStep(clampStep(next));

  const finish = () => {
    trackEvalNav(
      isLast ? "eval_tutorial_completed" : "eval_tutorial_dismissed",
      {
        trigger,
        step: step + 1,
      },
    );
    setStep(0);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") go(step + 1);
    if (event.key === "ArrowLeft") go(step - 1);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && finish()}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onKeyDown={onKeyDown}
        data-testid="how-suites-work"
      >
        <nav
          aria-label="Layers"
          className="flex flex-wrap items-center gap-1 border-b border-border px-6 pt-6 pb-4 pr-12"
        >
          {HOW_SUITES_WORK_LAYERS.map((layer, index) => {
            const target = HOW_SUITES_WORK_STEPS.findIndex(
              (s) => s.focus === layer.key,
            );
            return (
              <span key={layer.key} className="flex items-center gap-1">
                {index > 0 && (
                  <span aria-hidden="true" className="text-muted-foreground">
                    ›
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => go(target)}
                  aria-current={step === target ? "step" : undefined}
                  className={cn(
                    "rounded-md px-2 py-1 text-sm",
                    step === target
                      ? "bg-primary/10 font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {layer.label}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="grid min-h-[22rem] md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <LayerDiagram focusIndex={layerIndex(current.focus)} />
          <div className="flex flex-col justify-center gap-4 p-6">
            <img
              src={possumUrl}
              alt=""
              className="h-auto w-36 shrink-0"
              data-testid="how-suites-work-possum"
            />
            <div>
              <DialogTitle className="text-2xl">{current.title}</DialogTitle>
              <DialogDescription className="mt-2 text-base" aria-live="polite">
                {current.say}
              </DialogDescription>
            </div>
            {current.page && (
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {current.page.name}
                </span>
                <p className="text-xs text-muted-foreground">
                  {current.page.trail.join(" / ")}
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="items-center border-t border-border px-6 py-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Step {step + 1} of {HOW_SUITES_WORK_STEPS.length}
          </span>
          <div className="flex gap-2">
            {!isLast && (
              <Button variant="ghost" size="sm" onClick={finish}>
                Skip
              </Button>
            )}
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => go(step - 1)}>
                Back
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={finish}>
                Got it
              </Button>
            ) : (
              <Button size="sm" autoFocus onClick={() => go(step + 1)}>
                {step === 0 ? "Walk me through it" : "Next"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function layerIndex(focus: (typeof HOW_SUITES_WORK_STEPS)[number]["focus"]) {
  return HOW_SUITES_WORK_LAYERS.findIndex((layer) => layer.key === focus);
}

/** Nested boxes, one per layer; the focused layer is highlighted. */
function LayerDiagram({ focusIndex }: { focusIndex: number }) {
  const render = (index: number): ReactNode => {
    const layer = HOW_SUITES_WORK_LAYERS[index];
    if (!layer) return null;
    const lit = index === focusIndex;
    return (
      <div
        data-layer={layer.key}
        data-focused={lit || undefined}
        className={cn(
          "rounded-lg border p-3",
          lit ? "border-primary bg-primary/10" : "border-border bg-card",
        )}
      >
        <span
          className={cn(
            "text-xs font-medium",
            lit ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {layer.label}
        </span>
        {index + 1 < HOW_SUITES_WORK_LAYERS.length && (
          <div className="mt-2">{render(index + 1)}</div>
        )}
      </div>
    );
  };
  return (
    <div aria-hidden="true" className="flex items-center bg-muted/40 p-6">
      <div className="w-full">{render(0)}</div>
    </div>
  );
}
