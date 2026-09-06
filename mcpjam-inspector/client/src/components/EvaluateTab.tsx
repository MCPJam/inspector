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
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { EvalsEmptyHero } from "./evaluate/evals-empty-hero";
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
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import {
  aggregateSuite,
  formatRunId,
  getEffectiveSuiteServers,
} from "./evals/helpers";
import { EvalTabGate } from "./evals/EvalTabGate";
import {
  EvalsHeader,
  type EvalLandingView,
} from "./evaluate/evals-header";
import {
  createPlaygroundSuiteNavigation,
  navigatePlaygroundEvalsRoute,
} from "./evaluate/create-suite-navigation";
import { SuiteIterationsView } from "./evals/suite-iterations-view";
import { ConfirmationDialogs } from "./evals/ConfirmationDialogs";
import { useEvalQueries } from "./evals/use-eval-queries";
import { useEvalMutations } from "./evals/use-eval-mutations";
import { useEvalHandlers } from "./evals/use-eval-handlers";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { SuitesOverview } from "./evaluate/suites-overview";
import { ProjectRunsTable } from "./evals/project-runs-table";
import { stripTimestampSuffix } from "./evals/suite-overview-presentation";
import { isDraftTestCaseId } from "./evals/draft-test-case";
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

/** Cap the agent snapshot's suite list — state overview, not a data dump. */
const AGENT_SNAPSHOT_MAX_SUITES = 30;

