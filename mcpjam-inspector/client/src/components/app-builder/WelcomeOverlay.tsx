import { motion, AnimatePresence } from "framer-motion";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { OnboardingPhase } from "@/lib/onboarding-state";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];
const PANEL_WIDTH = 340;

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
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15, ease: EASING } as any }}
        transition={{ duration: 0.35, ease: EASING }}
      >
        <div
          className="pointer-events-auto bg-background rounded-lg border shadow-lg overflow-y-auto"
          style={{
            width: PANEL_WIDTH,
            maxWidth: "calc(100vw - 2rem)",
            maxHeight: "80vh",
          }}
        >
        <div className="flex flex-col items-center px-10 pt-10 pb-8">
          {/* Logo */}
          <img
            src={
              themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png"
            }
            alt="MCPJam"
            className="h-10 w-auto mb-6"
          />

          {/* Demo server section */}
          <p className="text-sm text-muted-foreground mb-5">
            Try a demo server
          </p>

          <div className="flex flex-col gap-3 w-full">
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
