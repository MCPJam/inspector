import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { XIcon, Loader2, LayoutGrid, Plus, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { OnboardingPhase } from "@/lib/onboarding-state";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];
const PANEL_WIDTH = 480;

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
        className="fixed inset-0 z-50 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25, ease: EASING }}
        onClick={onDismiss}
      />

      {/* Panel */}
      <motion.div
        key="welcome-overlay-panel"
        className="fixed z-50 bg-background rounded-lg border shadow-lg overflow-y-auto"
        style={{
          top: "10vh",
          left: "50%",
          marginLeft: -(PANEL_WIDTH / 2),
          width: PANEL_WIDTH,
          maxWidth: "calc(100vw - 2rem)",
          maxHeight: "80vh",
        }}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15, ease: EASING } as any }}
        transition={{ duration: 0.35, ease: EASING }}
      >
        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute top-3 right-3 z-10 rounded-full bg-background/80 backdrop-blur-sm p-1.5 opacity-70 transition-opacity hover:opacity-100 focus:outline-none"
        >
          <XIcon className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </button>

        <div className="flex flex-col items-center px-10 pt-10 pb-8">
          {/* Logo */}
          <img
            src={
              themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png"
            }
            alt="MCPJam"
            className="h-10 w-auto mb-6"
          />

          {/* Subtitle */}
          <p className="text-sm text-muted-foreground text-center mb-1">
            Your playground for MCP servers.
          </p>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Inspect tools, test prompts, and build AI-powered apps.
          </p>

          <Separator className="mb-6" />

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

          <p className="text-xs text-muted-foreground my-4">or</p>

          {/* Other options */}
          <div className="flex flex-col gap-3 w-full">
            {/* Secondary: Browse Registry (conditional) */}
            {registryEnabled && (
              <Button
                variant="outline"
                onClick={onBrowseRegistry}
                disabled={buttonsDisabled}
                className="w-full"
                size="lg"
              >
                <LayoutGrid className="h-4 w-4 mr-2" />
                Browse Registry
              </Button>
            )}

            {/* Secondary: Add server manually */}
            <Button
              variant="outline"
              onClick={onAddServerManually}
              disabled={buttonsDisabled}
              className="w-full"
              size="lg"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add server manually
            </Button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
