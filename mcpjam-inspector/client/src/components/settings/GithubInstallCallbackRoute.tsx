import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Github } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useAppNavigate } from "@/lib/app-navigation";
import { toast } from "@/lib/toast";
import { redirectToGithub } from "@/lib/github-external-redirect";
import {
  githubChecksWriteErrorMessage,
  GITHUB_BINDING_FAILED_MESSAGE,
  GITHUB_CALLBACK_INCOMPLETE_MESSAGE,
  GITHUB_SIGNED_OUT_MESSAGE,
} from "@/lib/github-checks-errors";
import {
  useGithubInstallCallbacks,
  type ClaimableInstallation,
} from "@/hooks/useGithubChecksSettings";
import { SettingsPageShell } from "./SettingsPageShell";
import { SettingsSection } from "../setting/SettingsSection";

/**
 * `/settings/integrations/github/callback` — where GitHub sends the browser
 * back, twice.
 *
 * ONE page for both legs, because the browser cannot tell them apart until it
 * looks at the query string and neither can we:
 *
 *   `installation_id` + `state`  → the App's SETUP redirect. The backend
 *     consumes the install state, records the installation id as an unproven
 *     CANDIDATE, and hands back GitHub's user-authorization URL. We follow it.
 *
 *   `code` + `state`             → the OAuth redirect. The backend exchanges
 *     the code, proves the candidate against `GET /user/installations`, and
 *     either finishes the bind or — for a direct-install claim, which had no
 *     candidate — returns the proven list for a pick.
 *
 * EVERYTHING IS PASSED THROUGH VERBATIM. Nothing here parses, normalizes, or
 * pre-validates a parameter. The backend matches states by hash and treats the
 * installation id as a claim GitHub itself says can be spoofed, so any
 * cleverness in the browser could only turn one refusal into a different one —
 * while a well-meaning "clean this up first" is how a legitimate state stops
 * matching.
 *
 * Every failure renders the SAME copy. The backend refuses flatly on purpose:
 * telling "already connected to another workspace" apart from "that
 * installation does not exist" apart from "your proof failed" would answer
 * questions about other people's GitHub accounts.
 */

type Phase =
  | { kind: "working" }
  | { kind: "failed"; message: string }
  | {
      kind: "pick";
      linkSessionId: string;
      installations: ClaimableInstallation[];
    };

const SETTINGS_PATH = "/settings/integrations/github";

