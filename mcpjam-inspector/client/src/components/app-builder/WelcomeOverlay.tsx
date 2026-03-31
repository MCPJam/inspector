import { motion, AnimatePresence } from "framer-motion";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { OnboardingPhase } from "@/lib/onboarding-state";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];
const PANEL_WIDTH = 380;

interface WelcomeOverlayProps {
  phase: OnboardingPhase;
  connectError: string | null;
  onConnectExcalidraw: () => void;
  onRetry: () => void;
}

export function WelcomeOverlay({
  phase,
  connectError,
  onConnectExcalidraw,
  onRetry,
}: WelcomeOverlayProps) {
  const dialogTitleId = "app-builder-welcome-overlay-title";
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const isConnecting = phase === "connecting_excalidraw";
  const isError = phase === "connect_error";
  const buttonsDisabled = isConnecting;

  return (
    <AnimatePresence>
      {/* Overlay backdrop */}
      <motion.div
        key="welcome-overlay-backdrop"
        className="fixed inset-0 z-50 bg-black/50"
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25, ease: EASING }}
      />

      {/* Panel wrapper — flex centering so framer-motion scale doesn't fight CSS transforms */}
      <motion.div
        key="welcome-overlay-panel"
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        animate={{ opacity: 1, scale: 1 }}
        exit={{
          opacity: 0,
          scale: 0.97,
          transition: { duration: 0.15, ease: EASING } as any,
        }}
        transition={{ duration: 0.35, ease: EASING }}
      >
        <div
          className="pointer-events-auto bg-background rounded-xl border shadow-xl overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          style={{
            width: PANEL_WIDTH,
            maxWidth: "calc(100vw - 2rem)",
            maxHeight: "80vh",
          }}
        >
          <div className="flex min-h-[264px] flex-col items-center pb-6">
            {/* Gradient header strip */}
            <div className="w-full rounded-t-xl bg-gradient-to-b from-muted/30 to-transparent px-8 pt-8 pb-6 flex flex-col items-center">
              {/* Logo */}
              <img
                src={
                  themeMode === "dark"
                    ? "/mcp_jam_dark.png"
                    : "/mcp_jam_light.png"
                }
                alt="MCPJam"
                className="h-10 w-auto mb-5"
              />

              <h2 id={dialogTitleId} className="sr-only">
                Welcome to MCPJam
              </h2>

              <div className="space-y-2 text-center">
                <p className="text-xl font-semibold text-foreground">
                  Your playground for MCP servers
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  Inspect tools, test prompts, and build AI powered apps.
                </p>
              </div>
            </div>

            <div className="w-full px-8 flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <p className="text-xs font-medium text-muted-foreground/70">
                  Try a demo server
                </p>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* Primary: Connect Excalidraw */}
              <Button
                onClick={isError ? onRetry : onConnectExcalidraw}
                disabled={buttonsDisabled}
                className="w-full"
                size="lg"
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <img
                      src="https://excalidraw.com/favicon.ico"
                      alt=""
                      className="h-4 w-4 mr-2"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                    {isError ? "Retry Excalidraw" : "Connect Excalidraw"}
                  </>
                )}
              </Button>

              {/* Error message */}
              {isError && connectError && (
                <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
                  <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <p className="text-sm text-destructive">{connectError}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
