import { useCallback, useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";

/** Time the welcome splash remains visible before it advances to server choice. */
export const FIRST_RUN_WELCOME_AUTO_ADVANCE_MS = 8_500;

type FirstRunOverlayStep = "welcome" | "choose";

interface FirstRunOnboardingOverlayProps {
  open: boolean;
  onConnectOwnServer: () => void;
  onConnectDemo: () => void;
  onSkip: () => void;
}

/**
 * The Home-mounted shell for first-run onboarding.
 *
 * It owns only the short welcome-to-choice transition. Connection setup and
 * outcomes remain in their existing surfaces until the later save-and-connect
 * slice can return structured results to this overlay.
 */
export function FirstRunOnboardingOverlay({
  open,
  onConnectOwnServer,
  onConnectDemo,
  onSkip,
}: FirstRunOnboardingOverlayProps) {
  const prefersReducedMotion = useReducedMotion();
  const [step, setStep] = useState<FirstRunOverlayStep>("welcome");
  const [isWelcomeCountdownRunning, setIsWelcomeCountdownRunning] =
    useState(false);

  useEffect(() => {
    if (!open) setStep("welcome");
  }, [open]);

  const continueToChoice = useCallback(() => {
    setStep("choose");
  }, []);

  useEffect(() => {
    if (!open || step !== "welcome" || prefersReducedMotion) return;
    const timeoutId = window.setTimeout(
      continueToChoice,
      FIRST_RUN_WELCOME_AUTO_ADVANCE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [continueToChoice, open, prefersReducedMotion, step]);

  // Start the CSS transition in a later browser task so the countdown paints at
  // full width before it begins shrinking. The same duration drives the visual
  // cue and the auto-advance timeout above.
  useEffect(() => {
    setIsWelcomeCountdownRunning(false);
    if (!open || step !== "welcome" || prefersReducedMotion) return;

    const startId = window.setTimeout(() => {
      setIsWelcomeCountdownRunning(true);
    }, 0);
    return () => window.clearTimeout(startId);
  }, [open, prefersReducedMotion, step]);

  useEffect(() => {
    if (!open || step !== "welcome") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      continueToChoice();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [continueToChoice, open, step]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onSkip()}>
      <DialogContent
        className={
          step === "welcome"
            ? "max-w-[420px] gap-0 border-0 bg-transparent p-1 text-left shadow-none"
            : "max-w-[408px] gap-0 rounded-xl border-border bg-card p-6 shadow-none"
        }
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          event.preventDefault();
          if (step === "welcome") continueToChoice();
        }}
      >
        {step === "welcome" ? (
          <>
            <DialogHeader className="gap-0 text-left">
              <DialogTitle className="max-w-[12ch] pb-0 text-[2rem] leading-[1.12] font-semibold tracking-[-0.038em] text-primary-foreground">
                Welcome to MCPJam
              </DialogTitle>
              <span
                className="mt-4 block h-px w-[72px] bg-primary"
                aria-hidden
              />
              <DialogDescription className="mt-4 max-w-[42ch] text-[14.5px] leading-[1.5] text-primary-foreground/80">
                From your first prompt to a continuous gate on every release,
                MCPJam shows what breaks across every AI client, and how to fix
                it.
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="link"
              className="mt-7 h-auto p-0 text-[12.5px] font-semibold text-primary-foreground decoration-primary-foreground/35 underline-offset-4 hover:text-primary-foreground hover:decoration-primary-foreground"
              onClick={continueToChoice}
            >
              Continue
            </Button>
            {!prefersReducedMotion ? (
              <div
                className="mt-6 h-px w-full overflow-hidden bg-primary-foreground/25"
                data-testid="welcome-countdown"
                aria-hidden
              >
                <div
                  className="h-full w-full origin-left bg-primary transition-transform ease-linear motion-reduce:hidden"
                  data-testid="welcome-countdown-bar"
                  style={{
                    transform: isWelcomeCountdownRunning
                      ? "scaleX(0)"
                      : "scaleX(1)",
                    transitionDuration: `${FIRST_RUN_WELCOME_AUTO_ADVANCE_MS}ms`,
                  }}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <DialogHeader className="gap-0 text-left">
              <DialogTitle className="pb-0 text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                Point MCPJam at a server
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                MCPJam connects to your MCP server and lets you call its tools,
                inspect traces, and see how different clients handle it.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-[18px] grid gap-0">
              <Button
                type="button"
                className="h-auto w-full rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
                onClick={onConnectOwnServer}
              >
                Connect your server
              </Button>
              <div
                className="flex items-center gap-3 py-4 text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                role="separator"
              >
                or
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full bg-card px-4 py-2.5 text-[12.5px] font-semibold shadow-none hover:border-primary hover:bg-card hover:text-foreground"
                onClick={onConnectDemo}
              >
                Try the Excalidraw demo server
              </Button>
              <p className="mt-1.5 text-center text-[10.5px] text-muted-foreground">
                6 tools · no setup · nothing to install
              </p>
            </div>
            <Button
              type="button"
              variant="link"
              className="mx-auto mt-3 h-auto p-1 text-[11px] font-normal text-muted-foreground no-underline hover:text-foreground hover:no-underline"
              onClick={onSkip}
            >
              I&apos;ll set this up later
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
