import { useCallback } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";

/**
 * GitHub Checks settings — data layer.
 *
 * **There is no client-side feature flag on this surface.** Availability is
 * decided by the backend and read through
 * `getGithubChecksSettingsAvailability`. That matters: the flag is evaluated
 * server-side against the org, and a client-side twin could disagree with it —
 * showing a page whose every write the server then refuses. One authority,
 * asked once.
 *
 * Function ids are strings because this app has no generated Convex client;
 * types below are hand-mirrored from `convex/github/checkRepoConfigs.ts`. Keep
 * them in sync by hand — nothing checks this at build time.
 *
 * **These hooks can throw, and every call site MUST sit inside an
 * `ErrorBoundary`.** `useQuery` re-throws query errors during render, and
 * ordinary cases produce one here: the backend function is not deployed yet
 * (the two repos release independently), or a caller is not a member of the org
 * they passed — the backend throws there deliberately, because answering
 * `disabled` would confirm the org exists. Guests never ask: GitHub Checks is
 * member-only, so the availability read is skipped when there is no WorkOS
 * user even though the guest session is Convex-authenticated.
 *
 * The boundary is not optional and not defence in depth: a call in a component
 * that is not itself inside one takes that component's whole page down. That is
 * not hypothetical — the suite settings sheet shipped an unguarded call and
 * crashed `/evals` for every user the backend refused. Call sites:
 * `IntegrationsRoute`, `GithubChecksRoute`, and
 * `SuiteGithubChecksSettingsSection` in `suite-iterations-view`.
 *
 * A membership refusal arrives as a `ConvexError` tagged `kind: 'forbidden'`,
 * which `reportCaught` drops. The not-yet-deployed case stays a plain throw and
 * still reports, which is also right: that one means the two repos drifted.
 */

/**
 * `'enabled' | 'disabled'` once resolved; `undefined` while loading or while
 * the query is skipped.
 *
 * The tri-state is load-bearing. `disabled` means the backend said no;
 * `undefined` means we have not asked yet. Treating the second as the first
 * would bounce a legitimately-flagged user who cold-loads the URL directly.
 */
export type GithubChecksAvailability =
  | { state: "enabled" | "disabled" }
  | undefined;

/**
 * What the check concludes when MCPJam cannot run the suite — an outage, or a
 * paused row.
 *
 * `fail_open` concludes `neutral`, `fail_closed` concludes `failure`. MCPJam
 * decides the CONCLUSION and nothing else: whether either one stops a merge is
 * branch protection's answer, which lives in GitHub and which this app can
 * neither read nor set. Copy on this surface must never promise a merge result.
 */
export type GithubCheckOutagePolicy = "fail_open" | "fail_closed";

/**
 * How ready a connected repository actually is, DERIVED BY THE BACKEND.
 *
 * Never inferred here, and in particular never inferred from a missing
 * visibility badge: visibility is a live GitHub fact and absence there means
 * "we do not know", not "something is wrong". The three facts this summarizes —
 * a server-verified repository identity, an active org ↔ installation binding,
 * and per-repository access — are deliberately not shipped to the browser, so
 * this literal is the only thing there is to render.
 *
 *   verified                  — connected, proved, installation live.
 *   legacy_unverified         — no verified repository identity. Reconnect
 *                               required before enforcement.
 *   installation_inactive     — the binding is suspended, removed, unbound, or
 *                               absent. Nothing about the repository is wrong.
 *   repository_access_removed — the App no longer has THIS repository.
 */
export type GithubCheckConnectionStatus =
  | "verified"
  | "legacy_unverified"
  | "installation_inactive"
  | "repository_access_removed";

export type GithubInstallationAccountType = "Organization" | "User";
export type GithubInstallationBindingStatus =
  | "active"
  | "suspended"
  | "removed"
  | "unbound";

/**
 * One GitHub App installation this organization holds.
 *
 * `installationRef` is an OPAQUE Convex row id, never GitHub's installation id.
 * It is what selects an installation for a connect or an unbind, and it is
 * deliberately meaningless outside this backend.
 */
export type GithubInstallationBinding = {
  installationRef: string;
  accountLogin: string;
  accountType: GithubInstallationAccountType;
  status: GithubInstallationBindingStatus;
  boundAt: number;
  statusChangedAt: number;
};

/** One installation a direct-install claim may adopt, from the proven list. */
export type ClaimableInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: GithubInstallationAccountType;
};

