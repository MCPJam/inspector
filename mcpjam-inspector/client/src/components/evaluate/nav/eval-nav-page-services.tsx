/**
 * The actions and shared state a nav page takes from EvaluateTab.
 *
 * A page receives only its route and project (EvalNavPageProps). Runs,
 * deletes and the Setup Run sheet still live in EvaluateTab's handlers, so the
 * tab hands them down once through this context. The adapters live here, not
 * in the tab, and each field passes one existing handler or value through.
 * Fields may be added; none is renamed or removed.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { RemoteServer } from "@/hooks/useProjects";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { buildHostNamesById } from "@/components/evals/helpers";
import type {
  CaseRunLaunchOptions,
  EvalSuite,
  EvalSuiteRunListItem,
} from "@/components/evals/types";
import type { SuiteRunReviewProps } from "../suite-run-review";

type RunLaunch = { runIds: string[] } | undefined;
type LaunchReview = Omit<
  SuiteRunReviewProps,
  "cases" | "caseTitle" | "initialIterations" | "onClose" | "onStart"
>;

export interface EvalNavPageServices {
  /** handleRerunWithQuota(suite, { …opts, caseIds: [testCaseId] }); undefined when nothing launched. */
  runCase: (
    suite: EvalSuite,
    testCaseId: string,
    opts?: CaseRunLaunchOptions,
  ) => Promise<RunLaunch>;
  /** handleDeleteTestCasesBatch([id]) */
  deleteTestCase: (testCaseId: string) => Promise<void>;
  /** What SuiteRunReview needs besides the case. */
  launchReview: (suite: EvalSuite) => LaunchReview;
  evalRunsDisabledReason: string | null;
  isDirectGuest: boolean;
  projectServers: RemoteServer[];
  connectedServerNames: Set<string>;
  ensureServersReady: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  /** handleRerunWithQuota(suite, options) with no caseIds: a whole-suite run. */
  runSuite: (
    suite: EvalSuite,
    options: CaseRunLaunchOptions & { iterationOverride: number },
  ) => Promise<RunLaunch>;
  rerunningSuiteId: string | null;
  /** handlers.handleCancelRun: every run id of one launch. */
  cancelRun: (runIds: readonly string[]) => Promise<void>;
  cancellingRunId: string | null;
  /** handlers.directDeleteRun; absent when canDeleteRuns is false. */
  deleteRun?: (runId: string) => Promise<void>;
  /** canDeleteArtifact(run.createdBy) */
  canDeleteRun: (run: EvalSuiteRunListItem) => boolean;
  replayingRunId: string | null;
  runningTestCaseId: string | null;
  /** handlers.handleDuplicateSuite: "Duplicate to edit" for CI-locked suites. */
  duplicateSuite: (suite: EvalSuite) => void;
  /** handleOpenCreateSuite(), or handleEvalServer(server) when a server is passed. */
  openCreateSuite: (server?: RemoteServer) => void;
  /** null when the quickstart is not offered. */
  quickstart: { running: boolean; run: () => void } | null;
}

/** Where the Setup Run sheet reads environments and client names. */
export type EvalNavLaunchSources = {
  projectId: string | null;
  environments: SuiteRunReviewProps["environments"];
  hosts: Parameters<typeof buildHostNamesById>[1];
};

export interface EvalNavPageServiceDeps {
  rerunWithQuota: (
    suite: EvalSuite,
    options?: CaseRunLaunchOptions & { caseIds?: string[] },
  ) => Promise<RunLaunch>;
  deleteTestCasesBatch: (testCaseIds: string[]) => Promise<void>;
  handlers: {
    handleCancelRun: (runId: string | readonly string[]) => Promise<void>;
    directDeleteRun: (runId: string) => Promise<void>;
    handleDuplicateSuite: (suite: EvalSuite) => unknown;
    rerunningSuiteId: string | null;
    cancellingRunId: string | null;
    replayingRunId: string | null;
    runningTestCaseId: string | null;
  };
  canDeleteRuns: boolean;
  canDeleteArtifact: (createdBy: string | undefined) => boolean;
  evalRunsDisabledReason: string | null;
  isDirectGuest: boolean;
  projectServers: RemoteServer[];
  connectedServerNames: Set<string>;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  openCreateSuite: () => void;
  evalServer: (server: { id: string; name: string }) => void;
  showQuickstart: boolean;
  quickstartRunning: boolean;
  runQuickstart: () => void;
  launchSources: EvalNavLaunchSources;
}

