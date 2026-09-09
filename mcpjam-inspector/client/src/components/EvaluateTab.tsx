import { normalizeGeneratedDraft } from "@/lib/evals/normalize-generated-draft";
import { evalChatSuiteContext } from "@/lib/mcpjam-agent/eval-chat-context";
import { syncEvalChatContext } from "@/lib/mcpjam-agent/eval-scope";
import { registerEvalSuite } from "@/lib/mcpjam-agent/eval-workspace";
import { EvalAgentWorkspace } from "./evaluate/eval-agent-workspace";
import type { GenerationOptions } from "@/lib/apis/evals-api";
import type { CreateEvalTestCaseInput } from "@/lib/evals/generate-and-persist-tests";
/**
 * Evaluate (New) — the redesigned Evaluate tab, behind `evaluate-enabled`.
 *
 * A DELIBERATE fork of `EvalsTab.tsx`, not a refactor of it. The same redesign
 * has been merged into the live tab and reverted twice (#4319/#4320,
 * #4344/#4363); shipping it as a second tab means a problem here cannot reach
 * anyone who has not opted in. Only the screens the redesign actually rewrote
 * are duplicated (`components/evaluate/`) — the queries, mutations, handlers,
 * run detail, and case editors are still the shared `components/evals/`
 * modules, so eval behaviour cannot drift between the two tabs.
 *
 * Differences from `EvalsTab`:
 * - the landing is a suites table with a Runs view, not a redirect into the
 *   most recently run suite;
 * - create-suite is a full page at `/evaluate/create`, not a dialog;
 * - suite overview is `SuiteDetailOverview` (identity + run history + cases);
 * - there is no Runs lens — the commit-keyed CI review stays on `/evals/runs`.
 *
 * It bridges as `surfaceId: "evals"` on purpose: the two tabs are never mounted
 * at once, so the agent keeps one set of eval tools over one set of suites.
 *
 * When the redesign wins, this file becomes `EvalsTab.tsx` and the original,
 * `components/evaluate/`, and the `suiteDetailOverview` prop on
 * `SuiteIterationsView` all go away together.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvex, useConvexAuth, useMutation } from "convex/react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { EvalsEmptyHero } from "./evaluate/evals-empty-hero";
import { PreparedEvalServerPage } from "./evaluate/prepared-eval-server-page";
import { savePreparedEvalSuites } from "./evaluate/launch-prepared-evals";
import { previewCaseTitleFromDraft } from "./evaluate/eval-server-case-edit-page";
import {
  runExcalidrawQuickstart,
  EXCALIDRAW_QUICKSTART_SUITE_NAME,
} from "@/lib/evals/excalidraw-quickstart";
import {
  loadGenerateConfig,
  toGenerationOptions,
  totalCases,
} from "@/lib/evals/eval-generation-config";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import { isQuickstartSuite } from "./evals/constants";
import type { ServerFormData } from "@/shared/types.js";
import { useProjectServers } from "@/hooks/useViews";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useEvaluateRouteFromUrl } from "@/lib/eval-route-url";
import { useEvalTabContext } from "@/hooks/use-eval-tab-context";
import { useEvaluateEnabled } from "@/hooks/useEvaluateEnabled";
import { useObserveFirstEnabled } from "@/hooks/useObserveFirstEnabled";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import {
  aggregateSuite,
  formatRunId,
  getEffectiveSuiteServers,
} from "./evals/helpers";
import { EvalTabGate } from "./evals/EvalTabGate";
import { EvalsHeader, type EvalLandingView } from "./evaluate/evals-header";
import {
  createPlaygroundSuiteNavigation,
  navigatePlaygroundEvalsRoute,
} from "./evaluate/create-suite-navigation";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { LaunchedCaseJudge } from "./evaluate/case-scorecard/launched-case-judge";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { SuitesOverview } from "./evaluate/suites-overview";
import { SuiteListRunReview } from "./evaluate/suite-list-run-review";
import { ProjectRunsTable } from "./evals/project-runs-table";
import { stripTimestampSuffix } from "./evals/suite-overview-presentation";
import { draftTestCaseId, isDraftTestCaseId } from "./evals/draft-test-case";
import {
  CreateSuitePage,
  type CreateSuitePayload,
} from "./evaluate/create-suite-page";
import { getEvalIterationQuotaDisabledReason } from "@/lib/eval-iteration-quota";
import { usePlanLimitDialogStore } from "@/stores/plan-limit-dialog-store";
import { track } from "@/lib/analytics";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  CancelEvalRunInspectorCommand,
  DeleteEvalSuiteInspectorCommand,
  GenerateEvalTestsInspectorCommand,
  OpenEvalSuiteFormInspectorCommand,
  RunEvalSuiteInspectorCommand,
} from "@/shared/inspector-command.js";
import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "./evals/types";
import {
  CI_OWNED_REASON_COPY,
  isCiOwnedSuite,
} from "@/lib/evals/is-ci-owned-suite";

/** Cap the agent snapshot's suite list — state overview, not a data dump. */
const AGENT_SNAPSHOT_MAX_SUITES = 30;

interface EvaluateTabProps {
  projectId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  ensureServersReady?: (
    serverNames: string[],
    options?: { allowInteractiveOAuthFlow?: boolean },
  ) => Promise<EnsureServersReadyResult>;
  handleConnect?: (config: ServerFormData) => void;
}

export function EvaluateTab({
  projectId,
  onContinueInChat,
  ensureServersReady,
  handleConnect,
}: EvaluateTabProps) {
  const { isAuthenticated } = useConvexAuth();

  return (
    <ErrorBoundary
      key={`${projectId ?? "none"}:${isAuthenticated ? "authed" : "guest"}`}
      fallback={({ error, reset }) => (
        <EvalTabErrorFallback error={error} onRetry={reset} />
      )}
    >
      <EvaluateTabContent
        projectId={projectId}
        onContinueInChat={onContinueInChat}
        ensureServersReady={ensureServersReady}
        handleConnect={handleConnect}
      />
    </ErrorBoundary>
  );
}

function EvalTabErrorFallback({
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <div className="p-6">
      <EmptyState
        icon={FlaskConical}
        title="Could not load Testing"
        description="Something went wrong while loading suites. Try again in a moment."
        className="h-[calc(100vh-200px)]"
      >
        <Button type="button" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </EmptyState>
    </div>
  );
}

