import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export type HostedShellGateState = "ready" | "auth-loading" | "project-loading";

interface HostedShellGateProps {
  state: HostedShellGateState;
  loadingMessage?: string;
  children: ReactNode;
}

function getGateCopy(state: HostedShellGateState): string {
  if (state === "auth-loading") {
    return "Checking authentication...";
  }
  return "Preparing project...";
}

export function HostedShellGate({
  state,
  loadingMessage,
  children,
}: HostedShellGateProps) {
  const isBlocked = state !== "ready" && state !== "auth-loading";
  const copy =
    loadingMessage && state === "project-loading"
      ? loadingMessage
      : getGateCopy(state);

  return (
    <div className="relative h-full min-h-0">
      <div
        data-testid="hosted-shell-gate-content"
        className={`h-full min-h-0 transition-[filter,opacity] duration-200 ${
          isBlocked ? "pointer-events-none select-none blur-[1px]" : ""
        }`}
        inert={isBlocked || undefined}
        aria-hidden={isBlocked || undefined}
      >
        {children}
      </div>
      {isBlocked && (
        <div
          data-testid="hosted-shell-gate-overlay"
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm px-4"
        >
          <div className="flex max-w-md flex-col items-center rounded-lg border border-border bg-card/90 p-6 text-center shadow-sm">
            <Loader2 className="mb-4 h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-foreground">{copy}</p>
          </div>
        </div>
      )}
    </div>
  );
}