export function GithubInstallCallbackRoute() {
  const [searchParams] = useSearchParams();
  const appNavigate = useAppNavigate();
  const {
    completeInstallSetup,
    completeUserAuthorization,
    claimProvenInstallation,
  } = useGithubInstallCallbacks();

  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const [claiming, setClaiming] = useState<number | null>(null);

  // BOTH legs call `signedInAction`s, and this page is reached by a FULL PAGE
  // LOAD from GitHub's redirect — so the Convex client has not attached a token
  // yet when the effect below first runs. Calling either action in that window
  // throws `Authentication required`, which is a plain `Error` and therefore
  // reaches the user as a bare `Server Error` through the production mask, with
  // the one-time state left unconsumed and the flow dead.
  //
  // Every other surface in this app gates its reads the same way
  // (`useGithubChecksSettings`'s `canQuery`); this one has to gate a one-shot
  // effect rather than a resubscribing query, which is exactly why it was easy
  // to miss: a `useQuery` simply re-runs once auth lands, an action does not.
  // THE WORKOS USER IS THE ONE THAT DECIDES, and `useConvexAuth` alone will not
  // do. Guests are authenticated to Convex on purpose: `unified-convex-auth`
  // hands the provider a guest token and a `GUEST_USER_PLACEHOLDER` so guests
  // travel the same provider chain as members, and `useEnsureDbUser` marks them
  // ready too. So `isAuthenticated && isUserReady` is TRUE for a guest, who
  // would then call a `signedInAction` and get the generic binding failure —
  // while the signed-out branch below never fired at all.
  //
  // GitHub Checks is member-only, and the sibling surface already reads it this
  // way (`useGithubChecksSettings`: `isAuthenticated && user && isUserReady`).
  // This is the same rule, not a guest special case.
  const { user: workosUser, isLoading: isWorkosLoading } = useAuth();
  const { isLoading: isConvexAuthLoading, isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const isAuthSettling = isWorkosLoading || isConvexAuthLoading;
  // `isUserReady` matters as well: the actions resolve the WorkOS identity to a
  // Convex user row, which does not exist until the bootstrap that provisions
  // it has finished.
  const canCall = Boolean(isAuthenticated && workosUser && isUserReady);

  // GitHub's redirect is a full page load, but React 18 StrictMode runs effects
  // twice in development — and both legs CONSUME a one-time state, so a second
  // run would burn it and land the user on "we could not finish connecting"
  // having done nothing wrong. Ref rather than state: it must be set
  // synchronously, before the second invocation can read it.
  const startedRef = useRef(false);

  const installationId = searchParams.get("installation_id");
  const state = searchParams.get("state");
  const code = searchParams.get("code");

  const fail = useCallback((error: unknown) => {
    setPhase({
      kind: "failed",
      // The backend words these; `githubChecksWriteErrorMessage` reads the
      // `ConvexError` payload rather than the masked `message`. The constant is
      // only the fallback for a failure that carried no message of its own.
      message:
        githubChecksWriteErrorMessage(error) || GITHUB_BINDING_FAILED_MESSAGE,
    });
  }, []);

  useEffect(() => {
    if (startedRef.current) return;

    // Wait, rather than fail, while auth is still settling. `startedRef` is
    // deliberately NOT set on this path: the effect must be free to run again
    // when the token lands, which is the whole point of waiting.
    if (isAuthSettling || !canCall) {
      // No WorkOS user once auth has settled — signed out, or a guest, which
      // for a member-only surface is the same answer and the same instruction.
      // Say it instead of spinning forever on "Finishing up with GitHub…".
      if (!isAuthSettling && !workosUser) {
        setPhase({ kind: "failed", message: GITHUB_SIGNED_OUT_MESSAGE });
      }
      return;
    }

    startedRef.current = true;

    // The SETUP leg. `installation_id` is a claim; we forward it and let the
    // backend quarantine it.
    if (installationId && state) {
      const parsed = Number(installationId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        // The one thing worth checking here, and only because there is nothing
        // to send otherwise — GitHub's own parameter must at least be a number.
        setPhase({ kind: "failed", message: GITHUB_BINDING_FAILED_MESSAGE });
        return;
      }
      void completeInstallSetup({ installationId: parsed, state })
        .then(({ authorizeUrl }) => {
          try {
            redirectToGithub(authorizeUrl);
          } catch {
            // A redirect the guard refused is NOT a backend refusal, and must
            // not be reported as one: `UnsafeRedirectError`'s message is
            // developer text ("Refused to redirect outside GitHub"), and
            // `fail` would put it on screen verbatim. The user gets the flat
            // binding copy; there is nothing for them to do differently.
            console.error("[github-checks] refused an unsafe authorize URL");
            setPhase({
              kind: "failed",
              message: GITHUB_BINDING_FAILED_MESSAGE,
            });
          }
        })
        .catch(fail);
      return;
    }

    // The OAuth leg.
    if (code && state) {
      void completeUserAuthorization({ code, state })
        .then((result) => {
          if (result.status === "bound") {
            toast.success(`Connected ${result.accountLogin}.`);
            appNavigate(SETTINGS_PATH);
            return;
          }
          setPhase({
            kind: "pick",
            linkSessionId: result.linkSessionId,
            installations: result.installations,
          });
        })
        .catch(fail);
      return;
    }

    // Neither. Somebody opened or reloaded this URL directly.
    setPhase({ kind: "failed", message: GITHUB_CALLBACK_INCOMPLETE_MESSAGE });
  }, [
    appNavigate,
    canCall,
    code,
    completeInstallSetup,
    completeUserAuthorization,
    fail,
    installationId,
    isAuthSettling,
    state,
    workosUser,
  ]);

  const handleClaim = async (
    linkSessionId: string,
    installation: ClaimableInstallation
  ) => {
    setClaiming(installation.installationId);
    try {
      await claimProvenInstallation({
        linkSessionId,
        installationId: installation.installationId,
      });
      toast.success(`Connected ${installation.accountLogin}.`);
      appNavigate(SETTINGS_PATH);
    } catch (error) {
      fail(error);
    } finally {
      setClaiming(null);
    }
  };

  return (
    <SettingsPageShell active="integrations">
      <div className="space-y-2">
        <h2 className="text-lg font-medium">Connect a GitHub account</h2>
      </div>

      {/* This page replaces its whole content asynchronously — "Finishing up"
          becomes a refusal or an account picker with no interaction — so a
          screen reader would otherwise sit on a message that has already gone.
          `role="status"` announces the replacement politely. */}
      {phase.kind === "working" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Finishing up with GitHub…
        </p>
      ) : null}

      {phase.kind === "failed" ? (
        <SettingsSection title="Could not connect">
          <div className="space-y-3 px-4 py-4">
            <p role="status" className="text-sm text-muted-foreground">
              {phase.message}
            </p>
            <Button
              variant="outline"
              onClick={() => appNavigate(SETTINGS_PATH)}
            >
              Back to GitHub Checks
            </Button>
          </div>
        </SettingsSection>
      ) : null}

      {phase.kind === "pick" ? (
        <SettingsSection title="Choose an account">
          {phase.installations.length === 0 ? (
            <div className="space-y-3 px-4 py-4 text-sm text-muted-foreground">
              {/* An EMPTY proven list is a real answer, not a failure: this
                  GitHub user has the app installed nowhere. Saying so is more
                  useful than the generic refusal. */}
              <p>
                You are signed in to GitHub, but the MCPJam app is not installed
                on any account you administer. Install it first, then come back.
              </p>
              <Button
                variant="outline"
                onClick={() => appNavigate(SETTINGS_PATH)}
              >
                Back to GitHub Checks
              </Button>
            </div>
          ) : (
            <>
              <p className="px-4 pt-3 text-sm text-muted-foreground">
                These are the accounts you administer that already have the
                MCPJam app installed. Connecting one lets this workspace run
                checks on its repositories.
              </p>
              {phase.installations.map((installation) => (
                <div
                  key={installation.installationId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                  data-testid={`claimable-${installation.accountLogin}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Github
                      className="size-4 text-muted-foreground shrink-0"
                      aria-hidden
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium truncate">
                        {installation.accountLogin}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {installation.accountType === "Organization"
                          ? "Organization"
                          : "Personal account"}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={claiming !== null}
                    onClick={() =>
                      void handleClaim(phase.linkSessionId, installation)
                    }
                  >
                    Connect
                  </Button>
                </div>
              ))}
            </>
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageShell>
  );
}
