/**
 * The runtime of every client an eval suite runs on, for a model picker whose
 * models apply to the whole suite (a generated draft's model override).
 *
 * A suite runs on its attached clients, or, for an environment suite, on its
 * environments' clients. Each client's runtime comes from
 * `useHostHarnessTargets`, so a model every client refuses renders disabled,
 * the same rule the composer's shared model axis uses.
 */
import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useHostHarnessTargets } from "@/hooks/use-host-harness-targets";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import type { HarnessModelTarget } from "@/lib/harness-model-locks";

type SuiteClients = {
  environmentIds?: string[];
  hostAttachments?: { namedHostId: string }[];
};

const getTestSuiteQuery = makeFunctionReference<
  "query",
  { suiteId: string },
  SuiteClients | null
>("testSuites:getTestSuite");

/** The client ids a suite runs on, from its attachments or environments. */
export function suiteClientHostIds(
  suite: SuiteClients | null | undefined,
  environments: readonly { environmentId: string; hostId?: string }[] = [],
): string[] {
  if (!suite) return [];
  const ids = suite.environmentIds?.length
    ? suite.environmentIds.map(
        (id) => environments.find((env) => env.environmentId === id)?.hostId,
      )
    : (suite.hostAttachments ?? []).map((host) => host.namedHostId);
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

export function useSuiteHarnessTargets(
  projectId: string,
  suiteId: string,
): ReadonlyArray<HarnessModelTarget | null | undefined> {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const suite = useQuery(
    getTestSuiteQuery,
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId) && suiteId
      ? { suiteId }
      : "skip",
  );
  const environments = useProjectEnvironments(
    suite?.environmentIds?.length ? projectId : null,
    { includeAdhoc: true },
  );
  const hostIds = useMemo(
    () => suiteClientHostIds(suite, environments),
    [suite, environments],
  );
  const byHost = useHostHarnessTargets(hostIds);
  return useMemo(
    () => hostIds.map((hostId) => byHost[hostId]),
    [hostIds, byHost],
  );
}
