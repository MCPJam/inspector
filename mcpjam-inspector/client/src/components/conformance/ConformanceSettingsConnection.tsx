import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ConformanceConnectServer } from "./ConformancePanel";
import { ConformanceConnectError } from "./ConformancePageChrome";

export function ConformanceSettingsConnection({
  server,
  onConnectServer,
  onEditServer,
}: {
  server?: ServerWithName;
  onConnectServer?: ConformanceConnectServer;
  onEditServer?: (name: string) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<{ needsSignIn: boolean } | null>(null);
  if (!server || server.connectionStatus === "connected" || !onConnectServer)
    return null;
  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      const outcome = await onConnectServer(server.name, {
        signIn: failure?.needsSignIn,
      });
      setFailure(
        outcome === "ready" ? null : { needsSignIn: outcome === "reauth" },
      );
    } catch {
      setFailure({ needsSignIn: false });
    } finally {
      setConnecting(false);
    }
  };
  return (
    <div className="mb-4 space-y-2">
      {failure ? (
        <ConformanceConnectError
          server={server}
          needsSignIn={failure.needsSignIn}
          onRetry={() => void connect()}
          onEdit={onEditServer ? () => onEditServer(server.name) : undefined}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Connect this server to list its tools.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={connecting}
            onClick={() => void connect()}
          >
            {connecting ? "Connecting..." : "Connect"}
          </Button>
        </>
      )}
    </div>
  );
}
