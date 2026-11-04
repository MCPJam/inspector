import { useEffect } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";
import { toast } from "@/lib/toast";

export function ConformanceProtocolConnection({
  checking,
  result,
  serverName,
  version,
  onRetry,
  onSignIn,
}: {
  checking: boolean;
  result?: ConformanceConnectionResult;
  serverName: string;
  version: string;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  // A refused version needs no action here: the version picker sits right
  // above, so a toast says it once. The id keeps a step change from
  // showing the same refusal twice.
  useEffect(() => {
    if (result?.status !== "unsupported") return;
    toast.error(`${serverName} doesn’t support ${result.protocolVersion}.`, {
      id: `conformance-unsupported-${serverName}-${result.protocolVersion}`,
      ...(result.supportedVersions.length > 0
        ? {
            description: `Server offers: ${result.supportedVersions.join(", ")}.`,
          }
        : {}),
    });
  }, [result, serverName]);

  if (checking)
    return (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        Connecting with {version}…
      </p>
    );
  if (!result || result.status === "ready" || result.status === "unsupported")
    return null;
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <p>
        {result.status === "auth-required"
          ? "Sign in to check this protocol version."
          : result.message}
      </p>
      <Button
        className="mt-2"
        size="sm"
        variant="outline"
        onClick={result.status === "auth-required" ? onSignIn : onRetry}
      >
        {result.status === "auth-required" ? "Sign in" : "Retry"}
      </Button>
    </div>
  );
}
