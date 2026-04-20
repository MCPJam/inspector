import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { getChatboxOAuthRowCopy } from "@/components/hosted/chatbox-oauth-copy";
import { Button } from "@mcpjam/design-system/button";
import type { HostedOAuthServerDescriptor } from "@/hooks/hosted/use-hosted-oauth-gate";
import type { HostedOAuthState } from "@/lib/hosted-oauth-resume";

const FINISHING_TIMEOUT_MS = 10_000;

export function ChatboxHostOnboardingOverlays({
  showWelcome,
  onGetStarted,
  welcomeBody,
  showAuthPanel,
  pendingOAuthServers,
  authorizeServer,
  isFinishingOAuth,
}: {
  showWelcome: boolean;
  onGetStarted: () => void;
  welcomeBody?: string | null;
  showAuthPanel: boolean;
  pendingOAuthServers: Array<{
    server: HostedOAuthServerDescriptor;
    state: HostedOAuthState;
  }>;
  authorizeServer: (server: HostedOAuthServerDescriptor) => Promise<void>;
  isFinishingOAuth: boolean;
}) {
  const [finishingTimedOut, setFinishingTimedOut] = useState(false);

  /** When still "finishing", any change to which servers or statuses are in-flight restarts the slow-timeout timer. */
  const finishingOAuthSignature = useMemo(() => {
    if (!isFinishingOAuth) return "";
    return [...pendingOAuthServers]
      .map(({ server, state }) => `${server.serverId}:${state.status}`)
      .sort()
      .join("|");
  }, [isFinishingOAuth, pendingOAuthServers]);

  useEffect(() => {
    if (!isFinishingOAuth) {
      setFinishingTimedOut(false);
      return;
    }
    setFinishingTimedOut(false);
    const timer = window.setTimeout(
      () => setFinishingTimedOut(true),
      FINISHING_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isFinishingOAuth, finishingOAuthSignature]);

  const welcomeText = welcomeBody?.trim() ?? "";
  const shouldRenderWelcome = showWelcome && welcomeText.length > 0;

  const showFinishingLayer = showAuthPanel && isFinishingOAuth;
  const showAuthListLayer = showAuthPanel && !isFinishingOAuth;

  const onlyOptionalOAuthPending =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ server }) => server.optional);

  const authSubtitle = onlyOptionalOAuthPending
    ? "Authorize below to connect optional servers to this chat."
    : "Authorize the required chatbox servers to continue.";

  return (
    <>
      {shouldRenderWelcome ? (
        <div
          className="pointer-events-auto absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-background/20 p-4 dark:bg-background/30"
          role="dialog"
          aria-modal="true"
          aria-label="Welcome"
          onClick={onGetStarted}
        >
          <div
            className="w-full max-w-lg cursor-auto rounded-2xl border border-border/80 bg-card/95 p-6 shadow-2xl ring-1 ring-black/5 backdrop-blur-sm dark:ring-white/10"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="whitespace-pre-wrap text-center text-sm text-muted-foreground">
              {welcomeText}
            </p>
            <div className="mt-6 flex justify-center">
              <Button type="button" onClick={onGetStarted}>
                Get Started
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showFinishingLayer ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/25 p-4 dark:bg-background/35">
          <div className="w-full max-w-md rounded-2xl border border-border/80 bg-card/95 p-6 text-center shadow-2xl ring-1 ring-black/5 backdrop-blur-sm dark:ring-white/10">
            <h3 className="text-base font-semibold text-foreground">
              Finishing authorization
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {onlyOptionalOAuthPending
                ? "Finishing authorization for optional servers."
                : "Finishing authorization for the required chatbox servers."}
            </p>
            {!finishingTimedOut ? (
              <div className="mt-6 flex justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="mt-6 flex flex-col items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  This is taking longer than expected.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => window.location.reload()}
                >
                  Retry
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {showAuthListLayer ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/25 p-4 dark:bg-background/35">
          <div className="w-full max-w-xl rounded-2xl border border-border/80 bg-card/95 p-6 shadow-2xl ring-1 ring-black/5 backdrop-blur-sm dark:ring-white/10">
            <h3 className="text-center text-base font-semibold text-foreground">
              Authorization Required
            </h3>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {authSubtitle}
            </p>
            <div className="mt-5 space-y-3">
              {pendingOAuthServers.map(({ server, state }) => {
                const rowCopy = getChatboxOAuthRowCopy(state.status);
                return (
                  <div
                    key={server.serverId}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {server.serverName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {state.status === "error" && state.errorMessage
                          ? state.errorMessage
                          : rowCopy.description}
                      </p>
                    </div>
                    {rowCopy.buttonLabel ? (
                      <Button
                        size="sm"
                        onClick={() => void authorizeServer(server)}
                      >
                        {rowCopy.buttonLabel}
                      </Button>
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
