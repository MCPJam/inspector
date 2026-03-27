import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  XIcon,
  Loader2,
  LayoutGrid,
  AlertCircle,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import type { OnboardingPhase } from "@/lib/onboarding-state";

const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];

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

function OptionCard({
  icon,
  title,
  description,
  onClick,
  disabled,
  loading,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={onClick}
        disabled={disabled}
        className="group flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-card transition-all duration-200 hover:border-primary/40 hover:shadow-md hover:shadow-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
      >
        <div className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors duration-200 group-hover:text-primary">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
        </div>
      </button>
      <div className="flex flex-col items-center gap-1">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground text-center max-w-32">
          {description}
        </p>
      </div>
    </div>
  );
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

      {/* Panel wrapper */}
      <motion.div
        key="welcome-overlay-panel"
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none px-4"
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
        <div className="pointer-events-auto relative w-full max-w-xl bg-background rounded-2xl border shadow-xl overflow-y-auto max-h-[90vh]">
          {/* Close button */}
          <button
            onClick={onDismiss}
            className="absolute top-5 right-5 z-10 rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>

          <div className="flex flex-col items-center px-10 pt-10 pb-8 sm:px-14 sm:pt-10 sm:pb-10">
            {/* Logo */}
            <img
              src={
                themeMode === "dark"
                  ? "/mcp_jam_dark.png"
                  : "/mcp_jam_light.png"
              }
              alt="MCPJam"
              className="h-8 w-auto mb-6"
            />

            {/* Subtitle */}
            <p className="text-xs text-muted-foreground text-center leading-relaxed max-w-sm mb-6">
              Connect an MCP server to explore its tools, test prompts, and
              build apps — all from one place.
            </p>

            {/* Error message */}
            {isError && connectError && (
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 mb-6 w-full">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-destructive">{connectError}</p>
              </div>
            )}

            {/* Section label */}
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60 mb-4">
              Get started
            </p>

            {/* Option cards */}
            <div className="flex items-start justify-center gap-8">
              {/* Connect Excalidraw */}
              <OptionCard
                icon={
                  isError ? (
                    <RefreshCw className="h-5 w-5" />
                  ) : (
                    <img
                      src="https://excalidraw.com/favicon.ico"
                      alt=""
                      className="h-5 w-5"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  )
                }
                title={isError ? "Retry Excalidraw" : "Try Excalidraw"}
                description="Try a demo server"
                onClick={isError ? onRetry : onConnectExcalidraw}
                disabled={buttonsDisabled}
                loading={isConnecting}
              />

              {/* Browse Registry */}
              {registryEnabled && (
                <OptionCard
                  icon={<LayoutGrid className="h-5 w-5" />}
                  title="Browse Registry"
                  description="Find servers to connect"
                  onClick={onBrowseRegistry}
                  disabled={buttonsDisabled}
                />
              )}

              {/* Add manually */}
              <OptionCard
                icon={<Pencil className="h-5 w-5" />}
                title="Add Manually"
                description="Enter a URL or command"
                onClick={onAddServerManually}
                disabled={buttonsDisabled}
              />
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
