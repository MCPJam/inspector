import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import type { ModelDefinition } from "@/shared/types";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import { useEvalQueries } from "@/components/evals/use-eval-queries";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteRunListItem,
} from "@/components/evals/types";

export type SuiteSettingsPageData =
  | { status: "loading" }
  /** The suite's own query answered and the suite is not in the project. */
  | { status: "missing" }
  | {
      status: "ready";
      suite: EvalSuite;
      cases: EvalCase[];
      runs: EvalSuiteRunListItem[];
      /** Project suites in Suites-list order. */
      projectSuites: EvalSuite[];
      organizationId: string | null;
      availableModels: ModelDefinition[];
      requireOrgKeys?: boolean;
      onManageOrgProviders?: () => void;
      onAddProvider: (() => void) | null;
      canDeleteSuite: boolean;
    };

/** Everything the Suite settings page reads, from the existing eval hooks. */
export function useSuiteSettingsPageData({
  suiteId,
  projectId,
}: {
  suiteId: string;
  projectId: string | null;
}): SuiteSettingsPageData {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const context = useEvalTabContext({
    isAuthenticated,
    projectId,
    isDirectGuest,
  });
  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId: suiteId,
    deletingSuiteId: null,
    projectId,
    organizationId: null,
    isDirectGuest,
    perRunMetrics: true,
  });
  const projectSuites = useMemo(
    () => queries.sortedSuites.map((entry) => entry.suite),
    [queries.sortedSuites],
  );
  const suite = queries.selectedSuite;
  const cases = queries.suiteDetails?.testCases;

  if (
    authLoading ||
    queries.isOverviewLoading ||
    queries.isSuiteDetailsLoading
  ) {
    return { status: "loading" };
  }
  if (!suite) return { status: "missing" };
  if (!cases) return { status: "loading" };
  return {
    status: "ready",
    suite,
    cases,
    runs: queries.runsForSelectedSuite,
    projectSuites,
    organizationId: context.organizationId,
    availableModels: context.availableModels,
    requireOrgKeys: context.requireOrgKeys,
    onManageOrgProviders: context.onManageOrgProviders,
    onAddProvider: context.onAddProvider,
    canDeleteSuite: context.canDeleteArtifact(suite.createdBy),
  };
}
