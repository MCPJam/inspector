import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ASK_ORG_ADMIN, MANAGE_AI_PROVIDERS } from "@/lib/org-keys-refusal";
import { ORG_KEY_MISSING_MESSAGE } from "@/shared/org-key-surfaces";
import { CHOOSE_ORG_JUDGE_MODEL } from "@/components/evals/judge-model-picker";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { getProviderDisplayName } from "@/lib/provider-registry";
import { AccountPreflightNotices } from "./suite-run-account-preflight";
import { PreflightNotice } from "./preflight-notice";
import type { RunPreflightState } from "./suite-run-preflight";

/** What Set up run would fail on: one notice per message. */
export function RunPreflightNotices({
  preflight,
  disabled = false,
  onEditSettings,
  onConnectingChange,
}: {
  preflight: RunPreflightState;
  disabled?: boolean;
  /** Where an environment's launch refusal is fixed. */
  onEditSettings?: () => void;
  /** Start must wait: a launch connects the same server again. */
  onConnectingChange?: (connecting: boolean) => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  // Kept with its server, so it goes away once that server connects, from
  // here or anywhere else.
  const [failure, setFailure] = useState<{
    ref: string;
    message: string;
  } | null>(null);
  const { disconnected, removed, refused, disabledProviders, serverName } =
    preflight;
  const orgConfigProblems = preflight.orgConfigProblems ?? [];
  if (
    !disconnected.length &&
    !removed.length &&
    !refused.length &&
    !disabledProviders.length &&
    !orgConfigProblems.length &&
    !preflight.accountProblems?.length
  )
    return null;
  const openServers = (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs"
      onClick={() => navigateApp(routePaths.servers)}
    >
      Open Servers
    </Button>
  );
  const connect = async (ref: string) => {
    if (!preflight.connect) return;
    setConnecting(ref);
    onConnectingChange?.(true);
    setFailure(null);
    try {
      const message = await preflight.connect(ref);
      setFailure(message ? { ref, message } : null);
    } catch (error) {
      console.warn("[Set up run] Connect failed.", error);
      setFailure({ ref, message: `${serverName(ref)} didn't connect.` });
    } finally {
      setConnecting(null);
      onConnectingChange?.(false);
    }
  };
  const manageProviders = preflight.manageModels ? (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={preflight.manageModels}
    >
      {MANAGE_AI_PROVIDERS}
    </Button>
  ) : undefined;
  // The judge is picked in suite settings; the provider page can't pick it.
  const chooseJudge = onEditSettings ? (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={onEditSettings}
    >
      Open suite settings
    </Button>
  ) : undefined;
  return (
    <section aria-label="Before you run" className="space-y-2">
      <AccountPreflightNotices {...{ preflight, disabled, onEditSettings }} />
      {orgConfigProblems.length > 0 && (
        <div className="space-y-2" data-testid="preflight-org-key-problems">
          {orgConfigProblems.map((message) => {
            const action =
              message === CHOOSE_ORG_JUDGE_MODEL
                ? chooseJudge
                : manageProviders;
            return (
              <PreflightNotice key={`org-config:${message}`} action={action}>
                <p className="text-destructive">{message}</p>
                {/* A missing Cursor key's sentence already says who adds it, and where. */}
                {!action && message !== ORG_KEY_MISSING_MESSAGE && (
                  <p className="text-muted-foreground">
                    {ASK_ORG_ADMIN} if no organization model fits.
                  </p>
                )}
              </PreflightNotice>
            );
          })}
        </div>
      )}
      {refused.map((message) => (
        <PreflightNotice key={`refused:${message}`}>
          <p className="text-destructive">
            {message}{" "}
            {onEditSettings && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={onEditSettings}
              >
                Open suite settings
              </Button>
            )}
          </p>
        </PreflightNotice>
      ))}
      {removed.map((ref) => (
        <PreflightNotice key={`removed:${ref}`}>
          <p className="text-destructive">
            {serverName(ref)} is no longer in this project, so this suite can't
            run. Re-add it, or point the suite at another server. {openServers}
          </p>
        </PreflightNotice>
      ))}
      {disconnected.map((ref) => (
        <PreflightNotice
          key={`disconnected:${ref}`}
          action={
            preflight.connect ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled || connecting !== null}
                aria-label={`Connect ${serverName(ref)}`}
                onClick={() => void connect(ref)}
              >
                {connecting === ref && (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                )}
                Connect
              </Button>
            ) : (
              openServers
            )
          }
        >
          <p>{`${serverName(ref)} isn't connected. Start tries to connect it.`}</p>
          {failure?.ref === ref && (
            <p role="alert" className="text-destructive">
              {failure.message} {openServers}
            </p>
          )}
        </PreflightNotice>
      ))}
      {disabledProviders.map((provider) => (
        <PreflightNotice
          key={`provider:${provider}`}
          action={
            preflight.manageModels && (
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={preflight.manageModels}
              >
                Manage models
              </Button>
            )
          }
        >
          <p>
            {`${getProviderDisplayName(provider)} isn't enabled in your organization's AI providers, so its models will fail to run.`}
          </p>
        </PreflightNotice>
      ))}
    </section>
  );
}
