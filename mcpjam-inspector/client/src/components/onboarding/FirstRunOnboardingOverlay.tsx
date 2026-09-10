import { useCallback, useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";

/** Time a welcome card remains visible before it advances to server choice. */
export const FIRST_RUN_WELCOME_AUTO_ADVANCE_MS = 3_500;

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
        className="max-w-md gap-6 border-border p-7 sm:p-8"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          event.preventDefault();
          if (step === "welcome") continueToChoice();
        }}
      >
        {step === "welcome" ? (
          <>
            <DialogHeader className="gap-4 text-left">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-accent text-accent-foreground">
                <Sparkles className="size-5" aria-hidden />
              </div>
              <div className="space-y-2">
                <DialogTitle className="text-2xl text-card-foreground">
                  Welcome to MCPJam
                </DialogTitle>
                <DialogDescription className="text-sm leading-6 text-muted-foreground">
                  Connect one server, then use its tools from a real MCP client.
                </DialogDescription>
              </div>
            </DialogHeader>
            <Button type="button" className="w-full" onClick={continueToChoice}>
              Continue
              <ArrowRight aria-hidden />
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Press Enter or click outside this card to continue.
            </p>
          </>
        ) : (
          <>
            <DialogHeader className="gap-2 text-left">
              <DialogTitle className="text-2xl text-card-foreground">
                Point MCPJam at a server
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-muted-foreground">
                Bring your own MCP server, or try the Excalidraw demo with no
                setup.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3">
              <Button
                type="button"
                size="lg"
                className="w-full justify-between"
                onClick={onConnectOwnServer}
              >
                Connect your server
                <ArrowRight aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-auto w-full items-start justify-between px-4 py-3 text-left"
                onClick={onConnectDemo}
              >
                <span className="grid gap-1">
                  <span>Try the Excalidraw demo</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    6 tools · no setup
                  </span>
                </span>
                <ArrowRight className="mt-0.5" aria-hidden />
              </Button>
            </div>
            <Button
              type="button"
              variant="link"
              className="mx-auto text-muted-foreground"
              onClick={onSkip}
            >
              Skip for now
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
