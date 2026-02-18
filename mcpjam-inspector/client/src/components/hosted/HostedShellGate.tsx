import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type HostedShellGateState =
  | "ready"
  | "auth-loading"
  | "workspace-loading"
  | "logged-out";

interface HostedShellGateProps {
  state: HostedShellGateState;
  onSignIn?: () => void;
  children: ReactNode;
}

function getGateCopy(state: HostedShellGateState): string {
  if (state === "auth-loading") {
    return "Checking authentication...";
  }
  if (state === "workspace-loading") {
    return "Preparing workspace...";
  }
  return "Sign in to MCPJam to continue";
}

export function HostedShellGate({
  state,
  onSignIn,
  children,
}: HostedShellGateProps) {
  const isBlocked = state !== "ready";

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
            {state === "logged-out" ? (
              <img
                src="/mcp_jam.svg"
                alt="MCPJam"
                className="mb-4 h-12 w-auto"
              />
            ) : (
              <Loader2 className="mb-4 h-5 w-5 animate-spin text-muted-foreground" />
            )}
            <p className="text-sm text-foreground">{getGateCopy(state)}</p>
            {state === "logged-out" && (
              <Button
                type="button"
                size="sm"
                className="mt-4"
                onClick={() => onSignIn?.()}
              >
                Sign in
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
