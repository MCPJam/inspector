import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { Diagram, Trail } from "./how-suites-work-diagram";
import { Spine } from "./how-suites-work-spine";
import {
  HOW_SUITES_WORK_STEPS,
  prefersReducedMotion,
} from "./how-suites-work-steps";
import { Possum } from "./possum";
import type { HowSuitesWorkDialogProps } from "./use-how-suites-work";

const LAST_STEP = HOW_SUITES_WORK_STEPS.length - 1;
const ANALYTICS_LOCATION = "evaluate_tutorial";

/**
 * The "How suites work" tutorial: six steps that walk Suite, Suite run, Test
 * run and Iteration on a fixed sample diagram. Starts on step 1 every time it
 * opens and reports one shown event and one end event per open.
 */
export function HowSuitesWorkDialog({
  open,
  onOpenChange,
  trigger,
}: HowSuitesWorkDialogProps) {
  const [step, setStep] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setStep(0);
  }

  const primaryRef = useRef<HTMLButtonElement>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const trackedOpenRef = useRef(false);
  const completedRef = useRef(false);

  useEffect(() => {
    // The ref keeps StrictMode's repeated effect run from sending twice.
    if (open && !trackedOpenRef.current) {
      trackedOpenRef.current = true;
      completedRef.current = false;
      track("eval_tutorial_shown", {
        location: ANALYTICS_LOCATION,
        trigger,
        step: 1,
      });
    } else if (!open && trackedOpenRef.current) {
      trackedOpenRef.current = false;
      if (!completedRef.current) {
        track("eval_tutorial_dismissed", {
          location: ANALYTICS_LOCATION,
          trigger,
          step: stepRef.current + 1,
        });
      }
    }
  }, [open, trigger]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        setStep((current) => Math.min(LAST_STEP, current + 1));
      } else if (event.key === "ArrowLeft") {
        setStep((current) => Math.max(0, current - 1));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const finish = () => {
    completedRef.current = true;
    track("eval_tutorial_completed", {
      location: ANALYTICS_LOCATION,
      trigger,
      step: LAST_STEP + 1,
    });
    onOpenChange(false);
  };

  const current = HOW_SUITES_WORK_STEPS[step];
  const last = step === LAST_STEP;
  const reducedMotion = prefersReducedMotion();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 outline-none sm:max-w-5xl"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          primaryRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">How suites work</DialogTitle>
        <div
          data-testid="how-suites-work"
          className="flex max-h-[85vh] flex-col overflow-y-auto"
          style={{ minHeight: "min(620px, 85vh)" }}
        >
          <div className="border-b border-border px-6 pb-4 pt-6 pr-12">
            <Spine step={step} onJump={setStep} reducedMotion={reducedMotion} />
          </div>
          <div className="grid flex-auto shrink-0 grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="flex items-center bg-muted/40 p-6">
              <Diagram
                show={current.show}
                focus={current.focus}
                reducedMotion={reducedMotion}
              />
            </div>
            <div className="flex flex-col justify-center gap-5 p-6">
              <Possum size={168} />
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {current.title}
                </h2>
                <p
                  className="mt-2 text-lg leading-snug text-muted-foreground"
                  aria-live="polite"
                >
                  {current.say}
                </p>
              </div>
              {current.page && current.trail ? (
                <div>
                  <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {current.page}
                  </span>
                  <Trail items={current.trail} />
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3 border-t border-border px-6 py-3">
            <div
              className="flex items-center gap-1.5"
              role="group"
              aria-label="Tutorial steps"
            >
              {HOW_SUITES_WORK_STEPS.map((item, i) => (
                <button
                  key={item.title}
                  type="button"
                  aria-label={`Step ${i + 1}: ${item.title}`}
                  aria-current={i === step ? "step" : undefined}
                  onClick={() => setStep(i)}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === step
                      ? "w-5 bg-primary"
                      : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground",
                  )}
                />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {last ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Skip
                </Button>
              )}
              {step > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </Button>
              ) : null}
              {/* One element for every step, so focus stays on it when it
                  turns into Got it instead of dropping to the dialog. */}
              <Button
                ref={primaryRef}
                size="sm"
                onClick={last ? finish : () => setStep(step + 1)}
              >
                {last ? "Got it" : step === 0 ? "Walk me through it" : "Next"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
