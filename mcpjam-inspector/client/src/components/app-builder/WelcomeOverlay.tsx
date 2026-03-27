import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { XIcon, Loader2, LayoutGrid, Plus, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { OnboardingPhase } from "@/lib/onboarding-state";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];
const PANEL_WIDTH = 520;

interface WelcomeOverlayProps {
  phase: OnboardingPhase;
  registryEnabled: boolean;
  connectError: string | null;
  onConnectExcalidraw: () => void;
  onBrowseRegistry: () => void;
  onAddServerManually: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

export function WelcomeOverlay({
  phase,
  registryEnabled,
  connectError,
  onConnectExcalidraw,
  onBrowseRegistry,
  onAddServerManually,
  onRetry,
  onDismiss,
}: WelcomeOverlayProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const isConnecting = phase === "connecting_excalidraw";
  const isError = phase === "connect_error";
  const buttonsDisabled = isConnecting;

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onDismiss]);

  return (
    <AnimatePresence>
      {/* Overlay backdrop */}
      <motion.div
        key="welcome-overlay-backdrop"
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25, ease: EASING }}
        onClick={onDismiss}
      />

      {/* Panel wrapper — handles centering so framer-motion doesn't fight CSS transforms */}
      <motion.div
        key="welcome-overlay-panel"
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{
          opacity: 0,
          scale: 0.97,
          y: 4,
          transition: { duration: 0.15, ease: EASING } as any,
        }}
        transition={{ duration: 0.35, ease: EASING }}
      >
        <div
          className="pointer-events-auto relative bg-background rounded-xl border shadow-xl overflow-y-auto"
          style={{
            width: PANEL_WIDTH,
            maxWidth: "calc(100vw - 2rem)",
            maxHeight: "90vh",
          }}
        >
          {/* Close button */}
          <button
            onClick={onDismiss}
            className="absolute top-4 right-4 z-10 rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>

          <div className="flex flex-col items-center px-12 pt-12 pb-10">
            {/* Logo */}
            <img
              src={
                themeMode === "dark"
                  ? "/mcp_jam_dark.png"
                  : "/mcp_jam_light.png"
              }
              alt="MCPJam"
              className="h-10 w-auto mb-8"
            />

            {/* Subtitle */}
            <p className="text-sm text-muted-foreground text-center leading-relaxed mb-8">
              Connect an MCP server to explore its tools, test
              prompts, and build apps — all from one place.
            </p>

            <Separator className="mb-8" />

            {/* Hint */}
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70 mb-5">
              Try a demo server
            </p>

            {/* Primary CTA */}
            <Button
              onClick={isError ? onRetry : onConnectExcalidraw}
              disabled={buttonsDisabled}
              className="w-full h-11 text-sm font-medium"
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
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 mt-2">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-destructive">{connectError}</p>
              </div>
            )}

            {/* Secondary actions */}
            <div className="flex items-center justify-center gap-1 mt-4">
              {registryEnabled && (
                <>
                  <Button
                    variant="ghost"
                    onClick={onBrowseRegistry}
                    disabled={buttonsDisabled}
                    className="text-muted-foreground hover:text-foreground"
                    size="sm"
                  >
                    <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />
                    Browse Registry
                  </Button>
                  <span className="text-border select-none" aria-hidden>
                    |
                  </span>
                </>
              )}
              <Button
                variant="ghost"
                onClick={onAddServerManually}
                disabled={buttonsDisabled}
                className="text-muted-foreground hover:text-foreground"
                size="sm"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add manually
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