function EvaluateTabContent({
  projectId,
  onContinueInChat,
  ensureServersReady,
  handleConnect,
}: EvaluateTabProps) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  // create-suite-page uses `hostsEnabled` as both a feature gate AND a
  // "skeleton suite creation requires attachments" gate (attachmentsRequired
  // = hostsEnabled && projectId), so it stays auth-gated rather than
  // unconditionally on.
  const hostsEnabled = isAuthenticated;
  // The canonical run decision summary is part of the Evaluate redesign, so
  // it rides `evaluate-enabled` rather than a second flag. Resolved HERE and
  // threaded down: every surface that reads it takes the answer as a prop and
  // is off by default, so a flag-off render issues zero summary requests even
  // though those components are shared with `/evals`.
  const decisionSummaryEnabled = useEvaluateEnabled();
  const observeFirstEnabled = useObserveFirstEnabled();
  const route = useEvaluateRouteFromUrl();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const [previewedHostId] = usePreviewedHostId(projectId ?? null);
  const {
    organizationId,
    connectedServerNames,
    userMap,
    canDeleteArtifact,
    canDeleteRuns,
    availableModels,
  } = useEvalTabContext({
    isAuthenticated,
    projectId: projectId ?? null,
    isDirectGuest,
  });
  const { quota: evalIterationQuota } = useEvalIterationQuota({
    organizationId,
    enabled: Boolean(organizationId),
  });
  const evalRunsDisabledReason = useMemo(
    () => getEvalIterationQuotaDisabledReason(evalIterationQuota),
    [evalIterationQuota],
  );
  const { servers: projectServers = [], isLoading: isProjectServersLoading } =
    useProjectServers({
      isAuthenticated,
      projectId: projectId ?? null,
    });
  const mutations = useEvalMutations({ isDirectGuest });
  const convex = useConvex();
  const createServerAttachmentMutation = useMutation(
    "serverAttachments:createServerAttachment" as any,
  ) as unknown as (args: {
    projectId: string;
    name: string;
    serverIds: string[];
  }) => Promise<{ _id: string }>;
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as any,
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[] | null;
  }) => Promise<unknown>;

  // Prepared cases belong to the server review draft, not persisted test suites.
  const isPreparedCaseEdit =
    route.type === "test-edit" && Boolean(route.fromEvalServer);
  const selectedSuiteId = isPreparedCaseEdit
    ? null
    : route.type === "suite-overview" ||
        route.type === "run-detail" ||
        route.type === "test-detail" ||
        route.type === "test-edit" ||
        route.type === "suite-edit"
      ? route.suiteId
      : null;
  const selectedTestId = isPreparedCaseEdit
    ? null
    : route.type === "test-detail" || route.type === "test-edit"
      ? route.testId
      : null;

  const overviewQueries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId: null,
    deletingSuiteId: null,
    projectId: projectId ?? null,
    organizationId: null,
    isDirectGuest,
  });

  // All suites are visible in Evaluate regardless of origin (ui or sdk/CI).
  // SDK-created suites get a CI badge in the switcher instead of being hidden.
  const visibleSuites = overviewQueries.sortedSuites;

  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId) {
      return null;
    }
    return (
      visibleSuites.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, visibleSuites]);

  const latestRunBySuiteId = useMemo(
    () =>
      new Map(
        visibleSuites.map((entry) => [
          entry.suite._id,
          entry.latestRun ?? null,
        ]),
      ),
    [visibleSuites],
  );

  const handlers = useEvalHandlers({
    mutations,
    selectedSuiteEntry,
    selectedSuiteId,
    selectedTestId,
    projectId: projectId ?? null,
    organizationId,
    connectedServerNames,
    ensureServersReady,
    latestRunBySuiteId,
    // Shared handlers default to `/evals`. Without this, Add case / Record /
    // post-run landing would dump the reader onto the old tab.
    evalsNavigationContext: "evaluate",
    projectServers,
    isDirectGuest,
    availableModels,
  });
  const {
    deletingSuiteId,
    rerunningSuiteId,
    cancellingRunId,
    deletingRunId,
    directDeleteTestCase,
  } = handlers;

  const guardEvalIterationQuota = useCallback(() => {
    if (!evalRunsDisabledReason) {
      return true;
    }
    // The user just clicked Run — highest-intent moment there is. Give them a
    // decision surface instead of a dismissible error. Falls back to the
    // toast when we can't resolve the org (nothing to upgrade).
    if (organizationId && evalIterationQuota) {
      usePlanLimitDialogStore.getState().open({
        kind: "evalIterations",
        organizationId,
        used: evalIterationQuota.used,
        allowed: evalIterationQuota.allowed,
        resetsAt: evalIterationQuota.resetsAt,
        windowKind: evalIterationQuota.windowKind,
        origin: "evals",
      });
      return false;
    }
    toast.error(evalRunsDisabledReason);
    return false;
  }, [evalIterationQuota, evalRunsDisabledReason, organizationId]);

  const [judgeRunIds, setJudgeRunIds] = useState<string[]>([]);
  const handleRerunWithQuota = useCallback(
    async (...args: Parameters<typeof handlers.handleRerun>) => {
      if (!guardEvalIterationQuota()) {
        return;
      }
      const launch = await handlers.handleRerun(...args);
      if (
        args[1]?.caseIds?.length &&
        !args[1]?.skipJudge &&
        launch?.runIds.length
      ) {
        setJudgeRunIds((current) => [
          ...new Set([...current, ...launch.runIds]),
        ]);
      }
      return launch;
    },
    [guardEvalIterationQuota, handlers],
  );

  const handleRunTestCaseWithQuota = useCallback(
    (...args: Parameters<typeof handlers.handleRunTestCase>) => {
      if (!guardEvalIterationQuota()) {
        return Promise.resolve(null);
      }
      return handlers.handleRunTestCase(...args);
    },
    [guardEvalIterationQuota, handlers],
  );

  const queries = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId,
    deletingSuiteId,
    projectId: projectId ?? null,
    organizationId: null,
    isDirectGuest,
  });

  const selectedSuite = queries.selectedSuite;
  const suiteDetails = queries.suiteDetails;
  const activeIterations = queries.activeIterations;
  const sortedIterations = queries.sortedIterations;
  const runsForSelectedSuite = queries.runsForSelectedSuite;

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      activeIterations,
    );
  }, [selectedSuite, suiteDetails, activeIterations]);
  const playgroundNavigation = useMemo(
    () => createPlaygroundSuiteNavigation(),
    [],
  );

  useEffect(() => {
    if (
      route.type === "list" ||
      route.type === "create" ||
      route.type === "eval-server" ||
      (route.type === "test-edit" && route.fromEvalServer)
    ) {
      return;
    }
    if (!selectedSuiteId) {
      return;
    }
    if (overviewQueries.isOverviewLoading) {
      return;
    }
    if (!selectedSuiteEntry) {
      navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
    }
  }, [
    overviewQueries.isOverviewLoading,
    route,
    selectedSuiteEntry,
    selectedSuiteId,
  ]);

  // Wait for auth to settle before firing view events. The parent
  // ErrorBoundary keys on (projectId, isAuthenticated), so projectId
  // resolving null→"x" remounts this component and would otherwise
  // double-fire (once on the null mount, once on the resolved mount).
  useEffect(() => {
    if (isLoading) return;
    // `location` is what separates the two tabs in PostHog. Both fire the same
    // events against the same suites, so leaving this as "evals_tab" would
    // make the redesign impossible to measure against the tab it replaces.
    track("evaluate_tab_viewed", {
      location: "evaluate_tab",
      project_id: projectId ?? null,
    });
  }, [isLoading, projectId]);

  useEffect(() => {
    if (isLoading) return;
    if (!selectedSuiteId) return;
    track("suite_viewed", {
      location: "evaluate_tab",
      project_id: projectId ?? null,
      suite_id: selectedSuiteId,
      route_type: route.type,
    });
  }, [isLoading, selectedSuiteId, route.type, projectId]);

  // Prefill for the create-suite page: name from the agent command
  // (`ui_open_eval_suite_form`) or name + server from the empty-hero cards.
  // Prefill-over-commit — the user still reviews and submits.
  const [createSuitePrefillName, setCreateSuitePrefillName] = useState<
    string | null
  >(null);
  const [createSuitePrefillServerId, setCreateSuitePrefillServerId] = useState<
    string | null
  >(null);
  const existingSuiteNames = useMemo(
    () => visibleSuites.map((entry) => entry.suite.name),
    [visibleSuites],
  );

  const emptyHeroServers = useMemo(
    () =>
      projectServers
        .filter((server) => server.name.trim().length > 0)
        .map((server) => ({ id: server._id, name: server.name })),
    [projectServers],
  );

  const handleOpenCreateSuite = useCallback(() => {
    setCreateSuitePrefillName(null);
    setCreateSuitePrefillServerId(null);
    navigatePlaygroundEvalsRoute({ type: "create" });
  }, []);

  const handleEvalServer = useCallback(
    (server: { id: string; name: string }) => {
      setCreateSuitePrefillName(server.name);
      setCreateSuitePrefillServerId(server.id);
      navigatePlaygroundEvalsRoute({ type: "create" });
    },
    [],
  );

  const [isQuickstartRunning, setIsQuickstartRunning] = useState(false);
  const [landingView, setLandingView] = useState<EvalLandingView>("runs");

  const existingQuickstartSuiteId = useMemo(() => {
    const match = visibleSuites.find(
      (entry) =>
        isQuickstartSuite(entry.suite) ||
        entry.suite.name === EXCALIDRAW_QUICKSTART_SUITE_NAME,
    );
    return match?.suite._id ?? null;
  }, [visibleSuites]);

  const handleExcalidrawQuickstart = useCallback(async () => {
    if (!handleConnect || isQuickstartRunning) return;
    if (!projectId) {
      toast.error("Select or create a project before running the quickstart.");
      return;
    }
    setIsQuickstartRunning(true);
    try {
      await runExcalidrawQuickstart({
        projectId,
        convex,
        createTestSuite: mutations.createTestSuiteMutation,
        createTestCase: mutations.createTestCaseMutation,
        createServerAttachment: createServerAttachmentMutation,
        handleConnect,
        isExcalidrawConnected: connectedServerNames.has(EXCALIDRAW_SERVER_NAME),
        existingQuickstartSuiteId,
        previewedHostId,
      });
    } finally {
      setIsQuickstartRunning(false);
    }
  }, [
    projectId,
    convex,
    handleConnect,
    isQuickstartRunning,
    mutations.createTestSuiteMutation,
    mutations.createTestCaseMutation,
    createServerAttachmentMutation,
    connectedServerNames,
    existingQuickstartSuiteId,
    previewedHostId,
  ]);

  const showQuickstart = Boolean(handleConnect);

  const handleCancelCreateSuite = useCallback(() => {
    setCreateSuitePrefillName(null);
    setCreateSuitePrefillServerId(null);
    navigatePlaygroundEvalsRoute({ type: "list" }, { replace: true });
  }, []);

  const handleCreateSuite = useCallback(
    async (payload: CreateSuitePayload) => {
      if (!projectId) {
        return;
      }

      try {
        const createdSuite = await mutations.createTestSuiteMutation({
          projectId,
          name: payload.name,
          // environment.servers is left empty: hosts own server selection
          // now, and the runner derives the per-run server set from each
          // attachment's snapshot. Suites with zero attachments are valid
          // skeletons — they just can't run until a host is attached.
          environment: { servers: [] },
          ...(payload.hostAttachments && payload.hostAttachments.length > 0
            ? { hostAttachments: payload.hostAttachments }
            : {}),
          ...(payload.serverAttachmentId
            ? { serverAttachmentId: payload.serverAttachmentId }
            : {}),
        });

        if (!createdSuite?._id) {
          throw new Error("Suite was created without an id");
        }

        // `createTestSuite` cannot take environments, so a suite born in
        // environment mode needs a second call. The create page already resolved
        // these ids and sent the matching clients as legacy rollback data, so a
        // failure here leaves a runnable legacy suite the header can convert —
        // worth a toast, not worth discarding the suite.
        if (payload.environmentIds && payload.environmentIds.length > 0) {
          try {
            await setSuiteEnvironments({
              suiteId: createdSuite._id,
              environmentIds: payload.environmentIds,
            });
          } catch (error) {
            toast.error(
              getBillingErrorMessage(
                error,
                "Suite created, but attaching its environments failed",
              ),
            );
          }
        }

        toast.success("Suite created");
        navigatePlaygroundEvalsRoute({
          type: "suite-overview",
          suiteId: createdSuite._id,
        });
      } catch (error) {
        toast.error(getBillingErrorMessage(error, "Failed to create suite"));
        throw error;
      }
    },
    [mutations.createTestSuiteMutation, projectId, setSuiteEnvironments],
  );

  const [suiteAction, setSuiteAction] = useState<"run" | "case" | null>(null);
  const [runReviewSuiteId, setRunReviewSuiteId] = useState<string | null>(null);
  useEffect(() => {
    if (route.type === "run-detail") setRunReviewSuiteId(null);
  }, [route.type]);
  const handleSelectSuite = useCallback((suiteId: string) => {
    navigatePlaygroundEvalsRoute({ type: "suite-overview", suiteId });
  }, []);

  const handleSelectRunFromAllRuns = useCallback(
    ({ suiteId, runId }: { suiteId: string; runId: string }) => {
      navigatePlaygroundEvalsRoute({ type: "run-detail", suiteId, runId });
    },
    [],
  );

  const handleNavigateToEvalList = useCallback(() => {
    navigatePlaygroundEvalsRoute({ type: "list" });
  }, []);

  // Shared by the Generate button (below, on the selected suite) and the
  // agent's generateEvalTests command (any resolved suite): one
  // argument-building path into the SAME handleGenerateTests callback.
  const generateTestsForSuite = useCallback(
    async (
      suite: EvalSuite,
      refinement?: string,
      stageCase?: (input: CreateEvalTestCaseInput) => Promise<unknown>,
      options?: GenerationOptions,
    ) => {
      const suiteServers = getEffectiveSuiteServers(suite);
      if (suiteServers.length === 0) {
        if (stageCase)
          throw new Error("Attach servers before generating cases.");
        return;
      }
      // Scope generation by the suite's saved server attachment when present.
      // Backend uses this to (a) require per-server cases AND at least one
      // cross-server case when the attachment spans ≥2 servers, and (b) put
      // the attachment name on each generated case so failures are
      // attributable to a specific suite scope rather than "any server".
      const suiteAttachment = suite.serverAttachment;
      const serverAttachment = suiteAttachment
        ? {
            id: suiteAttachment._id,
            name: suiteAttachment.name,
            resolvedServerNames: suiteAttachment.resolvedServerNames,
          }
        : undefined;
      // A confirmed batch keeps its options on retries. Legacy callers without
      // explicit options continue using the suite's persisted configuration.
      const generateConfig = loadGenerateConfig(suite._id);
      const generationOptions =
        options ?? (totalCases(generateConfig) >= 1
          ? {
              ...toGenerationOptions(generateConfig),
              ...(refinement?.trim() ? { refinement: refinement.trim() } : {}),
            }
          : refinement?.trim()
            ? { refinement: refinement.trim() }
            : undefined);
      await handlers.handleGenerateTests(suite._id, suiteServers, {
        ...(stageCase
          ? {
              stageCase: (input: CreateEvalTestCaseInput) =>
                stageCase(normalizeGeneratedDraft(input, suite.defaultPredicates)),
            }
          : {}),
        ...(serverAttachment ? { serverAttachment } : {}),
        ...(generationOptions ? { generationOptions } : {}),
      });
    },
    [handlers],
  );

  useEffect(() => {
    if (
      !projectId ||
      !selectedSuite ||
      isLoading ||
      (!isAuthenticated && !isDirectGuest)
    )
      return;
    return registerEvalSuite(
      { projectId, suiteId: selectedSuite._id, suiteName: selectedSuite.name },
      {
        read: () =>
          evalChatSuiteContext(
            selectedSuite,
            suiteDetails?.testCases ?? [],
            runsForSelectedSuite,
            suiteDetails?.iterations ?? [],
          ),
        run: async () => {
          if (evalRunsDisabledReason) throw new Error(evalRunsDisabledReason);
          if (
            runsForSelectedSuite.some(
              (run) => run.status === "running" || run.status === "pending",
            )
          )
            throw new Error("A run is already in progress for this suite.");
          const result = await handleRerunWithQuota(selectedSuite, {
            stayOnPage: true,
          });
          if (!result)
            throw new Error(
              "Run was not started. Check the suite configuration and usage allowance.",
            );
          return result;
        },
        generate: (instructions, stage, options) =>
          generateTestsForSuite(selectedSuite, instructions, stage, options),
        save: (input) => mutations.createTestCaseMutation(input as any),
      },
    );
  }, [
    projectId,
    selectedSuite,
    suiteDetails,
    generateTestsForSuite,
    mutations.createTestCaseMutation,
    isLoading,
    isAuthenticated,
    isDirectGuest,
    runsForSelectedSuite,
    evalRunsDisabledReason,
    handleRerunWithQuota,
  ]);

  useEffect(() => {
    if (projectId && selectedSuite && route.type !== "test-edit") {
      syncEvalChatContext({
        projectId,
        suiteId: selectedSuite._id,
        suiteName: selectedSuite.name,
      });
    }
  }, [projectId, selectedSuite?._id, route.type]);

  const handleGenerateMore = useCallback(
    async (refinement?: string) => {
      if (!selectedSuite) return;
      await generateTestsForSuite(selectedSuite, refinement);
    },
    [generateTestsForSuite, selectedSuite],
  );

  const generateState = useMemo(() => {
    const suiteServers = selectedSuite
      ? getEffectiveSuiteServers(selectedSuite)
      : [];
    if (suiteServers.length === 0) {
      return {
        canGenerate: false,
        disabledReason:
          "Attach a client in the suite header before generating cases.",
      };
    }

    const missingServers = suiteServers.filter(
      (serverName) => !connectedServerNames.has(serverName),
    );
    if (missingServers.length > 0) {
      if (ensureServersReady) {
        return {
          canGenerate: true,
          disabledReason:
            "Connects the suite’s MCP servers if needed, then creates suggested test cases.",
        };
      }
      return {
        canGenerate: false,
        disabledReason: `Connect ${missingServers.join(
          ", ",
        )} to generate cases for this suite.`,
      };
    }

    return {
      canGenerate: true,
      disabledReason:
        "Generate suggested cases from this suite’s servers. Open a case to run it when you are ready.",
    };
  }, [connectedServerNames, ensureServersReady, selectedSuite]);

  // ── Agent bridge ────────────────────────────────────────────────────────
  // The evals tool group + this screen's command handlers and snapshot.
  // Lives HERE, in the surface component, and NEVER in use-eval-handlers or
  // any hook CiEvalsTab also mounts — a shared-hook bridge would register
  // the evals group under the wrong surface on Runs mode (see
  // use-surface-agent-bridge's contract). Handlers reuse the EXACT callbacks
  // the buttons use: the quota-gated run wrapper, handleCancelRun,
  // setSuiteToDelete → confirmDelete, and generateTestsForSuite.

  // Latest handlers for dispatch-time reads: deleteEvalSuite stages state
  // with flushSync and must then call the confirmDelete closure produced by
  // that commit, not the one captured when the command arrived.
  const latestHandlersRef = useRef(handlers);
  // Synchronous in-flight lock for agent-driven generation. `isGeneratingTests`
  // is React state (commits async), so two approved generate calls dispatched
  // back-to-back could both pass that check and fire duplicate BILLABLE
  // requests. This ref flips synchronously, before the fire-and-forget kickoff.
  const agentGenerateInFlightRef = useRef<Set<string>>(new Set());
  latestHandlersRef.current = handlers;

  // EvaluateTabContent's hooks run even while EvalTabGate shows the sign-in /
  // pick-a-project upsell instead of the tab, so the bridge registers in
  // that degraded state too. Mirror the gate's playground rules and refuse
  // commands when the user can't see the real tab.
  const agentOperable =
    !isLoading && (isDirectGuest || (isAuthenticated && Boolean(projectId)));
  const requireAgentOperable = () => {
    if (!agentOperable) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "Testing is locked here. Sign in and select a project before using the eval tools.",
      );
    }
  };

  // Exact (case-insensitive) matches only against the loaded overview: the
  // suite id, the stored name, or the switcher's display name (timestamp
  // suffix stripped). Unknown or ambiguous → invalid_request, never a guess.
  //
  // `intent` IS REQUIRED, deliberately with no default, so a command cannot be
  // added without deciding. An agent command is a second door into the same
  // mutations the buttons call, and it passes none of the rendered controls
  // the CI-owned lock lives in — so a lock that only hides affordances is no
  // lock at all here. `case.create` (generate) and `suite.delete` are both in
  // the platform's locked set: an agent pointed at a CI-owned suite gets a
  // `409`, which is the same offer-then-refuse this whole change removes.
  //
  // `"read"` is not "harmless" — it is "writes no configuration". Running and
  // cancelling stay readable on a CI-owned suite, because running one from the
  // app is exactly what locking edits rather than the suite exists to keep.
  const resolveSuiteEntry = (
    raw: unknown,
    intent: "read" | "write",
  ): EvalSuiteOverviewEntry => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'suite' string (a suite name or id).",
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = visibleSuites.filter((entry) => {
      const name = entry.suite.name ?? "";
      return (
        entry.suite._id === wanted ||
        name.toLowerCase() === wantedLower ||
        (stripTimestampSuffix(name) || "").toLowerCase() === wantedLower
      );
    });
    if (matches.length === 1) {
      const entry = matches[0];
      if (intent === "write" && isCiOwnedSuite(entry.suite)) {
        throw createInspectorCommandClientError(
          "invalid_request",
          `Suite "${suiteDisplayName(
            entry.suite,
          )}" is managed by CI — ${CI_OWNED_REASON_COPY}. Running it is still available.`,
        );
      }
      return entry;
    }
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No eval suite matches "${wanted}". Use a suite name or id from this screen (list them with ui_snapshot_app).`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} suites match "${wanted}". Pass the suite id instead (ids are in ui_snapshot_app).`,
    );
  };

  const resolveRun = (raw: unknown): EvalSuiteRun => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'runId' string.",
      );
    }
    const wanted = raw.trim();
    const runsById = new Map<string, EvalSuiteRun>();
    const visibleRuns = [
      ...runsForSelectedSuite,
      ...visibleSuites.flatMap((entry) => [
        ...(entry.latestRun ? [entry.latestRun] : []),
        ...(entry.recentRuns ?? []),
      ]),
    ];
    for (const run of visibleRuns) {
      if (!runsById.has(run._id)) {
        runsById.set(run._id, run);
      }
    }
    const exact = runsById.get(wanted);
    if (exact) {
      return exact;
    }
    // The runs list displays formatRunId's shortened form; accept it when
    // it identifies exactly one visible run.
    const short = [...runsById.values()].filter(
      (run) => formatRunId(run._id) === wanted,
    );
    if (short.length === 1) {
      return short[0];
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      short.length === 0
        ? `No eval run matches "${wanted}" on this screen. Use a run id from the suite's runs (see ui_snapshot_app).`
        : `${short.length} runs share the shortened id "${wanted}". Pass the full run id.`,
    );
  };

  const suiteDisplayName = (suite: EvalSuite) =>
    stripTimestampSuffix(suite.name || "") || suite.name || "Untitled suite";

  useSurfaceAgentBridge({
    surfaceId: "evals",
    handlers: {
      openEvalSuiteForm: async (command) => {
        requireAgentOperable();
        const { payload } = command as OpenEvalSuiteFormInspectorCommand;
        if (payload?.name !== undefined && typeof payload.name !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'name' must be a string when provided.",
          );
        }
        const name =
          typeof payload?.name === "string" ? payload.name.trim() : "";
        setCreateSuitePrefillName(name.length > 0 ? name : null);
        setCreateSuitePrefillServerId(null);
        navigatePlaygroundEvalsRoute({ type: "create" });
        return {
          status: "form_opened",
          ...(name.length > 0 ? { prefilledName: name } : {}),
          note: "The user reviews, picks attachments, and submits. No suite is created yet.",
        };
      },
      runEvalSuite: async (command) => {
        requireAgentOperable();
        const { payload } = command as RunEvalSuiteInspectorCommand;
        const entry = resolveSuiteEntry(payload.suite, "read");
        // Same quota the Run button consults (use-eval-iteration-quota via
        // guardEvalIterationQuota) — surfaced as a command error naming the
        // quota instead of a toast, and NEVER bypassed.
        if (evalRunsDisabledReason) {
          const usage =
            evalIterationQuota && evalIterationQuota.allowed !== null
              ? ` (${evalIterationQuota.used}/${evalIterationQuota.allowed} eval iterations used)`
              : "";
          throw createInspectorCommandClientError(
            "execution_failed",
            `Cannot start a run: ${evalRunsDisabledReason}${usage} The eval iteration quota is spent. Do not retry until it resets.`,
          );
        }
        if (latestHandlersRef.current.rerunningSuiteId) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Another suite run is already starting. Wait for it to launch.",
          );
        }
        // The SAME quota-gated wrapper the Run button uses. Launch failures
        // inside it surface as toasts, so this reports "requested".
        await handleRerunWithQuota(entry.suite);
        return {
          status: "run_requested",
          suiteId: entry.suite._id,
          suiteName: suiteDisplayName(entry.suite),
          note: "Observe progress with ui_snapshot_app.",
        };
      },
      cancelEvalRun: async (command) => {
        requireAgentOperable();
        const { payload } = command as CancelEvalRunInspectorCommand;
        const run = resolveRun(payload.runId);
        if (run.status !== "pending" && run.status !== "running") {
          return {
            status: "already_finished",
            runId: run._id,
            runStatus: run.status,
          };
        }
        if (latestHandlersRef.current.cancellingRunId) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Another run cancellation is already in progress.",
          );
        }
        await latestHandlersRef.current.handleCancelRun(run._id);
        return { status: "cancel_requested", runId: run._id };
      },
      generateEvalTests: async (command) => {
        requireAgentOperable();
        const { payload } = command as GenerateEvalTestsInspectorCommand;
        const entry = resolveSuiteEntry(payload.suite, "write");
        if (getEffectiveSuiteServers(entry.suite).length === 0) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `Suite "${suiteDisplayName(
              entry.suite,
            )}" has no servers attached. Attach a client in the suite header before generating cases.`,
          );
        }
        const generateSuiteId = entry.suite._id;
        if (
          latestHandlersRef.current.isGeneratingTests ||
          agentGenerateInFlightRef.current.has(generateSuiteId)
        ) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Test generation is already running. Wait for it to finish.",
          );
        }
        // Fire-and-forget through the button's exact path: generation can
        // outlive the command timeout, and generateTestsForSuite handles
        // its own errors (toasts + tracking). The ref lock is set BEFORE the
        // kickoff (synchronous) and cleared when it settles, so a second
        // concurrent call can't double-bill before React state commits.
        agentGenerateInFlightRef.current.add(generateSuiteId);
        void Promise.resolve(generateTestsForSuite(entry.suite)).finally(() => {
          agentGenerateInFlightRef.current.delete(generateSuiteId);
        });
        return {
          status: "generation_started",
          suiteId: entry.suite._id,
          suiteName: suiteDisplayName(entry.suite),
          note: "New cases appear in the suite's case list; watch isGeneratingTests in ui_snapshot_app.",
        };
      },
      deleteEvalSuite: async (command) => {
        requireAgentOperable();
        const { payload } = command as DeleteEvalSuiteInspectorCommand;
        const entry = resolveSuiteEntry(payload.suite, "write");
        if (latestHandlersRef.current.deletingSuiteId) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Another suite deletion is already in progress.",
          );
        }
        // Same two-step path as the UI dialog: stage via setSuiteToDelete,
        // commit via confirmDelete (the chat approval pill already served
        // as the confirmation). flushSync commits the staged state so the
        // confirmDelete closure read afterwards sees it.
        flushSync(() => {
          latestHandlersRef.current.setSuiteToDelete(entry.suite);
        });
        const deleted = await latestHandlersRef.current.confirmDelete();
        // Success clears suiteToDelete itself; on failure (surfaced as a
        // toast) close the confirmation dialog the staging opened.
        latestHandlersRef.current.setSuiteToDelete(null);
        if (!deleted) {
          throw createInspectorCommandClientError(
            "execution_failed",
            `Deleting suite "${suiteDisplayName(
              entry.suite,
            )}" failed. It is still present. Check for a backend or authorization error.`,
          );
        }
        return {
          status: "deleted",
          suiteId: entry.suite._id,
          suiteName: suiteDisplayName(entry.suite),
        };
      },
    },
    // Redacted STATE, not payloads: suite names/ids, statuses, and counters
    // only — no test prompts, no model outputs, no keys.
    snapshot: () => {
      if (!agentOperable) {
        return {
          gated: true,
          reason: "Sign in and select a project to use Testing.",
        };
      }
      const currentRun =
        route.type === "run-detail"
          ? (runsForSelectedSuite.find((run) => run._id === route.runId) ??
            null)
          : null;
      return {
        view: route.type,
        quota: evalIterationQuota
          ? {
              iterationsUsed: evalIterationQuota.used,
              iterationsAllowed: evalIterationQuota.allowed,
              windowKind: evalIterationQuota.windowKind,
            }
          : null,
        selectedSuite: selectedSuite
          ? {
              id: selectedSuite._id,
              name: suiteDisplayName(selectedSuite),
              caseCount: suiteDetails?.testCases.length ?? null,
              servers: getEffectiveSuiteServers(selectedSuite),
            }
          : null,
        totalSuites: visibleSuites.length,
        suites: visibleSuites
          .slice(0, AGENT_SNAPSHOT_MAX_SUITES)
          .map((entry) => ({
            id: entry.suite._id,
            name: suiteDisplayName(entry.suite),
            totals: entry.totals,
            latestRun: entry.latestRun
              ? {
                  id: entry.latestRun._id,
                  status: entry.latestRun.status,
                  passRate: entry.latestRun.summary?.passRate ?? null,
                }
              : null,
          })),
        ...(route.type === "run-detail"
          ? {
              currentRun: currentRun
                ? {
                    id: currentRun._id,
                    status: currentRun.status,
                    ...(currentRun.summary
                      ? { summary: currentRun.summary }
                      : {}),
                  }
                : { id: route.runId },
            }
          : {}),
        isGeneratingTests: handlers.isGeneratingTests,
      };
    },
  });

  const handleDeleteTestCasesBatch = useCallback(
    async (testCaseIds: string[]) => {
      const settledDeletes = await Promise.allSettled(
        testCaseIds.map(async (id) => {
          await directDeleteTestCase(id);
          return id;
        }),
      );
      const deletedIds = new Set(
        settledDeletes.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      );
      const failedDeletes = settledDeletes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (failedDeletes.length > 0) {
        console.error("Failed to delete some test cases:", failedDeletes);
        toast.error(
          `Failed to delete ${failedDeletes.length} test case${
            failedDeletes.length === 1 ? "" : "s"
          }.`,
        );
      }

      if (selectedSuiteId && selectedTestId && deletedIds.has(selectedTestId)) {
        navigatePlaygroundEvalsRoute(
          {
            type: "suite-overview",
            suiteId: selectedSuiteId,
            view: "test-cases",
          },
          { replace: true },
        );
      }
    },
    [directDeleteTestCase, selectedSuiteId, selectedTestId],
  );

  const hasDetailRoute =
    selectedSuiteId &&
    (route.type === "suite-overview" ||
      route.type === "run-detail" ||
      route.type === "test-detail" ||
      route.type === "test-edit" ||
      route.type === "suite-edit");

  const suiteBreadcrumbLabel = selectedSuite
    ? stripTimestampSuffix(selectedSuite.name || "") || "Untitled suite"
    : null;
  const isNestedDetail =
    route.type === "test-edit" ||
    route.type === "test-detail" ||
    route.type === "run-detail" ||
    route.type === "suite-edit";
  const nestedPageLabel =
    route.type === "test-edit" || route.type === "test-detail"
      ? isDraftTestCaseId(selectedTestId)
        ? "New case"
        : suiteDetails?.testCases.find(
            (testCase) => testCase._id === selectedTestId,
          )?.title || "Test case"
      : route.type === "suite-edit"
        ? "Settings"
        : route.type === "run-detail"
          ? "Run"
          : null;

  const renderPlaygroundBreadcrumb = () => {
    if (!hasDetailRoute) return null;
    return isNestedDetail ? nestedPageLabel : suiteBreadcrumbLabel;
  };

  const evalServer =
    route.type === "eval-server"
      ? (emptyHeroServers.find((server) => server.id === route.serverId) ?? {
          id: route.serverId,
          name: "Connected server",
        })
      : null;
  const fromEvalServerId =
    route.type === "test-edit" ? route.fromEvalServer : undefined;
  const evalServerReturn = fromEvalServerId
    ? (emptyHeroServers.find((server) => server.id === fromEvalServerId) ?? {
        id: fromEvalServerId,
        name: "Connected server",
      })
    : null;

  const handleBackToEvalServer = useCallback((serverId: string) => {
    navigatePlaygroundEvalsRoute({ type: "eval-server", serverId });
  }, []);

  const renderSuitesBrowsePanel = () => {
    const preparedServer = evalServer ?? evalServerReturn;
    if (preparedServer && projectId) {
      return (
        <PreparedEvalServerPage
          key={`${projectId}:${preparedServer.id}:${route.type}`}
          projectId={projectId}
          server={preparedServer}
          onExit={() => navigatePlaygroundEvalsRoute({ type: "list" })}
          onReconnect={
            ensureServersReady
              ? async () => {
                  await ensureServersReady([preparedServer.name]);
                }
              : undefined
          }
          editTarget={
            route.type === "test-edit"
              ? { suiteId: route.suiteId, caseId: route.testId }
              : undefined
          }
          onBack={() => handleBackToEvalServer(preparedServer.id)}
          onOpenCase={(target) =>
            playgroundNavigation.toTestEdit(target.suiteId, target.caseId, {
              fromEvalServer: preparedServer.id,
            })
          }
          onRun={async (input) => {
            if (!guardEvalIterationQuota())
              throw new Error(
                "Eval usage is unavailable. Check your usage limit before retrying.",
              );
            const suites = await savePreparedEvalSuites({
              ...input,
              projectId,
              server: preparedServer,
              mutate: (name, args) => convex.mutation(name as any, args),
            });
            for (const suite of suites) {
              const launch = await handlers.handleRerun(suite, {
                stayOnPage: true,
                iterationOverride: input.iterationsPerCase,
                idempotencyKey: `prepared:${input.reviewKey}:${suite._id}`,
              });
              if (!launch || launch.failedCount > 0) {
                throw new Error(
                  "Some evaluations could not start. Retry to launch the remaining clients.",
                );
              }
            }
            if (suites[0])
              navigatePlaygroundEvalsRoute({
                type: "suite-overview",
                suiteId: suites[0]._id,
              });
          }}
        />
      );
    }

    const isLandingList = route.type === "list";
    const landingLoading = (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">
            Loading suites...
          </p>
        </div>
      </div>
    );
    // First-run is the same on Runs and Suites: nothing has been authored
    // yet, so the next step is create / eval-my-server, not an empty table.
    const landingEmpty = (
      <EvalsEmptyHero
        onCreateSuite={handleOpenCreateSuite}
        onEvalServer={handleEvalServer}
        onQuickstart={() => void handleExcalidrawQuickstart()}
        isQuickstartRunning={isQuickstartRunning}
        showQuickstart={showQuickstart}
        servers={emptyHeroServers}
        serversLoading={isProjectServersLoading}
      />
    );

    if (isLandingList && overviewQueries.isOverviewLoading) {
      return landingLoading;
    }

    if (isLandingList && visibleSuites.length === 0) {
      return landingEmpty;
    }

    if (isLandingList && landingView === "runs") {
      return projectId && shouldQueryProjectId(projectId) ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-testid="evals-runs-landing"
        >
          <ProjectRunsTable
            metricBars
            historyMetricsEnabled
            projectId={projectId}
            onSelectRun={handleSelectRunFromAllRuns}
            decisionSummaryEnabled={decisionSummaryEnabled}
            emptyState={landingEmpty}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Select a project to see runs.
          </p>
        </div>
      );
    }

    if (overviewQueries.isOverviewLoading) {
      return landingLoading;
    }

    if (visibleSuites.length === 0) {
      return landingEmpty;
    }

    if (hasDetailRoute) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {queries.isSuiteDetailsLoading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="mt-4 text-sm text-muted-foreground">
                  Loading suite data...
                </p>
              </div>
            </div>
          ) : (
            renderSuiteIterationsDetail()
          )}
        </div>
      );
    }

    return (
      <div
        className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6"
        data-testid="evals-suites-landing"
      >
        <div>
          <SuitesOverview
            overview={visibleSuites}
            onSelectSuite={handleSelectSuite}
            onRerun={(suite) => {
              setRunReviewSuiteId(suite._id);
            }}
            onCancelRun={handlers.handleCancelRun}
            onDelete={handlers.handleDelete}
            /*
             * Role AND ownership. `suite.delete` is CI-locked, so offering the
             * trash on a CI-owned suite is offering a `409`. Answered from the
             * suite ROW rather than capabilities: this is a grid, and asking
             * the backend per card would be one query per suite for a question
             * the row already carries in full.
             */
            canDeleteSuite={(suite) =>
              canDeleteArtifact(suite.createdBy) && !isCiOwnedSuite(suite)
            }
            rerunningSuiteId={rerunningSuiteId}
            cancellingRunId={cancellingRunId}
            deletingSuiteId={deletingSuiteId}
          />
        </div>
      </div>
    );
  };

  const renderSuiteIterationsDetail = () => {
    if (!selectedSuite) {
      return null;
    }

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 pb-6 pt-6">
        <SuiteIterationsView
          organizationId={organizationId}
          isDirectGuest={isDirectGuest}
          ensureServersReady={ensureServersReady}
          suite={selectedSuite}
          cases={suiteDetails?.testCases ?? []}
          iterations={activeIterations}
          allIterations={sortedIterations}
          runs={runsForSelectedSuite}
          runsLoading={queries.isSuiteRunsLoading}
          aggregate={suiteAggregate}
          /*
           * The suite's configuration lives in a repository (a committed suite
           * file, or SDK ingest), so this surface offers no edits for it.
           *
           * Read from the SUITE ROW, which this page already holds. The
           * backend's own answer (`getSuiteCapabilities.ownership`) is ORed in
           * inside `SuiteIterationsView`, which is where capabilities are read
           * — and is absent on a deployment that predates the lock, which is
           * exactly why this row-derived answer has to exist too.
           */
          configLocked={isCiOwnedSuite(selectedSuite)}
          onDuplicateSuite={() => handlers.handleDuplicateSuite(selectedSuite)}
          alwaysShowEditIterationRows
          onEditTestCase={(testCaseId) =>
            playgroundNavigation.toTestEdit(selectedSuite._id, testCaseId, {
              openCompare: true,
            })
          }
          onCreateTestCase={async () =>
            handlers.handleCreateTestCase(selectedSuite._id)
          }
          onDescribeTestCase={() =>
            handlers.handleDescribeTestCase(selectedSuite._id)
          }
          onRecordTestCase={() =>
            handlers.handleRecordTestCase(selectedSuite._id)
          }
          onGenerateTestCases={handleGenerateMore}
          canGenerateTestCases={generateState.canGenerate}
          generateTestCasesDisabledReason={generateState.disabledReason}
          isGeneratingTestCases={handlers.isGeneratingTests}
          onRerun={handleRerunWithQuota}
          onCancelRun={handlers.handleCancelRun}
          onDelete={handlers.handleDelete}
          onDeleteRun={handlers.handleDeleteRun}
          onDirectDeleteRun={handlers.directDeleteRun}
          connectedServerNames={connectedServerNames}
          canDeleteSuite={canDeleteArtifact(selectedSuite.createdBy)}
          rerunningSuiteId={rerunningSuiteId}
          cancellingRunId={cancellingRunId}
          deletingSuiteId={deletingSuiteId}
          deletingRunId={deletingRunId}
          availableModels={availableModels}
          route={route}
          userMap={userMap}
          projectId={projectId}
          navigation={playgroundNavigation}
          onContinueInChat={onContinueInChat}
          canDeleteRuns={canDeleteRuns}
          canDeleteRun={(run) => canDeleteArtifact(run.createdBy)}
          hideRunActions
          suiteDetailOverview
          evaluateDecisionSummary={decisionSummaryEnabled}
          evaluateCaseEditor
          evaluateObserveFirst={observeFirstEnabled}
          evalRunsDisabledReason={evalRunsDisabledReason}
          onDeleteTestCasesBatch={handleDeleteTestCasesBatch}
          onRunTestCase={(testCase, opts) => {
            void (async () => {
              const data = await handleRunTestCaseWithQuota(
                selectedSuite,
                testCase,
                {
                  location: "test_cases_overview",
                  iterationOverride: opts?.iterationOverride,
                },
              );
              const firstIterationId =
                data?.iteration?._id ??
                data?.runs?.find((run: any) => run?.iteration?._id)?.iteration
                  ?._id;
              if (firstIterationId) {
                playgroundNavigation.toTestEdit(
                  selectedSuite._id,
                  testCase._id,
                  {
                    openCompare: true,
                    iteration: firstIterationId,
                  },
                );
              }
            })();
          }}
          runningTestCaseId={handlers.runningTestCaseId}
          projectServers={projectServers}
        />
      </div>
    );
  };

  const renderPlaygroundBody = () => renderSuitesBrowsePanel();

  return (
    <EvalTabGate
      variant="playground"
      isLoading={isLoading}
      isAuthenticated={isAuthenticated}
      user={user}
      projectId={projectId}
      isDirectGuest={isDirectGuest}
      header={
        route.type === "create" ? undefined : (
          <EvalsHeader
            onSetupRun={() => setSuiteAction("run")}
            onAddCase={() => setSuiteAction("case")}
            onCreateSuite={
              route.type === "list" ? handleOpenCreateSuite : undefined
            }
            detailCrumb={
              route.type === "test-edit" && route.checks
                ? { label: "UVC checks" }
                : undefined
            }
            onCurrentCrumbClick={
              route.type === "test-edit" && route.checks
                ? () =>
                    playgroundNavigation.toTestEdit(route.suiteId, route.testId)
                : undefined
            }
            landingView={landingView}
            onLandingViewChange={setLandingView}
            onEvaluateClick={handleNavigateToEvalList}
            isDetail={Boolean(hasDetailRoute) || route.type === "eval-server"}
            parentCrumb={
              route.type === "test-edit" && route.fromEvalServer
                ? {
                    label: evalServerReturn?.name ?? "Connected server",
                    onClick: () =>
                      handleBackToEvalServer(route.fromEvalServer!),
                  }
                : isNestedDetail && suiteBreadcrumbLabel && selectedSuiteId
                  ? {
                      label: suiteBreadcrumbLabel,
                      onClick: () =>
                        playgroundNavigation.toSuiteOverview(selectedSuiteId),
                    }
                  : undefined
            }
          >
            {route.type === "eval-server"
              ? evalServer?.name
              : route.type === "test-edit" && route.fromEvalServer
                ? (previewCaseTitleFromDraft(
                    route.fromEvalServer,
                    route.suiteId,
                    route.testId,
                  ) ?? nestedPageLabel)
                : renderPlaygroundBreadcrumb()}
          </EvalsHeader>
        )
      }
    >
      <EvalAgentWorkspace
        projectId={projectId ?? null}
        organizationId={organizationId ?? null}
      >
        {judgeRunIds.map((runId) => (
          <LaunchedCaseJudge key={runId} runId={runId} />
        ))}
        {route.type === "create" ? (
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <CreateSuitePage
              onCancel={handleCancelCreateSuite}
              onSubmit={handleCreateSuite}
              hostsEnabled={hostsEnabled}
              projectId={projectId}
              initialName={createSuitePrefillName}
              initialServerId={createSuitePrefillServerId}
              existingSuiteNames={existingSuiteNames}
            />
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {renderPlaygroundBody()}
          </div>
        )}

        <Sheet
          open={route.type === "list" && suiteAction !== null}
          onOpenChange={(open) => {
            if (!open) setSuiteAction(null);
          }}
        >
          <SheetContent
            side="right"
            className="flex w-full flex-col sm:max-w-lg"
          >
            <SheetHeader>
              <SheetTitle>
                {suiteAction === "run" ? "Setup Run" : "Add case"}
              </SheetTitle>
              <SheetDescription>
                {suiteAction === "run"
                  ? "Choose a suite to configure its next run."
                  : "Choose a suite for the new case."}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4">
              {visibleSuites.map(({ suite }) => (
                <Button
                  key={suite._id}
                  variant="outline"
                  className="h-auto justify-start whitespace-normal py-3 text-left"
                  onClick={() => {
                    const action = suiteAction;
                    setSuiteAction(null);
                    if (action === "run") setRunReviewSuiteId(suite._id);
                    else
                      playgroundNavigation.toTestEdit(
                        suite._id,
                        draftTestCaseId("prompt"),
                      );
                  }}
                >
                  {suite.name}
                </Button>
              ))}
              {visibleSuites.length === 0 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Create a suite to get started.
                  </p>
                  <Button
                    onClick={() => {
                      setSuiteAction(null);
                      handleOpenCreateSuite();
                    }}
                  >
                    Create suite
                  </Button>
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>

        {route.type === "list" &&
          runReviewSuiteId &&
          (() => {
            const suite = visibleSuites.find(
              (entry) => entry.suite._id === runReviewSuiteId,
            )?.suite;
            return suite ? (
              <SuiteListRunReview
                key={suite._id}
                projectId={projectId}
                suite={suite}
                onClose={() => setRunReviewSuiteId(null)}
                onStart={handleRerunWithQuota}
                onEditSettings={() => {
                  setRunReviewSuiteId(null);
                  playgroundNavigation.toSuiteEdit(suite._id);
                }}
                disabledReason={evalRunsDisabledReason}
              />
            ) : null;
          })()}

        <ConfirmationDialogs
          suiteToDelete={handlers.suiteToDelete}
          setSuiteToDelete={handlers.setSuiteToDelete}
          deletingSuiteId={handlers.deletingSuiteId}
          onConfirmDeleteSuite={handlers.confirmDelete}
          runToDelete={handlers.runToDelete}
          setRunToDelete={handlers.setRunToDelete}
          deletingRunId={handlers.deletingRunId}
          onConfirmDeleteRun={handlers.confirmDeleteRun}
          testCaseToDelete={handlers.testCaseToDelete}
          setTestCaseToDelete={handlers.setTestCaseToDelete}
          deletingTestCaseId={handlers.deletingTestCaseId}
          onConfirmDeleteTestCase={handlers.confirmDeleteTestCase}
        />
      </EvalAgentWorkspace>
    </EvalTabGate>
  );
}
