import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { track } from "@/lib/analytics";
import {
  TUTORIAL_COPY,
  TUTORIAL_STEPS,
  dotLabel,
} from "./how-suites-work-copy";
import type { TutorialTrigger } from "./trigger-rules";
import { TutorialDiagram } from "./tutorial-diagram";
import { useTutorialEase } from "./tutorial-motion";
import { TutorialPossum } from "./tutorial-possum";
import { TutorialSpine, TutorialTrail } from "./tutorial-spine";

const LAST_STEP = TUTORIAL_STEPS.length - 1;

export interface HowSuitesWorkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What opened it; used only for analytics. */
  trigger: TutorialTrigger;
  /** When given, the last step offers "Build a test case". */
  onBuildCase?: () => void;
}

/** The six-step "How suites work" tutorial. Controlled; starts on step 1 each opening. */
export function HowSuitesWorkDialog({
  open,
  onOpenChange,
  trigger,
  onBuildCase,
}: HowSuitesWorkDialogProps) {
  const [step, setStep] = useState(0);
  const [openedAt, setOpenedAt] = useState(open);
  if (open !== openedAt) {
    setOpenedAt(open);
    if (open) setStep(0);
  }
  const ease = useTutorialEase();
  useTutorialAnalytics(open, trigger, step);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        setStep((s) => Math.min(LAST_STEP, s + 1));
      } else if (event.key === "ArrowLeft") {
        setStep((s) => Math.max(0, s - 1));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const current = TUTORIAL_STEPS[step];
  const last = step === LAST_STEP;
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-5xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">
          {TUTORIAL_COPY.dialogName}
        </DialogTitle>
        <div className="flex max-h-[85vh] min-h-[min(620px,85vh)] flex-col overflow-y-auto">
          <div className="border-b border-border px-6 pb-4 pt-6 pr-12">
            <TutorialSpine step={step} onJump={setStep} ease={ease} />
          </div>
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="flex items-center bg-muted/40 p-6">
              <TutorialDiagram step={current} ease={ease} />
            </div>
            <div className="flex flex-col justify-center gap-5 p-6">
              <TutorialPossum size={168} />
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {current.title}
                </h2>
                <p
                  className="mt-2 text-lg leading-snug text-muted-foreground"
                  aria-live="polite"
                >
                  {current.line}
                </p>
              </div>
              {current.page ? (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {current.page.label}
                  </span>
                  <TutorialTrail items={current.page.trail} />
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3 border-t border-border px-6 py-3">
            <div
              className="flex items-center gap-1.5"
              role="tablist"
              aria-label={TUTORIAL_COPY.dotsLabel}
            >
              {TUTORIAL_STEPS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === step}
                  aria-label={dotLabel(i)}
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
                <Button variant="ghost" size="sm" onClick={close}>
                  {TUTORIAL_COPY.skip}
                </Button>
              )}
              {step > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep(step - 1)}
                >
                  {TUTORIAL_COPY.back}
                </Button>
              ) : null}
              {last ? (
                <>
                  {onBuildCase ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        close();
                        onBuildCase();
                      }}
                    >
                      {TUTORIAL_COPY.buildCase}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={close}>
                    {TUTORIAL_COPY.done}
                  </Button>
                </>
              ) : (
                <Button
                  key={step}
                  size="sm"
                  autoFocus
                  onClick={() => setStep(step + 1)}
                >
                  {step === 0 ? TUTORIAL_COPY.start : TUTORIAL_COPY.next}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One `eval_tutorial_shown` per opening, then exactly one of
 * `eval_tutorial_completed` (closed on the last step, by any means) or
 * `eval_tutorial_dismissed` (closed earlier), each with the trigger and the
 * 1-based step showing.
 */
function useTutorialAnalytics(
  open: boolean,
  trigger: TutorialTrigger,
  step: number,
) {
  const wasOpen = useRef(false);
  const latest = useRef({ trigger, step });
  latest.current = { trigger, step };

  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    const { trigger: openedBy, step: at } = latest.current;
    if (open) {
      track("eval_tutorial_shown", { trigger: openedBy, step: 1 });
    } else if (at === LAST_STEP) {
      track("eval_tutorial_completed", { trigger: openedBy, step: at + 1 });
    } else {
      track("eval_tutorial_dismissed", { trigger: openedBy, step: at + 1 });
    }
  }, [open]);
}