/** Without a connect hook, a server is ready when it is already connected. */
function connectedOnly(connected: Set<string>) {
  return async (serverNames: string[]): Promise<EnsureServersReadyResult> => ({
    readyServerNames: serverNames.filter((name) => connected.has(name)),
    missingServerNames: serverNames.filter((name) => !connected.has(name)),
    failedServerNames: [],
    reauthServerNames: [],
  });
}

export function buildEvalNavPageServices(
  deps: EvalNavPageServiceDeps,
): EvalNavPageServices {
  const { handlers, launchSources } = deps;
  return {
    runCase: (suite, testCaseId, opts) => {
      const { suiteOverride, ...options } = opts ?? {};
      return deps.rerunWithQuota(suiteOverride ?? suite, {
        ...options,
        caseIds: [testCaseId],
      });
    },
    deleteTestCase: (testCaseId) => deps.deleteTestCasesBatch([testCaseId]),
    launchReview: (suite) => ({
      projectId: launchSources.projectId,
      suite,
      environments: launchSources.environments,
      hostNamesById: buildHostNamesById(
        suite.hostAttachments,
        launchSources.hosts,
      ),
      disabledReason:
        deps.evalRunsDisabledReason ??
        (handlers.rerunningSuiteId ? "A run is already starting." : null),
    }),
    evalRunsDisabledReason: deps.evalRunsDisabledReason,
    isDirectGuest: deps.isDirectGuest,
    projectServers: deps.projectServers,
    connectedServerNames: deps.connectedServerNames,
    ensureServersReady:
      deps.ensureServersReady ?? connectedOnly(deps.connectedServerNames),
    runSuite: (suite, options) => deps.rerunWithQuota(suite, options),
    rerunningSuiteId: handlers.rerunningSuiteId,
    cancelRun: (runIds) => handlers.handleCancelRun(runIds),
    cancellingRunId: handlers.cancellingRunId,
    ...(deps.canDeleteRuns ? { deleteRun: handlers.directDeleteRun } : {}),
    canDeleteRun: (run) => deps.canDeleteArtifact(run.createdBy),
    replayingRunId: handlers.replayingRunId,
    runningTestCaseId: handlers.runningTestCaseId,
    duplicateSuite: (suite) => {
      void handlers.handleDuplicateSuite(suite);
    },
    openCreateSuite: (server) =>
      server
        ? deps.evalServer({ id: server._id, name: server.name })
        : deps.openCreateSuite(),
    quickstart: deps.showQuickstart
      ? { running: deps.quickstartRunning, run: deps.runQuickstart }
      : null,
  };
}

/** The environments and client names the Setup Run sheet labels targets with. */
export function useEvalNavLaunchSources(
  projectId: string | null,
): EvalNavLaunchSources {
  const { isAuthenticated } = useConvexAuth();
  const environments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const { hosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  return useMemo(
    () => ({ projectId, environments, hosts }),
    [projectId, environments, hosts],
  );
}

const EvalNavPageServicesContext = createContext<EvalNavPageServices | null>(
  null,
);

export function EvalNavPageServicesProvider({
  value,
  children,
}: {
  value: EvalNavPageServices;
  children: ReactNode;
}) {
  return (
    <EvalNavPageServicesContext.Provider value={value}>
      {children}
    </EvalNavPageServicesContext.Provider>
  );
}

export function useEvalNavPageServices(): EvalNavPageServices {
  const services = useContext(EvalNavPageServicesContext);
  if (!services) {
    throw new Error(
      "useEvalNavPageServices must be used inside EvalNavPageServicesProvider (EvaluateTab renders it around nav pages).",
    );
  }
  return services;
}
