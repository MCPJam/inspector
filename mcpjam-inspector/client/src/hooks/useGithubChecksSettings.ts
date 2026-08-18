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
  createdAt: number;
  updatedAt: number;
};

export type InstallationRepo = {
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
  const disconnectRepoMutation = useMutation(
    "github/checkRepoConfigs:disconnectRepo" as any
  );
  const listInstallationReposAction = useAction(
    "github/checkRepoConfigsNode:listInstallationRepos" as any
  );

  /**
   * `outagePolicy` is REQUIRED here even though the backend accepts it as
   * optional. Omitting it there means "no policy stored"; omitting it at
   * onboarding would mean the administrator was never asked, which is the state
   * this surface exists to stop producing.
   */
  const connectVerifiedRepo = useCallback(
    (args: {
      repoFullName: string;
      projectId: string;
      suiteId: string;
      outagePolicy: GithubCheckOutagePolicy;
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
    connectVerifiedRepo,
    setRepoEnabled,
    setRepoSuite,
    setRepoOutagePolicy,
    disconnectRepo,
    listInstallationRepos,
  };
}
