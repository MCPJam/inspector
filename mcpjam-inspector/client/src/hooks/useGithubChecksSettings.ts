import { useCallback } from "react";
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

export type GithubCheckRepoConfigRow = {
  _id: string;
  repoFullName: string;
  enabled: boolean;
  organizationId: string;
  projectId: string;
  suiteId: string;
  createdAt: number;
  updatedAt: number;
};

export type InstallationRepo = { fullName: string };

export type SuiteOption = {
  _id: string;
  name: string;
  projectId?: string;
};

const AVAILABILITY_QUERY =
  "github/checkRepoConfigs:getGithubChecksSettingsAvailability";
const LIST_QUERY = "github/checkRepoConfigs:listForOrganization";
const SUITES_QUERY = "testSuites:getTestSuitesOverview";

/** The one message the UI shows when the backend refuses on availability. */
export const GITHUB_CHECKS_UNAVAILABLE_MESSAGE =
  "GitHub Checks settings are not currently available.";

export function useGithubChecksAvailability(
  organizationId: string | null | undefined
): GithubChecksAvailability {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isAuthenticated && isUserReady && organizationId);

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

  const connectRepoMutation = useMutation(
    "github/checkRepoConfigs:connectRepo" as any
  );
  const setRepoEnabledMutation = useMutation(
    "github/checkRepoConfigs:setRepoEnabled" as any
  );
  const setRepoSuiteMutation = useMutation(
    "github/checkRepoConfigs:setRepoSuite" as any
  );
  const disconnectRepoMutation = useMutation(
    "github/checkRepoConfigs:disconnectRepo" as any
  );
  const listInstallationReposAction = useAction(
    "github/checkRepoConfigsNode:listInstallationRepos" as any
  );

  const connectRepo = useCallback(
    (args: { repoFullName: string; projectId: string; suiteId: string }) =>
      connectRepoMutation({ organizationId, ...args } as any),
    [connectRepoMutation, organizationId]
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
    connectRepo,
    setRepoEnabled,
    setRepoSuite,
    disconnectRepo,
    listInstallationRepos,
  };
}
