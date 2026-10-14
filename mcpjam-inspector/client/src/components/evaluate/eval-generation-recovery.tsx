import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useServerActionsOptional } from "@/state/server-actions-context";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { isUnretryableGenerationScope } from "@/shared/eval-generation-errors";

function useGenerationAuthorization(
  serverName: string | undefined,
  onRetry: () => void,
) {
  const serverActions = useServerActionsOptional();
  const [authorizing, setAuthorizing] = useState(false);
  const [message, setMessage] = useState<string>();
  const failedMessage =
    "Could not authorize the server. Open Servers to check its authentication settings.";
  const authorize = async () => {
    if (!serverName || authorizing) return;
    setAuthorizing(true);
    setMessage(undefined);
    try {
      const result = await serverActions?.ensureServersReady([serverName], {
        allowInteractiveOAuthFlow: true,
        forceReconnect: true,
      });
      if (result?.readyServerNames.includes(serverName)) onRetry();
      else
        setMessage(
          result?.reauthServerNames.includes(serverName)
            ? "Complete sign-in, then retry generation."
            : failedMessage,
        );
    } catch {
      setMessage(failedMessage);
    } finally {
      setAuthorizing(false);
    }
  };
  return { authorizing, message, authorize };
}

export function EvalGenerationRecovery({
  error,
  disabled,
  onRetry,
  onChangeSettings,
}: {
  error: string;
  disabled: boolean;
  onRetry: () => void;
  onChangeSettings?: () => void;
}) {
  const serverName = error.match(
    /Server "(.+)" requires OAuth authentication\b/,
  )?.[1];
  const { authorizing, message, authorize } = useGenerationAuthorization(
    serverName,
    onRetry,
  );
  if (serverName)
    return (
      <div className="space-y-3">
        {message && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || authorizing}
            onClick={() => void authorize()}
          >
            {authorizing ? "Authorizing..." : `Authorize ${serverName}`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigateApp(routePaths.servers)}
          >
            Open Servers
          </Button>
        </div>
      </div>
    );
  const changeSettings =
    isUnretryableGenerationScope(error) && onChangeSettings;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={changeSettings || onRetry}
    >
      {changeSettings ? "Change generation settings" : "Retry generation"}
    </Button>
  );
}