/**
 * What the OAuth callback resolved to: a completed bind, or a pick.
 *
 * The pick arm carries `linkSessionId` back to the browser, which is safe by
 * design rather than by obscurity — the claim re-checks that the actor is the
 * one who started the flow, that the session is unexpired, and that the chosen
 * installation is in the server-held proven list.
 */
export type GithubInstallCallbackResult =
  | { status: "bound"; accountLogin: string }
  | {
      status: "pick_required";
      linkSessionId: string;
      installations: ClaimableInstallation[];
    };

export type GithubCheckRepoConfigRow = {
  _id: string;
  repoFullName: string;
  enabled: boolean;
  organizationId: string;
  projectId: string;
  suiteId: string;
  /**
   * Absent on rows connected before the policy existed. Absent is NOT
   * `fail_open`: the backend treats it as fail-open at conclusion time, but
   * nobody chose it, and the settings page says exactly that rather than
   * rendering a choice that was never stored.
   */
  outagePolicy?: GithubCheckOutagePolicy;
  /** Backend-derived. See {@link GithubCheckConnectionStatus}. */
  connectionStatus: GithubCheckConnectionStatus;
  /**
   * Dual-check. Absent/false on existing rows so enabling GitHub Checks does
   * not silently add a required MCPJam Conformance check.
   */
  conformanceEnabled?: boolean;
  conformanceSuiteKinds?: Array<"protocol" | "apps" | "tasks" | "oauth">;
  createdAt: number;
  updatedAt: number;
};

export type InstallationRepo = {
  /**
   * GitHub's numeric repository id — the identity connect is keyed on.
   *
   * A repository can be renamed and the freed name re-taken, so `fullName` is
   * display and routing data. This is sent back at connect and the server
   * re-verifies it against GitHub's own response.
   */
  repositoryId: number;
  /**
   * WHICH binding this repository was listed through, opaque.
   *
   * ABSENT only while the backend is still falling back to its pinned
   * installation for an organization with no binding yet. Absent means "send no
   * reference", which is what keeps the compatibility connect reachable during
   * that window.
   */
  installationRef?: string;
  /**
   * The GitHub account, for disambiguating two same-named repositories from
   * different accounts in one picker. Display only.
   */
  accountLogin?: string;
  fullName: string;
  /**
   * GitHub's live `private` flag. Optional because GitHub can omit it, and
   * never persisted anywhere — visibility can change under a connected
   * repository at any time. Absent means UNKNOWN, and the UI shows no badge
   * rather than asserting "public".
   */
  private?: boolean;
};

export type SuiteOption = {
  _id: string;
  name: string;
  projectId?: string;
};

const AVAILABILITY_QUERY =
  "github/checkRepoConfigs:getGithubChecksSettingsAvailability";
const LIST_QUERY = "github/checkRepoConfigs:listForOrganization";
const SUITES_QUERY = "testSuites:getTestSuitesOverview";
const BINDINGS_QUERY = "github/appInstallLink:listBindingsForOrganization";

// The availability message and the rest of this surface's error copy live in
// `@/lib/github-checks-errors`, which has no React and no Convex client in it.
// Both components that show these messages stub THIS module wholesale in their
// tests, so a message defined here would be stubbed out in exactly the tests
// that ought to be checking it.

export function useGithubChecksAvailability(
  organizationId: string | null | undefined
): GithubChecksAvailability {
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(
    isAuthenticated && user && isUserReady && organizationId
  );

  return useQuery(
    AVAILABILITY_QUERY as any,
    canQuery ? ({ organizationId } as any) : "skip"
  ) as GithubChecksAvailability;
}

