import { useCallback, useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  buildCiEvalsPath,
  buildEvalsPath,
  navigateApp,
} from "@/lib/app-navigation";
import type { EvalRoute, SuiteOverviewView } from "@/lib/eval-route-types";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "./types";
import { getSuiteReplayEligibility } from "./replay-eligibility";
import { getEffectiveSuiteServers } from "./helpers";
import { PROBE_TOOL_NAME_PLACEHOLDER } from "@/shared/probe-config";
import type { useEvalMutations } from "./use-eval-mutations";
import { authFetch } from "@/lib/session-token";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { ModelDefinition } from "@/shared/types";
import {
  buildEvalConvexAuthPayload,
  getEvalApiEndpoints,
  runEvals,
  runEvalTestCase,
} from "@/lib/apis/evals-api";
import { isHostedMode } from "@/lib/apis/mode-client";
import { normalizeHostedServerNames } from "@/lib/apis/web/context";
import { generateAndPersistEvalTests } from "@/lib/evals/generate-and-persist-tests";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import { useConvexAccessToken } from "@/hooks/use-convex-access-token";
import {
  getDefaultTestCaseModelValue,
  prepareSingleTestCaseRun,
} from "./single-test-case-runner";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";

function navigateEvalRoute(
  route: EvalRoute,
  context: "evals" | "ci-evals",
) {
  navigateApp(
    context === "ci-evals" ? buildCiEvalsPath(route) : buildEvalsPath(route),
  );
}
import type { RemoteServer } from "@/hooks/useProjects";
import {
  formatMcpConnectServerPrompt,
  formatMcpServerRefsForError,
  isUnresolvableMcpServerRef,
} from "@/lib/mcp-server-display-name";

function getConfiguredTestCaseModelValues(
  testCase: Pick<EvalCase, "models">
): string[] {
  const modelValues = new Set<string>();

  for (const modelConfig of testCase.models ?? []) {
    if (!modelConfig?.provider || !modelConfig.model) {
      continue;
    }

    modelValues.add(`${modelConfig.provider}/${modelConfig.model}`);
  }

  return Array.from(modelValues);
}

export function hasUnavailableServers(result: EnsureServersReadyResult) {
  return (
    result.missingServerNames.length > 0 ||
    result.failedServerNames.length > 0 ||
    result.reauthServerNames.length > 0
  );
}

/** User-facing copy when ensureServersReady reports blockers. Never lists raw server ids. */
export function formatEnsureServersReadyError(
  result: EnsureServersReadyResult,
  actionLabel: string,
  projectServers: RemoteServer[] | undefined,
) {
  if (result.missingServerNames.length > 0) {
    // Never list server names/ids in this toast: refs may be legacy Convex
    // ids or other opaque values that read like random strings.
    const n = result.missingServerNames.length;
    const isTest = actionLabel.includes("test case");
    if (n === 1) {
      return isTest
        ? `Unable to ${actionLabel}. This test depends on an MCP server that is no longer in this project.`
        : `Unable to ${actionLabel}. This suite depends on an MCP server that is no longer in this project.`;
    }
    return isTest
      ? `Unable to ${actionLabel}. This test depends on ${n} MCP servers that are no longer in this project.`
      : `Unable to ${actionLabel}. This suite depends on ${n} MCP servers that are no longer in this project.`;
  }

  if (result.reauthServerNames.length > 0) {
    const names = result.reauthServerNames;
    const opts = { remoteServers: projectServers };
    if (names.length > 0 && names.every((r) => isUnresolvableMcpServerRef(r, opts))) {
      return `Re-authenticate, then try to ${actionLabel}.`;
    }
    return `Re-authenticate with ${formatMcpServerRefsForError(names, opts)} to ${actionLabel}.`;
  }

  if (result.failedServerNames.length > 0) {
    const names = result.failedServerNames;
    const opts = { remoteServers: projectServers };
    if (names.length > 0 && names.every((r) => isUnresolvableMcpServerRef(r, opts))) {
      return `We couldn't connect to a required server. Try again to ${actionLabel}.`;
    }
    return `We couldn't connect to ${formatMcpServerRefsForError(names, opts)}. Try again to ${actionLabel}.`;
  }

  return `Unable to prepare the required servers to ${actionLabel}.`;
}

export function normalizeSuiteServerRefs(
  serverNamesOrIds: readonly string[] | undefined,
): string[] {
  const rawServerRefs = (serverNamesOrIds ?? []).flatMap((serverRef) =>
    typeof serverRef === "string" && serverRef.trim().length > 0
      ? [serverRef.trim()]
      : [],
  );

  if (rawServerRefs.length === 0) {
    return [];
  }

  if (isHostedMode()) {
    try {
      return normalizeHostedServerNames(rawServerRefs);
    } catch {
      // Fall back to the raw refs if hosted context has not initialized yet.
    }
  }

  return Array.from(new Set(rawServerRefs));
}

/** Options for {@link useEvalHandlers} `handleGenerateTests` (playground: connect, generate, run). */
export type HandleGenerateEvalTestsOptions = {
  /** Required when `runNewCasesAfterGenerate` is true (same object passed to `handleRunTestCase`). */
  suite?: EvalSuite;
  /**
   * When set with `suite`, after persisting new cases, runs them via the same path as
   * the per-row run control (including `ensureServersReady` and model prep).
   */
  runNewCasesAfterGenerate?: boolean;
  /**
   * Optional metadata about the suite's saved server attachment. When
   * provided, threaded through to the backend so the LLM scopes generated
   * cases to that attachment's servers (per-server tests + at least one
   * explicit cross-server test when the attachment spans ≥2 servers).
   */
  serverAttachment?: {
    id?: string;
    name?: string;
    resolvedServerNames: string[];
  };
};

interface UseEvalHandlersProps {
  mutations: ReturnType<typeof useEvalMutations>;
  selectedSuiteEntry: EvalSuiteOverviewEntry | null;
  selectedSuiteId: string | null;
  selectedTestId: string | null;
  projectId?: string | null;
  connectedServerNames?: Set<string>;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  latestRunBySuiteId?: Map<string, EvalSuiteRun | null>;
  /**
   * When `ci-evals`, navigation after test-case mutations stays on CI evals
   * routes (`#/ci-evals/...`). Defaults to main evals (`#/evals/...`).
   */
  evalsNavigationContext?: "evals" | "ci-evals";
  /** For user-facing server labels (names instead of raw Convex ids). */
  projectServers?: RemoteServer[];
  /** When true, this uses the direct-guest eval playground flow. */
  isDirectGuest?: boolean;
  /** Available models; used to resolve provider when falling back to suite.defaultConfig.modelId. */
  availableModels?: ModelDefinition[];
}

