import type { ConnectionStatus } from "@/state/app-types";
import type { ReactNode } from "react";
import { Loader2, AlertTriangle } from "lucide-react";

interface LearningConnectionGateProps {
  connectionStatus: ConnectionStatus;
  label: string;
  children: ReactNode;
}

export function LearningConnectionGate({
  connectionStatus,
  label,
  children,
}: LearningConnectionGateProps) {
  if (connectionStatus === "connected") {
    return <>{children}</>;
  }

  if (connectionStatus === "connecting") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">Connecting to learning server…</p>
        </div>
      </div>
    );
  }

  if (connectionStatus === "failed") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <p className="text-sm">
            Could not connect to the learning server for {label}.
          </p>
          <p className="text-xs">
            Check your network connection and try again.
          </p>
        </div>
      </div>
    );
  }

  // disconnected / oauth-flow — waiting for mount effect
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Initializing {label} explorer…</p>
      </div>
    </div>
  );
}
