import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  HOW_SUITES_WORK_LAST_STEP,
  HOW_SUITES_WORK_STEPS,
  clampStep,
  closeEventName,
  type HowSuitesWorkEventReporter,
  type HowSuitesWorkTrigger,
} from "./how-suites-work-model";
import {
  LayerDiagram,
  LayerSpine,
  MascotPlaceholder,
  SampleTrail,
} from "./how-suites-work-visuals";

export interface HowSuitesWorkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What opened it; sent with every tutorial event. */
  trigger: HowSuitesWorkTrigger;
  /** Adds Build a test case to the last step. */
  onBuildCase?: () => void;
  /** Receives eval_tutorial_shown, _completed and _dismissed. */
  onEvent?: HowSuitesWorkEventReporter;
}

/** The six-step "How suites work" tutorial. */
export function HowSuitesWorkDialog({
  open,
  onOpenChange,
  trigger,
  onBuildCase,
  onEvent,
}: HowSuitesWorkDialogProps) {
  const [step, setStep] = useState(0);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep(0);
      onEvent?.("eval_tutorial_shown", { trigger, step: 1 });
    }
    wasOpen.current = open;
  }, [open, trigger, onEvent]);

  const goTo = (next: number) => setStep(clampStep(next));

  const handleOpenChange = (next: boolean) => {
    if (!next && open) {
      onEvent?.(closeEventName(step), { trigger, step: step + 1 });
    }
    onOpenChange(next);
  };
  const close = () => handleOpenChange(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") goTo(step + 1);
    if (event.key === "ArrowLeft") goTo(step - 1);
  };

  const current = HOW_SUITES_WORK_STEPS[step];
  const last = step === HOW_SUITES_WORK_LAST_STEP;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        onKeyDown={handleKeyDown}
        data-testid="how-suites-work"
      >
        <DialogTitle className="sr-only">How suites work</DialogTitle>
        <div className="border-b border-border px-6 pt-6 pb-4 pr-12">
          <LayerSpine step={step} onJump={goTo} />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="flex items-center bg-muted/40 p-6">
            <LayerDiagram depth={current.depth} focus={current.focus} />
          </div>
          <div className="flex flex-col justify-center gap-5 p-6">
            <MascotPlaceholder />
            <div>
              <h3 className="text-2xl font-semibold tracking-tight text-foreground">
                {current.title}
              </h3>
              <DialogDescription
                className="mt-2 text-lg leading-snug"
                aria-live="polite"
              >
                {current.body}
              </DialogDescription>
            </div>
            {current.page ? (
              <div className="space-y-1.5">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {current.page.label}
                </span>
                <SampleTrail items={current.page.trail} />
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-border px-6 py-3">
          <div
            className="flex items-center gap-1.5"
            aria-label="Tutorial steps"
          >
            {HOW_SUITES_WORK_STEPS.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                aria-label={`Step ${index + 1}: ${entry.title}`}
                aria-current={index === step ? "step" : undefined}
                onClick={() => goTo(index)}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  index === step
                    ? "w-5 bg-primary"
                    : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground",
                )}
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {last ? null : (
              <Button variant="ghost" size="sm" onClick={close}>
                Skip
              </Button>
            )}
            {step > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => goTo(step - 1)}
              >
                Back
              </Button>
            ) : null}
            {last && onBuildCase ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  close();
                  onBuildCase();
                }}
              >
                Build a test case
              </Button>
            ) : null}
            {last ? (
              <Button size="sm" onClick={close}>
                Got it
              </Button>
            ) : (
              <Button size="sm" autoFocus onClick={() => goTo(step + 1)}>
                {step === 0 ? "Walk me through it" : "Next"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
