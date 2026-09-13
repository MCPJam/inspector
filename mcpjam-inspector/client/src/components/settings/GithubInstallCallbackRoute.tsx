import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Github, Lock } from "lucide-react";
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
      installUrl?: string;
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
          // NOTHING TO PICK FROM, and that is an answer rather than a
          // failure: this GitHub user administers no account with the app on
          // it. Installing is the only move left, so make it, instead of
          // rendering a screen whose whole content is "go and install".
          //
          // This is what keeps a first-time user at the same number of clicks
          // they had when a settings-page button sent them straight to GitHub.
          if (result.installations.length === 0 && result.installUrl) {
            try {
              redirectToGithub(result.installUrl);
              return;
            } catch {
              // Same rule as the setup leg above: a refused redirect is not a
              // backend refusal and its developer text must never reach the
              // screen.
              console.error("[github-checks] refused an unsafe install URL");
              setPhase({
                kind: "failed",
                message: GITHUB_BINDING_FAILED_MESSAGE,
              });
              return;
            }
          }
          setPhase({
            kind: "pick",
            linkSessionId: result.linkSessionId,
            installations: result.installations,
            installUrl: result.installUrl,
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

  // Lifted out of the JSX because narrowing `phase.installUrl` inside a click
  // handler does not survive the closure; a const does.
  const installUrl = phase.kind === "pick" ? phase.installUrl : undefined;

  /**
   * Go to GitHub to install on an account that is not in the list.
   *
   * The URL is the backend's — it carries a one-time state for a second,
   * `pending_install` session — so this only follows what it was handed,
   * through the guard that refuses anything not on github.com. A refusal is a
   * bug on our side, not a backend refusal, and its developer text must never
   * reach the screen.
   *
   * KNOWN LIMITATION, and the reason this is worth reading: GitHub redirects
   * its install URL into an EXISTING installation whenever the signed-in user
   * administers one. So this button is not yet guaranteed to reach an account
   * chooser for a user who already has the app somewhere. No supported GitHub
   * URL fixes that; see `installUrlFor` in the backend for the matrix that has
   * to be run before this path can be trusted, and what to do if none passes.
   */
  const handleInstallElsewhere = (installUrl: string) => {
    try {
      redirectToGithub(installUrl);
    } catch {
      console.error("[github-checks] refused an unsafe install URL");
      setPhase({ kind: "failed", message: GITHUB_BINDING_FAILED_MESSAGE });
    }
  };

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
    <SettingsPageShell>
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
              {/* Reached ONLY against a backend too old to send `installUrl` —
                  a newer one turns an empty list straight into a redirect, up
                  in the OAuth leg. It is a guard for a late or rolled-back
                  deploy, not a supported state.

                  It still has to leave the person somewhere they can act,
                  though: the settings page no longer carries an install button
                  of its own, so telling them to "install it first" with no way
                  to do so would strand them. Name the page to go to. */}
              <p>
                You are signed in to GitHub, but the MCPJam app is not installed
                on any account you administer. Install it from the app&rsquo;s
                page on GitHub, then connect it here.
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
              {/* "organization", not "workspace": `workspaces` is a different
                  table entirely (a set of servers and a client config), and a
                  GitHub installation binds to an ORGANIZATION. Calling it a
                  workspace here reads as "one project", which is the wrong
                  mental model for a limit that is actually per-org. */}
              <p className="px-4 pt-3 text-sm text-muted-foreground">
                These are the accounts you administer that already have the
                MCPJam app installed. Connecting one lets this organization run
                checks on its repositories. To use an account that is not
                listed, install the app on it.
              </p>
              {phase.installations.map((installation) => {
                // Ties the disabled button to the reason it is disabled. The
                // note sits AFTER the button in the DOM, so without this a
                // screen reader reaches "Connect, unavailable" with no cause
                // — the one thing a blocked row exists to communicate.
                const conflictNoteId = `github-claim-conflict-${installation.installationId}`;
                return (
                <div
                  key={installation.installationId}
                  data-testid={`claimable-${installation.accountLogin}`}
                >
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Github
                        className="size-4 text-muted-foreground shrink-0"
                        aria-hidden
                      />
                      <div className="flex flex-col min-w-0">
                        <span
                          className={`text-sm font-medium truncate ${
                            installation.conflict ? "text-muted-foreground" : ""
                          }`}
                        >
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
                      // A conflicting row is disabled rather than hidden: the
                      // account IS one they administer, and hiding it would
                      // read as "GitHub lost it" rather than "it is taken".
                      disabled={
                        claiming !== null || Boolean(installation.conflict)
                      }
                      aria-describedby={
                        installation.conflict ? conflictNoteId : undefined
                      }
                      onClick={() =>
                        void handleClaim(phase.linkSessionId, installation)
                      }
                    >
                      Connect
                    </Button>
                  </div>
                  {installation.conflict ? (
                    <p
                      id={conflictNoteId}
                      className="flex items-start gap-2 px-4 pb-3 text-xs leading-relaxed text-muted-foreground"
                    >
                      <Lock
                        className="size-3.5 shrink-0 mt-0.5 text-destructive"
                        aria-hidden
                      />
                      {/* Two sentences, not one, because the second is the
                          only actionable half and must survive being skimmed.
                          The name is used when the backend gave one — its
                          absence means the caller may not see that org, so the
                          non-member copy names the party they CAN reach. */}
                      <span>
                        {installation.conflict.organizationName ? (
                          <>
                            Already connected to{" "}
                            <span className="font-medium text-foreground">
                              {installation.conflict.organizationName}
                            </span>
                            . Disconnect it there to use it here.
                          </>
                        ) : (
                          <>
                            Already connected to another MCPJam organization. An
                            owner of the {installation.accountLogin} GitHub
                            account can disconnect it there.
                          </>
                        )}
                      </span>
                    </p>
                  ) : null}
                </div>
                );
              })}
              {/* The only route to an account that is NOT in the list — which
                  the product had no way to reach at all before this. Rendered
                  only when the backend sent a URL; an older one simply shows
                  the list it can act on. */}
              {installUrl ? (
                <div className="px-4 pb-3 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleInstallElsewhere(installUrl)}
                  >
                    Install on another account
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageShell>
  );
}
