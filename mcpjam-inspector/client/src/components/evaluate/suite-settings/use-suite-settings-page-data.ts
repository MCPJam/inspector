import { useCallback, useMemo } from "react";
import { useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import { makeFunctionReference, type PaginationOptions } from "convex/server";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { useAppRouteContext } from "@/lib/app-route-context";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import { track } from "@/lib/analytics";
import { useEvalMutations } from "../../evals/use-eval-mutations";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { suiteGenerateState } from "./suite-generate-state";

const RUN_PAGE_SIZE = 20;

const suiteQuery = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalSuite | null
>("testSuites:getTestSuite");
const casesQuery = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalCase[]
>("testSuites:listTestCases");
const runSummariesQuery = makeFunctionReference<
  "query",
  { suiteId: string; paginationOpts: PaginationOptions },
  { page: EvalSuiteRunListItem[]; isDone: boolean; continueCursor: string }
>("testSuites:listTestSuiteRunSummaries");

/**
 * What the Suite settings page reads, loaded by the page itself: it renders
 * in place of the Evaluate tab, so nothing is handed down to it.
 */
export function useSuiteSettingsPageData(suiteId: string) {
  const routeContext = useAppRouteContext();
  const projectId: string | null = routeContext.convexProjectId ?? null;
  const canConnectServers = Boolean(routeContext.ensureServersReady);
  const { isAuthenticated } = useConvexAuth();
  const canQuery = useActorCanQuery();
  const suite = useQuery(suiteQuery, canQuery ? { suiteId } : "skip");
  const cases = useQuery(casesQuery, canQuery ? { suiteId } : "skip");
  const { results: runs } = usePaginatedQuery(
    runSummariesQuery,
    canQuery ? { suiteId } : "skip",
    { initialNumItems: RUN_PAGE_SIZE },
  );
  const evalContext = useEvalTabContext({ isAuthenticated, projectId });
  const capabilities = useSuiteCapabilities(
    suiteId,
    suite?.revisionNumber ?? "none",
  );
  const configLocked = Boolean(
    (suite && isCiOwnedSuite(suite)) ||
    (capabilities.state === "ready" &&
      capabilities.capabilities.ownership?.ciOwned === true),
  );
  const generateState = useMemo(
    () =>
      suite
        ? suiteGenerateState(
            suite,
            evalContext.connectedServerNames,
            canConnectServers,
          )
        : null,
    [suite, evalContext.connectedServerNames, canConnectServers],
  );

  const { deleteTestCaseMutation } = useEvalMutations();
  /** Resolves only when every case is gone, so callers can report the outcome. */
  const deleteTestCases = useCallback(
    async (testCaseIds: string[]) => {
      const results = await Promise.allSettled(
        testCaseIds.map(async (testCaseId) => {
          await deleteTestCaseMutation({ testCaseId });
          track("eval_test_case_deleted", {
            location: "evaluate_suite_settings",
            suite_id: suiteId,
            test_case_id: testCaseId,
          });
        }),
      );
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        throw new Error(
          `Failed to delete ${failed.length} test case${failed.length === 1 ? "" : "s"}.`,
        );
      }
    },
    [deleteTestCaseMutation, suiteId],
  );

  return {
    projectId,
    suite,
    cases,
    runs,
    capabilities,
    configLocked,
    generateState,
    deleteTestCases,
    evalContext,
  };
}

export type SuiteSettingsPageData = ReturnType<typeof useSuiteSettingsPageData>;