export function useGithubChecksSettings(
  organizationId: string | null | undefined
) {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();

  const availability = useGithubChecksAvailability(organizationId);
  const isEnabled = availability?.state === "enabled";

  // The list and the suite picker are only fetched once availability says
  // `enabled`. Asking earlier would fire two queries the backend answers with
  // an empty list anyway, and would make the page flash content it may not be
  // allowed to show.
  const canQuery = Boolean(
    isAuthenticated && isUserReady && organizationId && isEnabled
  );

  const repos = useQuery(
    LIST_QUERY as any,
    canQuery ? ({ organizationId } as any) : "skip"
  ) as GithubCheckRepoConfigRow[] | undefined;

  // `getTestSuitesOverview` accepts an org scope. Note it filters on
  // `suite.organizationId`, which is optional on legacy rows — a suite created
  // before that field existed will not appear here.
  const suiteOverview = useQuery(
    SUITES_QUERY as any,
    canQuery ? ({ organizationId } as any) : "skip"
  ) as Array<{ suite?: SuiteOption }> | undefined;

  const suites: SuiteOption[] | undefined = suiteOverview
    ?.map((entry) => entry.suite)
    .filter((suite): suite is SuiteOption => Boolean(suite?._id));

  // The SERVER-VERIFIED connect, and the only connect path this app uses. It is
  // an action rather than a mutation because proving the pinned installation can
  // actually reach the repository takes a GitHub round trip, which a mutation
  // cannot make — and it is the action that stamps the row's installation id.
  // The unverified `checkRepoConfigs:connectRepo` mutation survives only for the
  // two-deploy compatibility window and must not be called from here.
  const connectVerifiedRepoAction = useAction(
    "github/checkRepoConfigsNode:connectVerifiedRepo" as any
  );
  const setRepoEnabledMutation = useMutation(
    "github/checkRepoConfigs:setRepoEnabled" as any
  );
  const setRepoSuiteMutation = useMutation(
    "github/checkRepoConfigs:setRepoSuite" as any
  );
  const setRepoOutagePolicyMutation = useMutation(
    "github/checkRepoConfigs:setRepoOutagePolicy" as any
  );
  const setRepoConformanceMutation = useMutation(
    "github/checkRepoConfigs:setRepoConformance" as any
  );
  const disconnectRepoMutation = useMutation(
    "github/checkRepoConfigs:disconnectRepo" as any
  );
  const listInstallationReposAction = useAction(
    "github/checkRepoConfigsNode:listInstallationRepos" as any
  );

  // ── The org ↔ installation binding surface ───────────────────────────────
  //
  // EVERY ARGUMENT BELOW IS HAND-MIRRORED from `convex/github/appInstallLink.ts`
  // and `appInstallLinkNode.ts`. There is no generated client here, so a name
  // that drifts or a required argument that is forgotten fails at RUNTIME, on
  // the click, in production — not at build time. Treat these call shapes as
  // part of the backend's signature and change them together.
  const startInstallationAction = useAction(
    "github/appInstallLinkNode:startInstallation" as any
  );
  const startDirectClaimAction = useAction(
    "github/appInstallLinkNode:startDirectClaim" as any
  );
  const unbindInstallationMutation = useMutation(
    "github/appInstallLink:unbindInstallation" as any
  );

  // Bindings are read for MEMBERS, like the repository list — the write path is
  // where admin is required — so this rides the same `canQuery` gate.
  const bindings = useQuery(
    BINDINGS_QUERY as any,
    canQuery ? ({ organizationId } as any) : "skip"
  ) as GithubInstallationBinding[] | undefined;

  /**
   * Begin installing the App for this organization. Returns GitHub's install
   * URL; the caller navigates to it.
   *
   * The URL carries a one-time state whose HASH is what the backend stored, so
   * it is not a credential the browser has to protect beyond the session's
   * ten-minute life.
   */
  const startInstallation = useCallback(
    () =>
      startInstallationAction({ organizationId } as any) as Promise<{
        installUrl: string;
      }>,
    [startInstallationAction, organizationId]
  );

  /**
   * Begin CLAIMING an installation somebody created from GitHub's side, where
   * there was never a setup redirect for us to catch. Goes straight to the
   * OAuth leg; the pick comes back from the callback.
   */
  const startDirectClaim = useCallback(
    () =>
      startDirectClaimAction({ organizationId } as any) as Promise<{
        authorizeUrl: string;
      }>,
    [startDirectClaimAction, organizationId]
  );

  const unbindInstallation = useCallback(
    (args: { installationRef: string }) =>
      unbindInstallationMutation({
        organizationId,
        ...args,
      } as any) as Promise<{
        changed: boolean;
      }>,
    [unbindInstallationMutation, organizationId]
  );

  /**
   * `outagePolicy` is REQUIRED here even though the backend accepts it as
   * optional. Omitting it there means "no policy stored"; omitting it at
   * onboarding would mean the administrator was never asked, which is the state
   * this surface exists to stop producing.
   *
   * `installationRef` and `repositoryId` come STRAIGHT OFF the picked
   * `InstallationRepo` and are never assembled by hand — they say which
   * installation the repository was listed through and which repository it
   * actually is, and the server re-verifies both. They are optional here for
   * exactly one reason: an organization with no binding yet is still listed
   * through the backend's pinned installation, and those entries carry no ref,
   * so the connect has to be reachable without one until the pin retires.
   */
  const connectVerifiedRepo = useCallback(
    (args: {
      repoFullName: string;
      projectId: string;
      suiteId: string;
      outagePolicy: GithubCheckOutagePolicy;
      installationRef?: string;
      repositoryId?: number;
    }) =>
      connectVerifiedRepoAction({ organizationId, ...args } as any) as Promise<{
        configId: string;
      }>,
    [connectVerifiedRepoAction, organizationId]
  );

  const setRepoEnabled = useCallback(
    (args: { configId: string; enabled: boolean }) =>
      setRepoEnabledMutation({ organizationId, ...args } as any),
    [setRepoEnabledMutation, organizationId]
  );

  const setRepoSuite = useCallback(
    (args: { configId: string; projectId: string; suiteId: string }) =>
      setRepoSuiteMutation({ organizationId, ...args } as any),
    [setRepoSuiteMutation, organizationId]
  );

  const setRepoOutagePolicy = useCallback(
    (args: { configId: string; outagePolicy: GithubCheckOutagePolicy }) =>
      setRepoOutagePolicyMutation({
        organizationId,
        ...args,
      } as any) as Promise<{
        changed: boolean;
      }>,
    [setRepoOutagePolicyMutation, organizationId]
  );

  const setRepoConformance = useCallback(
    (args: {
      configId: string;
      conformanceEnabled: boolean;
      conformanceSuiteKinds?: Array<"protocol" | "apps" | "tasks" | "oauth">;
    }) =>
      setRepoConformanceMutation({
        organizationId,
        ...args,
      } as any) as Promise<{
        changed: boolean;
      }>,
    [setRepoConformanceMutation, organizationId]
  );

  const disconnectRepo = useCallback(
    (args: { configId: string }) =>
      disconnectRepoMutation({ organizationId, ...args } as any),
    [disconnectRepoMutation, organizationId]
  );

  const listInstallationRepos = useCallback(
    () =>
      listInstallationReposAction({ organizationId } as any) as Promise<
        InstallationRepo[]
      >,
    [listInstallationReposAction, organizationId]
  );

  return {
    availability,
    isEnabled,
    repos,
    suites,
    bindings,
    connectVerifiedRepo,
    setRepoEnabled,
    setRepoSuite,
    setRepoOutagePolicy,
    setRepoConformance,
    disconnectRepo,
    listInstallationRepos,
    startInstallation,
    startDirectClaim,
    unbindInstallation,
  };
}