/**
 * Hook for all eval event handlers (rerun, delete, duplicate, etc.)
 */
export function useEvalHandlers({
  mutations,
  selectedSuiteEntry,
  selectedSuiteId,
  selectedTestId,
  projectId = null,
  connectedServerNames,
  ensureServersReady,
  latestRunBySuiteId,
  evalsNavigationContext = "evals",
  projectServers,
  isDirectGuest = false,
  availableModels,
}: UseEvalHandlersProps) {
  const convex = useConvex();
  // Resolves the WorkOS token for signed-in users and the guest bearer for
  // guests (project-owning guests included). See use-convex-access-token.
  const getAccessToken = useConvexAccessToken();

  // Action states
  const [rerunningSuiteId, setRerunningSuiteId] = useState<string | null>(null);
  const [runningTestCaseId, setRunningTestCaseId] = useState<string | null>(
    null
  );
  const [replayingRunId, setReplayingRunId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);
  const [duplicatingSuiteId, setDuplicatingSuiteId] = useState<string | null>(
    null
  );
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [runToDelete, setRunToDelete] = useState<string | null>(null);
  const [isCreatingTestCase, setIsCreatingTestCase] = useState(false);
  const [deletingTestCaseId, setDeletingTestCaseId] = useState<string | null>(
    null
  );
  const [duplicatingTestCaseId, setDuplicatingTestCaseId] = useState<
    string | null
  >(null);
  const [testCaseToDelete, setTestCaseToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [isGeneratingTests, setIsGeneratingTests] = useState(false);

  const navigateAfterTestCaseMutation = useCallback(
    (
      route:
        | { type: "test-detail"; suiteId: string; testId: string }
        | { type: "test-edit"; suiteId: string; testId: string }
        | {
            type: "suite-overview";
            suiteId: string;
            view?: SuiteOverviewView;
          },
    ) => {
      navigateEvalRoute(route as EvalRoute, evalsNavigationContext);
    },
    [evalsNavigationContext]
  );

  // Query to get test cases for a suite
  const getTestCasesForRerun = useCallback(
    async (suiteId: string) => {
      try {
        const testCases = await convex.query(
          "testSuites:listTestCases" as any,
          { suiteId }
        );
        return testCases;
      } catch (error) {
        console.error("Failed to fetch test cases:", error);
        return [];
      }
    },
    [convex]
  );

  const getSuiteExecutionContext = useCallback(
    async (suite: EvalSuite) => {
      const testCases = (await getTestCasesForRerun(suite._id)) as any[];
      if (!testCases || testCases.length === 0) {
        toast.error("No test cases found in this suite");
        return null;
      }

      const tests: any[] = [];
      const providersNeeded = new Set<string>();

      // Resolve the fallback model definition for cases with no per-case models.
      // Disambiguate by provider when stored, so OpenRouter gpt-4o doesn't
      // resolve to the native OpenAI gpt-4o if their ids collide.
      const suiteDefaultModelDef = suite.defaultConfig?.modelId
        ? (availableModels ?? []).find(
            (m) =>
              String(m.id) === suite.defaultConfig!.modelId &&
              (!suite.defaultConfig!.provider ||
                m.provider === suite.defaultConfig!.provider)
          )
        : undefined;
      // Distinguish "no default set" from "default set but unresolvable"
      // (e.g. model removed, availableModels still loading) so we can show a
      // more useful toast than "add models to your test cases".
      const suiteDefaultUnresolved =
        !!suite.defaultConfig?.modelId && !suiteDefaultModelDef;

      // Note: suite.defaultConfig.systemPrompt / temperature are NOT merged
      // into per-case advancedConfig here. The wire field flows through the
      // server's testCase upsert path and would bake the suite default into
      // every per-case advancedConfig, breaking later edits to the suite
      // default. Runtime application of suite defaults happens server-side
      // (Convex testSuiteRun hostConfigId snapshot).

      let probesSkippedMissingConfig = 0;
      for (const testCase of testCases) {
        // Widget probes carry no models and no prompt — they must never fall
        // into the LLM fan-out below (a probe with a suite default model
        // would otherwise run as an empty-prompt LLM case). The sentinel
        // model/provider strings satisfy the wire schema; the server forks
        // probes off the LLM path before any model resolution.
        if (testCase.caseType === "widget_probe") {
          if (!testCase.probeConfig) {
            probesSkippedMissingConfig++;
            continue;
          }
          tests.push({
            title: testCase.title,
            query: "",
            runs: testCase.runs || 1,
            model: "widget-probe",
            provider: "none",
            expectedToolCalls: [],
            caseType: "widget_probe",
            probeConfig: testCase.probeConfig,
            testCaseId: testCase._id,
          });
          continue;
        }
        const hasModels = testCase.models && testCase.models.length > 0;
        if (!hasModels && !suiteDefaultModelDef) {
          continue;
        }

        // Use per-case models when present; fall back to suite default model.
        const modelConfigs: Array<{ model: string; provider: string }> =
          hasModels
            ? testCase.models
            : [
                {
                  model: suiteDefaultModelDef!.id as string,
                  provider: suiteDefaultModelDef!.provider,
                },
              ];

        for (const modelConfig of modelConfigs) {
          tests.push({
            title: testCase.title,
            query: testCase.query,
            runs: testCase.runs || 1,
            model: modelConfig.model,
            provider: modelConfig.provider,
            expectedToolCalls: testCase.expectedToolCalls || [],
            isNegativeTest: testCase.isNegativeTest,
            scenario: testCase.scenario,
            expectedOutput: testCase.expectedOutput,
            promptTurns: testCase.promptTurns,
            advancedConfig: testCase.advancedConfig,
            matchOptions: testCase.matchOptions,
            testCaseId: testCase._id,
          });

          if (!isMCPJamProvidedModel(modelConfig.model, modelConfig.provider)) {
            providersNeeded.add(modelConfig.provider);
          }
        }
      }

      if (tests.length === 0) {
        if (suiteDefaultUnresolved) {
          const label = suite.defaultConfig?.provider
            ? `${suite.defaultConfig.modelId} (${suite.defaultConfig.provider})`
            : suite.defaultConfig?.modelId;
          toast.error(
            `Suite default model ${label} is not available. Re-select it in the suite's default execution config, or add per-case models.`
          );
        } else if (probesSkippedMissingConfig > 0) {
          // Probe-only suites land here when every probe was skipped above;
          // "add models" would be the wrong prescription for them.
          toast.error(
            "No tests to run. The suite's render checks are missing their configuration."
          );
        } else {
          toast.error("No tests to run. Please add models to your test cases.");
        }
        return null;
      }

      // Provider secrets are resolved server-side from the organization
      // model-providers config in both hosted and local modes, so we no longer
      // gate runs on client-held tokens.
      const modelApiKeys: Record<string, string> = {};

      return {
        // Effective server list: union of legacy `environment.servers`,
        // per-host attachment picks, AND the suite's standalone server
        // attachment (when set). The runner fallback in
        // `runEvals.serverIds` reads this, so an attachment-only suite
        // would otherwise send `serverIds: []` and fail the backend's
        // `min(1)` validation with HTTP 400.
        suiteServers: normalizeSuiteServerRefs(getEffectiveSuiteServers(suite)),
        testCases,
        tests,
        modelApiKeys,
        providersNeeded,
      };
    },
    [getTestCasesForRerun, availableModels]
  );

  const handleReplayRun = useCallback(
    async (
      suite: EvalSuite,
      run: Pick<EvalSuiteRun, "_id" | "hasServerReplayConfig" | "passCriteria">,
      options?: { minimumPassRate?: number }
    ) => {
      if (rerunningSuiteId || replayingRunId) return;

      if (!run.hasServerReplayConfig) {
        toast.error(
          "This CI run can't be replayed because it doesn't have stored replay config."
        );
        return;
      }

      const executionContext = await getSuiteExecutionContext(suite);
      if (!executionContext) {
        return;
      }

      const minimumPassRate =
        options?.minimumPassRate ??
        run.passCriteria?.minimumPassRate ??
        suite.defaultPassCriteria?.minimumPassRate ??
        selectedSuiteEntry?.latestRun?.passCriteria?.minimumPassRate ??
        100;
      const criteriaNote = `Replay of run ${run._id}. Pass Criteria: Min ${minimumPassRate}% Accuracy`;

      setReplayingRunId(run._id);
      const replayToastId = toast.loading("Replaying run...");

      try {
        // Local guests authenticate via this body token (the guest bearer);
        // hosted guests authenticate via authFetch's Authorization header and
        // `buildEvalConvexAuthPayload` drops this field, so an empty string is
        // harmless there.
        const accessToken = (await getAccessToken()) ?? "";
        const endpoints = getEvalApiEndpoints();
        const response = await authFetch(endpoints.replayRun, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: run._id,
            ...buildEvalConvexAuthPayload(accessToken),
            modelApiKeys:
              Object.keys(executionContext.modelApiKeys).length > 0
                ? executionContext.modelApiKeys
                : undefined,
            passCriteria: {
              minimumPassRate,
            },
            notes: criteriaNote,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Failed to replay eval run");
        }

        const result = await response.json().catch(() => null);

        posthog.capture("eval_suite_run_started", {
          location: "ci_evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          num_test_cases: executionContext.testCases.length,
          num_tests: executionContext.tests.length,
          num_models: executionContext.providersNeeded.size,
          minimum_pass_rate: minimumPassRate,
          replay_source_run_id: run._id,
          replay: true,
        });

        if (result?.suiteId && result?.runId) {
          navigateEvalRoute(
            {
              type: "run-detail",
              suiteId: result.suiteId,
              runId: result.runId,
              insightsFocus: true,
            },
            "ci-evals",
          );
        }

        toast.success("Replay completed!", {
          id: replayToastId,
        });
      } catch (error) {
        console.error("Failed to replay evals:", error);
        toast.error(
          getBillingErrorMessage(error, "Failed to replay eval run"),
          {
            id: replayToastId,
          }
        );
      } finally {
        setReplayingRunId(null);
      }
    },
    [
      rerunningSuiteId,
      replayingRunId,
      selectedSuiteEntry,
      getSuiteExecutionContext,
      getAccessToken,
    ]
  );

  // Rerun handler
  const handleRerun = useCallback(
    async (
      suite: EvalSuite,
      options?: {
        /**
         * Transient per-run override applied uniformly to every test in this
         * suite run. Does NOT mutate the persisted `EvalCase.runs` default.
         * Capped server-side at 10 per test.
         */
        iterationOverride?: number;
        /**
         * One-off match-options override for this run only. Applied to every
         * test in the run. Does NOT mutate persisted suite/case records.
         */
        matchOptionsOverride?: import("@/shared/eval-matching").EvalMatchOptions;
        /**
         * When true, re-derives suite.hostConfigId from the current server
         * list and persists it. Without this flag, reruns leave the frozen
         * snapshot untouched so newly connected servers cannot contaminate
         * existing suites.
         */
        refreshSnapshot?: boolean;
      },
    ) => {
      if (rerunningSuiteId) return;

      // Effective servers = flat env.servers ∪ resolved servers across all
      // host attachments. Without this union, a host-only suite would fail
      // the "no servers configured" gate even though the runner can derive
      // servers from each attachment's snapshot at fan-out time.
      const suiteServers = normalizeSuiteServerRefs(
        getEffectiveSuiteServers(suite),
      );
      const latestRun =
        latestRunBySuiteId?.get(suite._id) ??
        (selectedSuiteEntry?.suite._id === suite._id
          ? selectedSuiteEntry.latestRun
          : null);
      const rerunEligibility = getSuiteReplayEligibility({
        suiteServers,
        connectedServerNames,
        latestRun,
      });

      if (suiteServers.length === 0) {
        if (rerunEligibility.replayableLatestRun?._id) {
          await handleReplayRun(suite, rerunEligibility.replayableLatestRun);
          return;
        }
        toast.error("Attach a host to this suite before running it.");
        return;
      }

      if (rerunEligibility.missingServers.length > 0) {
        if (ensureServersReady != null) {
          const readiness = await ensureServersReady(suiteServers);
          if (!hasUnavailableServers(readiness)) {
            // Continue with the live rerun now that the servers are ready.
          } else if (rerunEligibility.replayableLatestRun?._id) {
            await handleReplayRun(suite, rerunEligibility.replayableLatestRun);
            return;
          } else {
            toast.error(
              formatEnsureServersReadyError(
                readiness,
                "run this suite",
                projectServers,
              ),
            );
            return;
          }
        } else {
          toast.error(
            formatMcpConnectServerPrompt(rerunEligibility.missingServers, {
              remoteServers: projectServers,
              kind: "suite",
            }),
          );
          return;
        }
      }

      const executionContext = await getSuiteExecutionContext(suite);
      if (!executionContext) {
        return;
      }

      setRerunningSuiteId(suite._id);

      // Host-bound fan-out: when the suite has hostAttachments we fire one
      // run request per host so each gets its own snapshot. Otherwise we
      // run the suite's flat server list once as before.
      const attachments = suite.hostAttachments ?? [];
      const runPlans =
        attachments.length > 0
          ? attachments.map((attachment) => ({
              namedHostId: attachment.namedHostId,
              hostName: attachment.hostName ?? "host",
              serverIds:
                attachment.resolvedServerNames.length > 0
                  ? attachment.resolvedServerNames
                  : executionContext.suiteServers,
            }))
          : [
              {
                namedHostId: undefined as string | undefined,
                hostName: null as string | null,
                serverIds: executionContext.suiteServers,
              },
            ];

      // Generate a shared group id ONLY when the rerun fans out to more
      // than one host. The inspector route threads this through the Zod
      // schema → recorder → Convex mutation; every sibling run carries
      // the same id so the UI can collapse them into a single parent
      // row. Single-host launches stay ungrouped so legacy + single-host
      // rows render identically.
      const runGroupId =
        runPlans.length > 1 ? crypto.randomUUID() : undefined;

      // Show toast immediately when user clicks rerun
      toast.success(
        runPlans.length > 1
          ? `Starting ${runPlans.length} runs across hosts…`
          : "Run started successfully! Results will appear shortly.",
      );

      const suiteRunStartedAt = Date.now();
      try {
        // Local guests authenticate via this body token (the guest bearer);
        // hosted guests authenticate via authFetch's Authorization header and
        // `mergeHostedServerBatch` strips convexAuthToken, so an empty string
        // is harmless there.
        const accessToken = (await getAccessToken()) ?? "";

        // Get pass criteria from suite's defaultPassCriteria, or fall back to latest run, or default to 100%
        const suiteDefault = suite.defaultPassCriteria?.minimumPassRate;
        const minimumPassRate =
          suiteDefault ?? latestRun?.passCriteria?.minimumPassRate ?? 100;
        const criteriaNote = `Pass Criteria: Min ${minimumPassRate}% Accuracy`;

        const testsPayload = executionContext.tests.map((test) => ({
          title: test.title,
          query: test.query,
          runs: test.runs ?? 1,
          model: test.model,
          provider: test.provider,
          expectedToolCalls: test.expectedToolCalls,
          isNegativeTest: test.isNegativeTest,
          scenario: test.scenario,
          expectedOutput: test.expectedOutput,
          promptTurns: test.promptTurns,
          advancedConfig: test.advancedConfig,
          matchOptions: (test as { matchOptions?: unknown }).matchOptions,
          // Preserve the stable testCaseId set inside
          // getSuiteExecutionContext so the rerun's iteration rows can be
          // linked back to the saved case for "rerun this case" affordances.
          // Dropping it here forced the backend to re-derive linkage by
          // title, which silently broke after a case rename.
          testCaseId: (test as { testCaseId?: string }).testCaseId,
          // Probe fields ride along so cap-math excludes probes and any
          // non-rerun upsert keeps the case's identity (dropping them here
          // would re-count probes as LLM calls server-side).
          caseType: (test as { caseType?: string }).caseType,
          ...((test as { caseType?: string }).caseType === "widget_probe" &&
          (test as { probeConfig?: unknown }).probeConfig
            ? { probeConfig: (test as { probeConfig?: unknown }).probeConfig }
            : {}),
        }));

        // Partial-failure tolerant: a failure on one host shouldn't cancel
        // runs already started against other hosts. We collect failures
        // and toast a summary at the end.
        const settled = await Promise.allSettled(
          runPlans.map((plan) =>
            runEvals({
              projectId,
              suiteId: suite._id,
              suiteName: suite.name,
              suiteDescription: suite.description,
              tests: testsPayload,
              serverIds: plan.serverIds,
              modelApiKeys:
                Object.keys(executionContext.modelApiKeys).length > 0
                  ? executionContext.modelApiKeys
                  : undefined,
              convexAuthToken: accessToken,
              passCriteria: { minimumPassRate },
              notes: criteriaNote,
              suiteRerun: true,
              iterationOverride: options?.iterationOverride,
              matchOptionsOverride: options?.matchOptionsOverride,
              refreshSnapshot: options?.refreshSnapshot,
              ...(plan.namedHostId ? { namedHostId: plan.namedHostId } : {}),
              ...(runGroupId ? { runGroupId } : {}),
            }),
          ),
        );

        const failures = settled
          .map((result, index) =>
            result.status === "rejected"
              ? { plan: runPlans[index], reason: result.reason }
              : null,
          )
          .filter((entry): entry is { plan: (typeof runPlans)[number]; reason: unknown } =>
            entry !== null,
          );

        // Track suite run started (once per fan-out batch; per-host
        // multiplicity is captured in the iteration data).
        posthog.capture("eval_suite_run_started", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          num_test_cases: executionContext.testCases.length,
          num_tests: executionContext.tests.length,
          num_models: executionContext.providersNeeded.size,
          minimum_pass_rate: minimumPassRate,
          num_hosts: runPlans.length,
        });

        posthog.capture("eval_suite_run_completed", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          num_test_cases: executionContext.testCases.length,
          num_tests: executionContext.tests.length,
          num_hosts: runPlans.length,
          num_succeeded_hosts: runPlans.length - failures.length,
          num_failed_hosts: failures.length,
          all_succeeded: failures.length === 0,
          duration_ms: Date.now() - suiteRunStartedAt,
        });

        if (failures.length === 0) {
          toast.success(
            runPlans.length > 1
              ? `All ${runPlans.length} host runs started.`
              : "Eval run completed!",
          );

          // Drop the user on the new run's detail page so they can see
          // results without hunting through the runs list. Multi-host
          // fan-outs land on the suite's runs view instead, since there
          // are multiple sibling runs to pick from.
          if (runPlans.length === 1) {
            const firstSettled = settled[0];
            const newRunId =
              firstSettled?.status === "fulfilled"
                ? (firstSettled.value as { runId?: unknown } | null | undefined)
                    ?.runId
                : undefined;
            if (typeof newRunId === "string" && newRunId.length > 0) {
              navigateEvalRoute(
                {
                  type: "run-detail",
                  suiteId: suite._id,
                  runId: newRunId,
                },
                evalsNavigationContext,
              );
            }
          } else {
            navigateEvalRoute(
              { type: "suite-overview", suiteId: suite._id, view: "runs" },
              evalsNavigationContext,
            );
          }
        } else if (failures.length < runPlans.length) {
          const failedHostNames = failures
            .map((failure) => failure.plan.hostName ?? "(unnamed host)")
            .join(", ");
          toast.error(
            `${failures.length} of ${runPlans.length} host runs failed: ${failedHostNames}`,
          );
        } else {
          // All failed — surface the first error for actionable detail.
          const firstError = failures[0]?.reason;
          throw firstError instanceof Error
            ? firstError
            : new Error(String(firstError ?? "All host runs failed"));
        }
      } catch (error) {
        console.error("Failed to rerun evals:", error);
        toast.error(getBillingErrorMessage(error, "Failed to start eval run"));
      } finally {
        setRerunningSuiteId(null);
      }
    },
    [
      rerunningSuiteId,
      selectedSuiteEntry,
      latestRunBySuiteId,
      connectedServerNames,
      ensureServersReady,
      getAccessToken,
      projectId,
      projectServers,
      getSuiteExecutionContext,
      handleReplayRun,
      evalsNavigationContext,
    ]
  );

  const handleRunTestCase = useCallback(
    async (
      suite: EvalSuite,
      testCase: EvalCase,
      options?: {
        location?: string;
        selectedModel?: string | null;
        /** When true, omits the usual per-run success toasts (errors still surface). */
        suppressCompletionToasts?: boolean;
        /**
         * Transient per-run override for the number of iterations. Wired to
         * `testCaseOverrides.runs`; does NOT mutate the persisted
         * `EvalCase.runs` default. Capped server-side at 10.
         */
        iterationOverride?: number;
      },
    ) => {
      if (runningTestCaseId || rerunningSuiteId || replayingRunId) {
        return null;
      }

      // Widget probes have no single-case quick-run path yet: the
      // run-test-case endpoints only execute model-driven cases, and probes
      // intentionally carry no models. Without this branch the model guard
      // below would surface a misleading "Add a model first".
      if (testCase.caseType === "widget_probe") {
        toast.info("Render checks run with the full suite or on its schedule.");
        return null;
      }

      const modelValuesToRun = options?.selectedModel
        ? [options.selectedModel]
        : getConfiguredTestCaseModelValues(testCase);
      if (
        modelValuesToRun.length === 0 ||
        !getDefaultTestCaseModelValue(testCase)
      ) {
        toast.error("Add a model first");
        return null;
      }

      const isMultiModelRun =
        !options?.selectedModel && modelValuesToRun.length > 1;
      const suiteServers = normalizeSuiteServerRefs(
        getEffectiveSuiteServers(suite),
      );
      const disconnectedSuiteServers = suiteServers.filter(
        (serverName) => !connectedServerNames?.has(serverName),
      );

      if (suiteServers.length === 0) {
        toast.error("Attach a host to this suite before running it.");
        return null;
      }

      if (disconnectedSuiteServers.length > 0) {
        if (ensureServersReady != null) {
          const readiness = await ensureServersReady(suiteServers);
          if (hasUnavailableServers(readiness)) {
            toast.error(
              formatEnsureServersReadyError(
                readiness,
                "run this test case",
                projectServers,
              ),
            );
            return null;
          }
        } else {
          toast.error(
            formatMcpConnectServerPrompt(disconnectedSuiteServers, {
              remoteServers: projectServers,
              kind: "test-case",
            }),
          );
          return null;
        }
      }

      setRunningTestCaseId(testCase._id);

      try {
        const preparedResults = await Promise.allSettled(
          modelValuesToRun.map((selectedModel) =>
            prepareSingleTestCaseRun({
              projectId: isDirectGuest ? null : projectId,
              suite: {
                environment: {
                  ...suite.environment,
                  servers: suiteServers,
                },
              },
              testCase,
              getAccessToken,
              selectedModel,
              testCaseOverrides:
                options?.iterationOverride !== undefined
                  ? { runs: options.iterationOverride }
                  : undefined,
            })
          )
        );
        const preparedRuns = preparedResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        );
        const preparationFailures = preparedResults.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                {
                  modelValue: modelValuesToRun[index]!,
                  error: result.reason,
                },
              ]
            : []
        );

        for (const failure of preparationFailures) {
          console.error(
            `Failed to prepare test case for model ${failure.modelValue}:`,
            failure.error
          );
        }

        if (preparedRuns.length === 0) {
          toast.error(
            getBillingErrorMessage(
              preparationFailures[0]?.error,
              "Failed to run test case"
            )
          );
          return null;
        }

        const runResults = await Promise.all(
          preparedRuns.map(async (preparedRun) => {
            posthog.capture("eval_test_case_run_started", {
              location: options?.location ?? "test_case_list_sidebar",
              platform: detectPlatform(),
              environment: detectEnvironment(),
              suite_id: suite._id,
              test_case_id: testCase._id,
              model: preparedRun.modelValue,
            });

            try {
              const data = await runEvalTestCase({
                ...preparedRun.request,
                skipLastMessageRunUpdate: isMultiModelRun || undefined,
              });
              const iteration = data?.iteration;

              if (iteration) {
                const startedAt = iteration.startedAt ?? iteration.createdAt;
                const completedAt = iteration.updatedAt ?? iteration.createdAt;
                const durationMs =
                  startedAt && completedAt
                    ? Math.max(completedAt - startedAt, 0)
                    : 0;

                posthog.capture("eval_test_case_run_completed", {
                  location: options?.location ?? "test_case_list_sidebar",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                  suite_id: suite._id,
                  test_case_id: testCase._id,
                  model: preparedRun.modelValue,
                  result: iteration.result || "unknown",
                  duration_ms: durationMs,
                });
              }

              return {
                ok: true as const,
                modelValue: preparedRun.modelValue,
                data,
              };
            } catch (error) {
              console.error(
                `Failed to run test case for model ${preparedRun.modelValue}:`,
                error
              );
              return {
                ok: false as const,
                modelValue: preparedRun.modelValue,
                error,
              };
            }
          })
        );

        const successfulRuns = runResults.filter(
          (
            result
          ): result is {
            ok: true;
            modelValue: string;
            data: any;
          } => result.ok
        );
        const failedRuns = runResults.filter(
          (
            result
          ): result is {
            ok: false;
            modelValue: string;
            error: unknown;
          } => !result.ok
        );
        const totalModelsRequested = modelValuesToRun.length;
        const totalFailedRuns = [
          ...preparationFailures.map(({ modelValue, error }) => ({
            ok: false as const,
            modelValue,
            error,
          })),
          ...failedRuns,
        ];

        if (!options?.suppressCompletionToasts) {
          if (successfulRuns.length === totalModelsRequested) {
            toast.success(
              isMultiModelRun
                ? `Test completed across ${totalModelsRequested} models!`
                : "Test completed successfully!",
            );
          } else if (successfulRuns.length > 0) {
            toast.error(
              `${successfulRuns.length}/${totalModelsRequested} model${
                totalModelsRequested === 1 ? "" : "s"
              } completed successfully.`,
            );
          } else {
            toast.error(
              getBillingErrorMessage(
                totalFailedRuns[0]?.error,
                "Failed to run test case",
              ),
            );
          }
        } else if (successfulRuns.length === 0) {
          toast.error(
            getBillingErrorMessage(
              totalFailedRuns[0]?.error,
              "Failed to run test case"
            )
          );
        }

        if (isMultiModelRun) {
          const firstSuccessfulIteration =
            successfulRuns.find((result) => result.data?.iteration?._id)?.data
              ?.iteration ??
            successfulRuns[0]?.data?.iteration ??
            null;
          return {
            iteration: firstSuccessfulIteration,
            runs: successfulRuns.map((result) => result.data),
          };
        }

        return successfulRuns[0]?.data ?? null;
      } catch (error) {
        console.error("Failed to run test case:", error);
        toast.error(getBillingErrorMessage(error, "Failed to run test case"));
        return null;
      } finally {
        setRunningTestCaseId(null);
      }
    },
    [
      runningTestCaseId,
      rerunningSuiteId,
      replayingRunId,
      projectId,
      getAccessToken,
      connectedServerNames,
      ensureServersReady,
      projectServers,
      isDirectGuest,
    ],
  );

  // Delete handler - opens confirmation modal
  const handleDelete = useCallback(
    (suite: EvalSuite) => {
      if (deletingSuiteId) return;
      setSuiteToDelete(suite);
    },
    [deletingSuiteId]
  );

  // Confirm deletion - actually performs the deletion
  const confirmDelete = useCallback(async () => {
    if (!suiteToDelete || deletingSuiteId) return;

    setDeletingSuiteId(suiteToDelete._id);

    try {
      await mutations.deleteSuiteMutation({ suiteId: suiteToDelete._id });
      toast.success("Test suite deleted successfully");

      // If we're viewing this suite, go back to the list
      if (selectedSuiteId === suiteToDelete._id) {
        navigateEvalRoute({ type: "list" }, "evals");
      }

      setSuiteToDelete(null);
    } catch (error) {
      console.error("Failed to delete suite:", error);
      toast.error(getBillingErrorMessage(error, "Failed to delete test suite"));
    } finally {
      setDeletingSuiteId(null);
    }
  }, [
    suiteToDelete,
    deletingSuiteId,
    mutations.deleteSuiteMutation,
    selectedSuiteId,
  ]);

  // Duplicate suite handler
  const handleDuplicateSuite = useCallback(
    async (suite: EvalSuite) => {
      if (duplicatingSuiteId) return;

      setDuplicatingSuiteId(suite._id);

      try {
        const newSuite = await mutations.duplicateSuiteMutation({
          suiteId: suite._id,
        });
        toast.success("Test suite duplicated successfully");

        // Track suite duplicated
        if (newSuite && newSuite._id) {
          posthog.capture("eval_suite_duplicated", {
            location: "evals_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            original_suite_id: suite._id,
            new_suite_id: newSuite._id,
          });
        }

        // Navigate to the new duplicated suite
        if (newSuite && newSuite._id) {
          navigateEvalRoute(
            {
              type: "suite-overview",
              suiteId: newSuite._id,
            },
            "evals",
          );
        }
      } catch (error) {
        console.error("Failed to duplicate suite:", error);
        toast.error(
          getBillingErrorMessage(error, "Failed to duplicate test suite")
        );
      } finally {
        setDuplicatingSuiteId(null);
      }
    },
    [duplicatingSuiteId, mutations.duplicateSuiteMutation]
  );

  // Cancel handler
  const handleCancelRun = useCallback(
    async (runId: string) => {
      if (cancellingRunId) return;

      setCancellingRunId(runId);

      try {
        await mutations.cancelRunMutation({ runId });
        toast.success("Run cancelled successfully");
      } catch (error) {
        console.error("Failed to cancel run:", error);
        toast.error(getBillingErrorMessage(error, "Failed to cancel run"));
      } finally {
        setCancellingRunId(null);
      }
    },
    [cancellingRunId, mutations.cancelRunMutation]
  );

  // Delete run handler - opens confirmation modal (for single run from detail view)
  const handleDeleteRun = useCallback(
    (runId: string) => {
      if (deletingRunId) return;
      setRunToDelete(runId);
    },
    [deletingRunId]
  );

  // Direct delete function - actually performs the deletion (for batch delete)
  const directDeleteRun = useCallback(
    async (runId: string) => {
      try {
        await mutations.deleteRunMutation({ runId });
      } catch (error) {
        console.error("Failed to delete run:", error);
        throw error;
      }
    },
    [mutations.deleteRunMutation]
  );

  // Confirm run deletion - actually performs the deletion
  const confirmDeleteRun = useCallback(async () => {
    if (!runToDelete || deletingRunId) return;

    setDeletingRunId(runToDelete);

    try {
      await mutations.deleteRunMutation({ runId: runToDelete });
      toast.success("Run deleted successfully");
      setRunToDelete(null);
    } catch (error) {
      console.error("Failed to delete run:", error);
      toast.error(getBillingErrorMessage(error, "Failed to delete run"));
    } finally {
      setDeletingRunId(null);
    }
  }, [runToDelete, deletingRunId, mutations.deleteRunMutation]);

  // Handle create test case - creates directly without modal
  const handleCreateTestCase = useCallback(
    async (suiteId: string) => {
      if (isCreatingTestCase) return;

      setIsCreatingTestCase(true);

      try {
        const testCases = await convex.query(
          "testSuites:listTestCases" as any,
          {
            suiteId,
          }
        );

        const collectedModels = collectUniqueModelsFromTestCases(testCases);
        const modelsToUse =
          collectedModels.length > 0
            ? collectedModels
            : [{ provider: "anthropic", model: "anthropic/claude-haiku-4.5" }];

        const testCaseId = await mutations.createTestCaseMutation({
          suiteId: suiteId,
          title: "Untitled test case",
          query: "",
          models: modelsToUse, // Copy models from suite configuration
        });

        toast.success("Test case created");

        // Track test case created
        posthog.capture("eval_test_case_created", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          test_case_id: testCaseId,
          num_models: modelsToUse.length,
        });

        // Open the editor so the new case is configurable (test-detail is iterations-only).
        navigateAfterTestCaseMutation({
          type: "test-edit",
          suiteId,
          testId: testCaseId,
        });

        return testCaseId;
      } catch (error) {
        console.error("Failed to create test case:", error);
        toast.error(
          getBillingErrorMessage(error, "Failed to create test case")
        );
        return null;
      } finally {
        setIsCreatingTestCase(false);
      }
    },
    [
      isCreatingTestCase,
      mutations.createTestCaseMutation,
      convex,
      navigateAfterTestCaseMutation,
    ]
  );

  // Create a widget probe case (synthetic monitor): no LLM/prompt — a pinned
  // tool call rendered in the browser harness, gated by widget render checks.
  // Created with placeholder probeConfig values the probe editor immediately
  // prompts the user to fix; seeded with a widgetRendered check so an
  // unedited probe still asserts something meaningful.
  const handleCreateWidgetProbe = useCallback(
    async (suiteId: string) => {
      if (isCreatingTestCase) return;

      setIsCreatingTestCase(true);

      try {
        const suite = await convex.query("testSuites:getTestSuite" as any, {
          suiteId,
        });
        const firstServer: string =
          (suite ? getEffectiveSuiteServers(suite)[0] : undefined) ?? "server";

        const testCaseId = await mutations.createTestCaseMutation({
          suiteId,
          title: "Untitled render check",
          query: "",
          models: [],
          caseType: "widget_probe",
          probeConfig: {
            serverName: firstServer,
            toolName: PROBE_TOOL_NAME_PLACEHOLDER,
            arguments: {},
          },
          predicates: {
            mode: "replace",
            list: [{ type: "widgetRendered" }],
          },
        });

        toast.success("Render check created");

        posthog.capture("eval_test_case_created", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          test_case_id: testCaseId,
          case_type: "widget_probe",
        });

        navigateAfterTestCaseMutation({
          type: "test-edit",
          suiteId,
          testId: testCaseId,
        });

        return testCaseId;
      } catch (error) {
        console.error("Failed to create render check:", error);
        toast.error(
          getBillingErrorMessage(error, "Failed to create render check")
        );
        return null;
      } finally {
        setIsCreatingTestCase(false);
      }
    },
    [
      isCreatingTestCase,
      mutations.createTestCaseMutation,
      convex,
      navigateAfterTestCaseMutation,
    ]
  );

  // Handle delete test case - opens confirmation modal
  const handleDeleteTestCase = useCallback(
    (testCaseId: string, testCaseTitle: string) => {
      if (deletingTestCaseId) return;
      setTestCaseToDelete({ id: testCaseId, title: testCaseTitle });
    },
    [deletingTestCaseId]
  );

  /** Perform deletion only (no modal). Used for playground batch delete. */
  const directDeleteTestCase = useCallback(
    async (testCaseId: string) => {
      await mutations.deleteTestCaseMutation({ testCaseId });
      posthog.capture("eval_test_case_deleted", {
        location: "evals_tab_batch",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: selectedSuiteId ?? null,
        test_case_id: testCaseId,
      });
    },
    [mutations.deleteTestCaseMutation, selectedSuiteId]
  );

  // Confirm test case deletion
  const confirmDeleteTestCase = useCallback(async () => {
    if (!testCaseToDelete || deletingTestCaseId) return;

    setDeletingTestCaseId(testCaseToDelete.id);

    try {
      await mutations.deleteTestCaseMutation({
        testCaseId: testCaseToDelete.id,
      });
      posthog.capture("eval_test_case_deleted", {
        location: "evals_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: selectedSuiteId ?? null,
        test_case_id: testCaseToDelete.id,
      });
      toast.success("Test case deleted successfully");

      // If we're viewing this test case, navigate back to suite overview
      if (selectedTestId === testCaseToDelete.id && selectedSuiteId) {
        navigateAfterTestCaseMutation(
          evalsNavigationContext === "ci-evals"
            ? {
                type: "suite-overview",
                suiteId: selectedSuiteId,
                view: "test-cases",
              }
            : {
                type: "suite-overview",
                suiteId: selectedSuiteId,
              }
        );
      }

      setTestCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error(getBillingErrorMessage(error, "Failed to delete test case"));
    } finally {
      setDeletingTestCaseId(null);
    }
  }, [
    testCaseToDelete,
    deletingTestCaseId,
    mutations.deleteTestCaseMutation,
    selectedTestId,
    selectedSuiteId,
    evalsNavigationContext,
    navigateAfterTestCaseMutation,
  ]);

  // Duplicate test case handler
  const handleDuplicateTestCase = useCallback(
    async (testCaseId: string, suiteId: string) => {
      if (duplicatingTestCaseId) return;

      setDuplicatingTestCaseId(testCaseId);

      try {
        const newTestCase = await mutations.duplicateTestCaseMutation({
          testCaseId,
        });
        toast.success("Test case duplicated successfully");

        // Track test case duplicated
        if (newTestCase && newTestCase._id) {
          posthog.capture("eval_test_case_duplicated", {
            location: "evals_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            suite_id: suiteId,
            original_test_case_id: testCaseId,
            new_test_case_id: newTestCase._id,
          });
        }

        // Navigate to the new duplicated test case
        if (newTestCase && newTestCase._id) {
          navigateAfterTestCaseMutation({
            type: "test-edit",
            suiteId,
            testId: newTestCase._id,
          });
        }

        return newTestCase;
      } catch (error) {
        console.error("Failed to duplicate test case:", error);
        toast.error(
          getBillingErrorMessage(error, "Failed to duplicate test case")
        );
        return null;
      } finally {
        setDuplicatingTestCaseId(null);
      }
    },
    [
      duplicatingTestCaseId,
      mutations.duplicateTestCaseMutation,
      navigateAfterTestCaseMutation,
    ]
  );

  // Generate tests handler - calls API and creates test cases
  const handleGenerateTests = useCallback(
    async (
      suiteId: string,
      serverIds: string[],
      postOptions?: HandleGenerateEvalTestsOptions,
    ) => {
      if (isGeneratingTests) return;

      const suiteServers = normalizeSuiteServerRefs(serverIds);
      if (suiteServers.length === 0) {
        toast.error(
          "Add at least one server to this suite before generating cases.",
        );
        return;
      }

      setIsGeneratingTests(true);

      try {
        const disconnected = suiteServers.filter(
          (name) => !connectedServerNames?.has(name),
        );
        if (disconnected.length > 0) {
          if (ensureServersReady != null) {
            const readiness = await ensureServersReady(suiteServers);
            if (hasUnavailableServers(readiness)) {
              toast.error(
                formatEnsureServersReadyError(
                  readiness,
                  "generate test cases",
                  projectServers,
                ),
              );
              return;
            }
          } else {
            toast.error(
              formatMcpConnectServerPrompt(disconnected, {
                remoteServers: projectServers,
                kind: "suite",
              }),
            );
            return;
          }
        }

        const outcome = await generateAndPersistEvalTests({
          convex,
          getAccessToken,
          projectId,
          suiteId,
          serverIds,
          createTestCase: mutations.createTestCaseMutation as (
            input: any
          ) => Promise<unknown>,
          skipIfExistingCases: false,
          isDirectGuest,
          listExistingCases: () =>
            convex.query("testSuites:listTestCases" as any, {
              suiteId,
            }) as Promise<Array<Record<string, unknown>>>,
          ...(postOptions?.serverAttachment
            ? { serverAttachment: postOptions.serverAttachment }
            : {}),
        });

        if (outcome.apiReturnedTests === 0) {
          posthog.capture("eval_generate_tests_completed", {
            location: "evals_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            suite_id: suiteId,
            generated_count: 0,
            api_returned_tests: 0,
            success: true,
          });
          toast.info("No test cases were generated");
          return;
        }

        const shouldAutoRun =
          postOptions?.runNewCasesAfterGenerate === true &&
          postOptions?.suite != null;

        if (outcome.createdCount > 0) {
          posthog.capture("eval_tests_generated_from_sidebar", {
            location: "test_case_list_sidebar",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            suite_id: suiteId,
            generated_count: outcome.createdCount,
            auto_ran: Boolean(
              shouldAutoRun && outcome.createdTestCaseIds.length > 0,
            ),
          });
        }

        posthog.capture("eval_generate_tests_completed", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          generated_count: outcome.createdCount,
          api_returned_tests: outcome.apiReturnedTests,
          auto_ran: Boolean(
            shouldAutoRun && outcome.createdTestCaseIds.length > 0,
          ),
          success: true,
        });

        if (
          shouldAutoRun &&
          outcome.createdTestCaseIds.length > 0 &&
          outcome.createdCount > 0
        ) {
          const suite = postOptions!.suite!;
          const allCases = (await getTestCasesForRerun(
            suiteId,
          )) as EvalCase[];
          const byId = new Map<string, EvalCase>(
            allCases.map((c) => [c._id, c]),
          );
          const toRun: EvalCase[] = [];
          for (const id of outcome.createdTestCaseIds) {
            const c = byId.get(id);
            if (c) {
              toRun.push(c);
            }
          }
          for (const testCase of toRun) {
            await handleRunTestCase(suite, testCase, {
              location: "post_generate_suggested_cases",
              suppressCompletionToasts: true,
            });
          }
          if (toRun.length === 0) {
            toast.success(
              `Generated ${outcome.createdCount} test case${outcome.createdCount > 1 ? "s" : ""}. Open the list to run them when they appear.`,
            );
          } else if (toRun.length === 1) {
            toast.success("Generated 1 new case and ran it.");
          } else {
            toast.success(
              `Generated and ran ${toRun.length} new test cases.`,
            );
          }
        } else if (outcome.createdCount > 0) {
          toast.success(
            `Generated ${outcome.createdCount} test case${outcome.createdCount > 1 ? "s" : ""}`,
          );
        }
      } catch (error) {
        console.error("Failed to generate tests:", error);
        // Cap the raw message at 200 chars so PostHog event cardinality stays
        // bounded when backend errors include user input or random ids.
        const rawMessage =
          error instanceof Error ? error.message : String(error);
        posthog.capture("eval_generate_tests_completed", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suiteId,
          generated_count: 0,
          success: false,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: rawMessage.slice(0, 200),
        });
        toast.error(
          getBillingErrorMessage(error, "Failed to generate test cases")
        );
      } finally {
        setIsGeneratingTests(false);
      }
    },
    [
      isGeneratingTests,
      getAccessToken,
      convex,
      mutations.createTestCaseMutation,
      projectId,
      connectedServerNames,
      ensureServersReady,
      projectServers,
      isDirectGuest,
      getTestCasesForRerun,
      handleRunTestCase,
    ],
  );

  return {
    // Handlers
    handleRerun,
    handleRunTestCase,
    handleReplayRun,
    handleDelete,
    confirmDelete,
    handleDuplicateSuite,
    handleCancelRun,
    handleDeleteRun,
    directDeleteRun,
    confirmDeleteRun,
    handleCreateTestCase,
    handleCreateWidgetProbe,
    handleDeleteTestCase,
    directDeleteTestCase,
    confirmDeleteTestCase,
    handleDuplicateTestCase,
    handleGenerateTests,
    // States
    rerunningSuiteId,
    runningTestCaseId,
    replayingRunId,
    cancellingRunId,
    deletingSuiteId,
    suiteToDelete,
    setSuiteToDelete,
    duplicatingSuiteId,
    deletingRunId,
    runToDelete,
    setRunToDelete,
    isCreatingTestCase,
    deletingTestCaseId,
    duplicatingTestCaseId,
    testCaseToDelete,
    setTestCaseToDelete,
    isGeneratingTests,
  };
}
