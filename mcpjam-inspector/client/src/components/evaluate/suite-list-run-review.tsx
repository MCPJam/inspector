import { useConvexAuth, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { buildHostNamesById } from "../evals/helpers";
import type { SuiteDetailsQueryResponse } from "../evals/types";
import { SuiteRunReview, type SuiteRunReviewProps } from "./suite-run-review";

/** Load run inputs without selecting a suite route. */
export function SuiteListRunReview(
  props: Omit<SuiteRunReviewProps, "cases" | "environments" | "hostNamesById">,
) {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const projectId = props.projectId ?? props.suite.projectId ?? null;
  const details = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    isAuthenticated && isUserReady ? { suiteId: props.suite._id } : "skip",
  ) as SuiteDetailsQueryResponse | undefined;
  const environments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const { hosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const loading =
    !details || Boolean(props.suite.environmentIds?.length && !environments);

  return (
    <SuiteRunReview
      {...props}
      key={loading ? "loading" : "ready"}
      projectId={projectId}
      cases={details?.testCases ?? []}
      environments={environments}
      hostNamesById={buildHostNamesById(props.suite.hostAttachments, hosts)}
      disabledReason={
        props.disabledReason ??
        (loading ? "Loading suite configuration…" : null)
      }
    />
  );
}