interface EvaluateTabProps {
  projectId?: string | null;
  onContinueInChat?: (handoff: Omit<EvalChatHandoff, "id">) => void;
  ensureServersReady?: (
    serverNames: string[]
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
    [evalIterationQuota]
  );
  const { servers: projectServers = [], isLoading: isProjectServersLoading } =
    useProjectServers({
      isAuthenticated,
      projectId: projectId ?? null,
    });
  const mutations = useEvalMutations({ isDirectGuest });
  const convex = useConvex();
  const createServerAttachmentMutation = useMutation(
    "serverAttachments:createServerAttachment" as any
  ) as unknown as (args: {
    projectId: string;
    name: string;
    serverIds: string[];
  }) => Promise<{ _id: string }>;
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as any
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[] | null;
  }) => Promise<unknown>;

  const selectedSuiteId =
    route.type === "suite-overview" ||
    route.type === "run-detail" ||
    route.type === "test-detail" ||
    route.type === "test-edit" ||
    route.type === "suite-edit"
      ? route.suiteId
      : null;
  const selectedTestId =
    route.type === "test-detail" || route.type === "test-edit"
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
        visibleSuites.map((entry) => [entry.suite._id, entry.latestRun ?? null])
      ),
    [visibleSuites]
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

  const handleRerunWithQuota = useCallback(
    (...args: Parameters<typeof handlers.handleRerun>) => {
      if (!guardEvalIterationQuota()) {
        return;
      }
      return handlers.handleRerun(...args);
    },
    [guardEvalIterationQuota, handlers]
  );

  const handleRunTestCaseWithQuota = useCallback(
    (...args: Parameters<typeof handlers.handleRunTestCase>) => {
      if (!guardEvalIterationQuota()) {
        return Promise.resolve(null);
      }
      return handlers.handleRunTestCase(...args);
    },
    [guardEvalIterationQuota, handlers]
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
      activeIterations
    );
  }, [selectedSuite, suiteDetails, activeIterations]);
  const playgroundNavigation = useMemo(
    () => createPlaygroundSuiteNavigation(),
    []
  );

  useEffect(() => {
    if (route.type === "list" || route.type === "create") {
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
    route.type,
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

  const emptyHeroServers = useMemo(
    () =>
      projectServers
        .filter((server) => server.name.trim().length > 0)
        .map((server) => ({ id: server._id, name: server.name })),
    [projectServers]
  );

  const handleOpenCreateSuite = useCallback(() => {
    setCreateSuitePrefillName(null);
    setCreateSuitePrefillServerId(null);
    navigatePlaygroundEvalsRoute({ type: "create" });
  }, []);

  const handleOpenCreateSuiteFromServer = useCallback(
    (server: { id: string; name: string }) => {
      setCreateSuitePrefillName(server.name);
      setCreateSuitePrefillServerId(server.id);
      navigatePlaygroundEvalsRoute({ type: "create" });
    },
    []
  );

  const [isQuickstartRunning, setIsQuickstartRunning] = useState(false);
  const [landingView, setLandingView] = useState<EvalLandingView>("suites");

  const existingQuickstartSuiteId = useMemo(() => {
    const match = visibleSuites.find(
      (entry) =>
        isQuickstartSuite(entry.suite) ||
        entry.suite.name === EXCALIDRAW_QUICKSTART_SUITE_NAME
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
                "Suite created, but attaching its environments failed"
              )
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
    [mutations.createTestSuiteMutation, projectId, setSuiteEnvironments]
  );

  const handleSelectSuite = useCallback((suiteId: string) => {
    navigatePlaygroundEvalsRoute({ type: "suite-overview", suiteId });
  }, []);

  const handleSelectRunFromAllRuns = useCallback(
    ({ suiteId, runId }: { suiteId: string; runId: string }) => {
      navigatePlaygroundEvalsRoute({ type: "run-detail", suiteId, runId });
    },
    []
  );

  const handleNavigateToEvalList = useCallback(() => {
    navigatePlaygroundEvalsRoute({ type: "list" });
  }, []);

  // Shared by the Generate button (below, on the selected suite) and the
  // agent's generateEvalTests command (any resolved suite): one
  // argument-building path into the SAME handleGenerateTests callback.
  const generateTestsForSuite = useCallback(
    async (suite: EvalSuite) => {
      const suiteServers = getEffectiveSuiteServers(suite);
      if (suiteServers.length === 0) return;
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
      // Per-suite generation config from the "Generate" popover (count, mix,
      // vary-user-styles). Defaults reproduce today's behavior, so the one-click
      // Generate keeps working unchanged when the popover was never touched. A
      // degenerate all-zero persisted mix falls back to default generation rather
      // than sending an empty caseMix (mirrors the popover's total >= 1 guard).
      const generateConfig = loadGenerateConfig(suite._id);
      const generationOptions =
        totalCases(generateConfig) >= 1
          ? toGenerationOptions(generateConfig)
          : undefined;
      await handlers.handleGenerateTests(suite._id, suiteServers, {
        ...(serverAttachment ? { serverAttachment } : {}),
        ...(generationOptions ? { generationOptions } : {}),
      });
    },
    [handlers]
  );

  const handleGenerateMore = useCallback(async () => {
    if (!selectedSuite) return;
    await generateTestsForSuite(selectedSuite);
  }, [generateTestsForSuite, selectedSuite]);

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
      (serverName) => !connectedServerNames.has(serverName)
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
          ", "
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
        "Testing is locked here — sign in and select a project before using the eval tools.",
      );
    }
  };

  // Exact (case-insensitive) matches only against the loaded overview: the
  // suite id, the stored name, or the switcher's display name (timestamp
  // suffix stripped). Unknown or ambiguous → invalid_request, never a guess.
  const resolveSuiteEntry = (raw: unknown): EvalSuiteOverviewEntry => {
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
      return matches[0];
    }
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No eval suite matches "${wanted}". Use a suite name or id from this screen (list them with ui_snapshot_app).`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} suites match "${wanted}" — pass the suite id instead (ids are in ui_snapshot_app).`,
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
      (run) => formatRunId(run._id) === wanted
    );
    if (short.length === 1) {
      return short[0];
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      short.length === 0
        ? `No eval run matches "${wanted}" on this screen. Use a run id from the suite's runs (see ui_snapshot_app).`
        : `${short.length} runs share the shortened id "${wanted}" — pass the full run id.`,
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
          note: "The user reviews, picks attachments, and submits — no suite is created yet.",
        };
      },
      runEvalSuite: async (command) => {
        requireAgentOperable();
        const { payload } = command as RunEvalSuiteInspectorCommand;
        const entry = resolveSuiteEntry(payload.suite);
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
            `Cannot start a run: ${evalRunsDisabledReason}${usage} The eval iteration quota is spent — do not retry until it resets.`,
          );
        }
        if (latestHandlersRef.current.rerunningSuiteId) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Another suite run is already starting — wait for it to launch.",
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
        const entry = resolveSuiteEntry(payload.suite);
        if (getEffectiveSuiteServers(entry.suite).length === 0) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `Suite "${suiteDisplayName(entry.suite)}" has no servers attached — attach a client in the suite header before generating cases.`,
          );
        }
        const generateSuiteId = entry.suite._id;
        if (
          latestHandlersRef.current.isGeneratingTests ||
          agentGenerateInFlightRef.current.has(generateSuiteId)
        ) {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Test generation is already running — wait for it to finish.",
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
        const entry = resolveSuiteEntry(payload.suite);
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
            `Deleting suite "${suiteDisplayName(entry.suite)}" failed — it is still present. Check for a backend or authorization error.`,
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
          ? runsForSelectedSuite.find((run) => run._id === route.runId) ?? null
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
        })
      );
      const deletedIds = new Set(
        settledDeletes.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        )
      );
      const failedDeletes = settledDeletes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );

      if (failedDeletes.length > 0) {
        console.error("Failed to delete some test cases:", failedDeletes);
        toast.error(
          `Failed to delete ${failedDeletes.length} test case${
            failedDeletes.length === 1 ? "" : "s"
          }.`
        );
      }

      if (selectedSuiteId && selectedTestId && deletedIds.has(selectedTestId)) {
        navigatePlaygroundEvalsRoute(
          {
            type: "suite-overview",
            suiteId: selectedSuiteId,
            view: "test-cases",
          },
          { replace: true }
        );
      }
    },
    [directDeleteTestCase, selectedSuiteId, selectedTestId]
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
        : suiteDetails?.testCases.find((testCase) => testCase._id === selectedTestId)
            ?.title || "Test case"
      : route.type === "suite-edit"
        ? "Settings"
        : route.type === "run-detail"
          ? "Run"
          : null;

  const renderPlaygroundBreadcrumb = () => {
    if (!hasDetailRoute) return null;
    return isNestedDetail ? nestedPageLabel : suiteBreadcrumbLabel;
  };

  const renderSuitesBrowsePanel = () => {
    const isLandingList = route.type === "list";

    if (isLandingList && landingView === "runs") {
      return projectId && shouldQueryProjectId(projectId) ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-testid="evals-runs-landing"
        >
          <ProjectRunsTable
            projectId={projectId}
            onSelectRun={handleSelectRunFromAllRuns}
            decisionSummaryEnabled={decisionSummaryEnabled}
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
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">
              Loading suites...
            </p>
          </div>
        </div>
      );
    }

    if (visibleSuites.length === 0) {
      return (
        <EvalsEmptyHero
          onCreateSuite={handleOpenCreateSuite}
          onCreateSuiteFromServer={handleOpenCreateSuiteFromServer}
          onQuickstart={() => void handleExcalidrawQuickstart()}
          isQuickstartRunning={isQuickstartRunning}
          showQuickstart={showQuickstart}
          servers={emptyHeroServers}
          serversLoading={isProjectServersLoading}
        />
      );
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

    // List landing: suites overview. Runs live behind the header tab so the
    // two lists are not stacked. Clicking a suite still drills into its
    // dashboard; the Evaluate / suite-name crumb stays on those detail routes.
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-auto"
        data-testid="evals-suites-landing"
      >
        <div className="px-6 pt-6">
          <SuitesOverview
            overview={visibleSuites}
            onSelectSuite={handleSelectSuite}
            onRerun={handleRerunWithQuota}
            onCancelRun={handlers.handleCancelRun}
            onDelete={handlers.handleDelete}
            canDeleteSuite={(suite) => canDeleteArtifact(suite.createdBy)}
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
          alwaysShowEditIterationRows
          onEditTestCase={(testCaseId) =>
            playgroundNavigation.toTestEdit(selectedSuite._id, testCaseId, {
              openCompare: true,
            })
          }
          onCreateTestCase={async () =>
            handlers.handleCreateTestCase(selectedSuite._id)
          }
          onRecordTestCase={() =>
            handlers.handleRecordTestCase(selectedSuite._id)
          }
          onGenerateTestCases={() => void handleGenerateMore()}
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
                }
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
                  }
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
            onCreateSuite={
              route.type === "list" ? handleOpenCreateSuite : undefined
            }
            onEvaluateClick={handleNavigateToEvalList}
            isDetail={Boolean(hasDetailRoute)}
            parentCrumb={
              isNestedDetail && suiteBreadcrumbLabel && selectedSuiteId
                ? {
                    label: suiteBreadcrumbLabel,
                    onClick: () =>
                      playgroundNavigation.toSuiteOverview(selectedSuiteId),
                  }
                : undefined
            }
            landingView={route.type === "list" ? landingView : undefined}
            onLandingViewChange={
              route.type === "list" ? setLandingView : undefined
            }
          >
            {renderPlaygroundBreadcrumb()}
          </EvalsHeader>
        )
      }
    >
      <>
        {route.type === "create" ? (
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <CreateSuitePage
              onCancel={handleCancelCreateSuite}
              onSubmit={handleCreateSuite}
              hostsEnabled={hostsEnabled}
              projectId={projectId}
              initialName={createSuitePrefillName}
              initialServerId={createSuitePrefillServerId}
            />
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {renderPlaygroundBody()}
          </div>
        )}

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
      </>
    </EvalTabGate>
  );
}
