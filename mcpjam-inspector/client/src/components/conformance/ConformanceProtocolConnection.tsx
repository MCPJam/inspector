import { Button } from "@mcpjam/design-system/button";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";

export function ConformanceProtocolConnection({
  checking,
  result,
  serverName,
  version,
  onChangeVersion,
  onRetry,
  onSignIn,
}: {
  checking: boolean;
  result?: ConformanceConnectionResult;
  serverName: string;
  version: string;
  onChangeVersion: () => void;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  if (checking)
    return (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        Connecting with {version}…
      </p>
    );
  if (!result || result.status === "ready") return null;
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      {result.status === "unsupported" ? (
        <>
          <p>
            {serverName} doesn’t support {result.protocolVersion}.
          </p>
          {result.supportedVersions.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              Server offers: {result.supportedVersions.join(", ")}.
            </p>
          )}
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={onChangeVersion}
          >
            Change version
          </Button>
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