/**
 * The two GitHub callbacks, as their own hook.
 *
 * SEPARATE from `useGithubChecksSettings` because the callback page has no
 * organization to hand it: the browser arrives back from GitHub with nothing but
 * query parameters, and the organization is recovered from the link session
 * server-side. A hook that required an org id would have to invent one.
 *
 * Both actions take the parameters GitHub sent, VERBATIM. Nothing is parsed,
 * normalized, or validated here — the backend matches the state by hash and
 * treats the installation id as an unproven claim, and any cleverness in the
 * browser could only ever turn a refusal into a different refusal.
 */
export function useGithubInstallCallbacks() {
  const completeInstallSetupAction = useAction(
    "github/appInstallLinkNode:completeInstallSetup" as any
  );
  const completeUserAuthorizationAction = useAction(
    "github/appInstallLinkNode:completeUserAuthorization" as any
  );
  const claimProvenInstallationAction = useAction(
    "github/appInstallLinkNode:claimProvenInstallation" as any
  );

  /** GitHub's setup redirect. Returns where to send the browser next. */
  const completeInstallSetup = useCallback(
    (args: { installationId: number; state: string }) =>
      completeInstallSetupAction(args as any) as Promise<{
        authorizeUrl: string;
      }>,
    [completeInstallSetupAction]
  );

  /** GitHub's OAuth redirect. Either the bind is done, or a pick is needed. */
  const completeUserAuthorization = useCallback(
    (args: { code: string; state: string }) =>
      completeUserAuthorizationAction(
        args as any
      ) as Promise<GithubInstallCallbackResult>,
    [completeUserAuthorizationAction]
  );

  /** Adopt one installation out of a direct claim's proven list. */
  const claimProvenInstallation = useCallback(
    (args: { linkSessionId: string; installationId: number }) =>
      claimProvenInstallationAction(
        args as any
      ) as Promise<GithubInstallCallbackResult>,
    [claimProvenInstallationAction]
  );

  return {
    completeInstallSetup,
    completeUserAuthorization,
    claimProvenInstallation,
  };
}
