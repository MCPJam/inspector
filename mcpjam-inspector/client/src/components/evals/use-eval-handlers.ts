import { useCallback, useState } from "react";
import { useConvex } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";
import { navigateToEvalsRoute, type EvalsRoute } from "@/lib/evals-router";
import {
  navigateToCiEvalsRoute,
  type CiEvalsRoute,
} from "@/lib/ci-evals-router";
import type { SuiteOverviewView } from "@/lib/eval-route-types";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "./types";
import { getSuiteReplayEligibility } from "./replay-eligibility";
import type { useEvalMutations } from "./use-eval-mutations";
import { authFetch } from "@/lib/session-token";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
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
import { getGuestBearerToken } from "@/lib/guest-session";
import {
  getDefaultTestCaseModelValue,
  prepareSingleTestCaseRun,
} from "./single-test-case-runner";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { RemoteServer } from "@/hooks/useWorkspaces";
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
  workspaceServers: RemoteServer[] | undefined,
) {
  if (result.missingServerNames.length > 0) {
    // Never list server names/ids in this toast: refs may be legacy Convex
    // ids or other opaque values that read like random strings.
    const n = result.missingServerNames.length;
    const isTest = actionLabel.includes("test case");
    if (n === 1) {
      return isTest
        ? `Unable to ${actionLabel}. This test depends on an MCP server that is no longer in this workspace.`
        : `Unable to ${actionLabel}. This suite depends on an MCP server that is no longer in this workspace.`;
    }
    return isTest
      ? `Unable to ${actionLabel}. This test depends on ${n} MCP servers that are no longer in this workspace.`
      : `Unable to ${actionLabel}. This suite depends on ${n} MCP servers that are no longer in this workspace.`;
  }

  if (result.reauthServerNames.length > 0) {
    const names = result.reauthServerNames;
    const opts = { remoteServers: workspaceServers };
    if (names.length > 0 && names.every((r) => isUnresolvableMcpServerRef(r, opts))) {
      return `Re-authenticate, then try to ${actionLabel}.`;
    }
    return `Re-authenticate with ${formatMcpServerRefsForError(names, opts)} to ${actionLabel}.`;
  }

  if (result.failedServerNames.length > 0) {
    const names = result.failedServerNames;
    const opts = { remoteServers: workspaceServers };
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
};

interface UseEvalHandlersProps {
  mutations: ReturnType<typeof useEvalMutations>;
  selectedSuiteEntry: EvalSuiteOverviewEntry | null;
  selectedSuiteId: string | null;
  selectedTestId: string | null;
  workspaceId?: string | null;
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
  workspaceServers?: RemoteServer[];
  /** When true, this uses the direct-guest eval playground flow. */
  isDirectGuest?: boolean;
}

/**
 * Hook for all eval event handlers (rerun, delete, duplicate, etc.)
 */
export function useEvalHandlers({
  mutations,
  selectedSuiteEntry,
  selectedSuiteId,
  selectedTestId,
  workspaceId = null,
  connectedServerNames,
  ensureServersReady,
  latestRunBySuiteId,
  evalsNavigationContext = "evals",
  workspaceServers,
  isDirectGuest = false,
}: UseEvalHandlersProps) {
  const convex = useConvex();
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();

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
      if (evalsNavigationContext === "ci-evals") {
        navigateToCiEvalsRoute(route as CiEvalsRoute);
      } else {
        navigateToEvalsRoute(route as EvalsRoute);
      }
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

      for (const testCase of testCases) {
        if (!testCase.models || testCase.models.length === 0) {
          continue;
        }

        for (const modelConfig of testCase.models) {
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
            testCaseId: testCase._id,
          });

          if (!isMCPJamProvidedModel(modelConfig.model, modelConfig.provider)) {
            providersNeeded.add(modelConfig.provider);
          }
        }
      }

      if (tests.length === 0) {
        toast.error("No tests to run. Please add models to your test cases.");
        return null;
      }

      const modelApiKeys: Record<string, string> = {};
      for (const provider of providersNeeded) {
        const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
        if (!hasToken(tokenKey)) {
          toast.error(
            `Please add your ${provider} API key in Settings before running evals`
          );
          return null;
        }
        const key = getToken(tokenKey);
        if (key) {
          modelApiKeys[provider] = key;
        }
      }

      return {
        suiteServers: normalizeSuiteServerRefs(suite.environment?.servers),
        testCases,
        tests,
        modelApiKeys,
        providersNeeded,
      };
    },
    [getTestCasesForRerun, getToken, hasToken]
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
        const accessToken = await getAccessToken();
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
          navigateToCiEvalsRoute({
            type: "run-detail",
            suiteId: result.suiteId,
            runId: result.runId,
            insightsFocus: true,
          });
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
    async (suite: EvalSuite) => {
      if (rerunningSuiteId) return;

      const suiteServers = normalizeSuiteServerRefs(suite.environment?.servers);
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
        toast.error("No MCP servers are configured for this suite.");
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
                workspaceServers,
              ),
            );
            return;
          }
        } else {
          toast.error(
            formatMcpConnectServerPrompt(rerunEligibility.missingServers, {
              remoteServers: workspaceServers,
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

      // Show toast immediately when user clicks rerun
      toast.success("Run started successfully! Results will appear shortly.");

      try {
        const accessToken = await getAccessToken();

        // Get pass criteria from suite's defaultPassCriteria, or fall back to latest run, or default to 100%
        const suiteDefault = suite.defaultPassCriteria?.minimumPassRate;
        const minimumPassRate =
          suiteDefault ?? latestRun?.passCriteria?.minimumPassRate ?? 100;
        const criteriaNote = `Pass Criteria: Min ${minimumPassRate}% Accuracy`;

        await runEvals({
          workspaceId,
          suiteId: suite._id,
          suiteName: suite.name,
          suiteDescription: suite.description,
          tests: executionContext.tests.map((test) => ({
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
          })),
          serverIds: executionContext.suiteServers,
          modelApiKeys:
            Object.keys(executionContext.modelApiKeys).length > 0
              ? executionContext.modelApiKeys
              : undefined,
          convexAuthToken: accessToken,
          passCriteria: {
            minimumPassRate: minimumPassRate,
          },
          notes: criteriaNote,
        });

        // Track suite run started
        posthog.capture("eval_suite_run_started", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          num_test_cases: executionContext.testCases.length,
          num_tests: executionContext.tests.length,
          num_models: executionContext.providersNeeded.size,
          minimum_pass_rate: minimumPassRate,
        });

        // Optionally show completion toast
        toast.success("Eval run completed!");
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
      workspaceId,
      workspaceServers,
      getSuiteExecutionContext,
      handleReplayRun,
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
      },
    ) => {
      if (runningTestCaseId || rerunningSuiteId || replayingRunId) {
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
      const suiteServers = normalizeSuiteServerRefs(suite.environment?.servers);
      const disconnectedSuiteServers = suiteServers.filter(
        (serverName) => !connectedServerNames?.has(serverName),
      );

      if (suiteServers.length === 0) {
        toast.error("No MCP servers are configured for this suite.");
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
                workspaceServers,
              ),
            );
            return null;
          }
        } else {
          toast.error(
            formatMcpConnectServerPrompt(disconnectedSuiteServers, {
              remoteServers: workspaceServers,
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
              workspaceId: isDirectGuest ? null : workspaceId,
              suite: {
                environment: {
                  ...suite.environment,
                  servers: suiteServers,
                },
              },
              testCase,
              getAccessToken: isDirectGuest
                ? getGuestBearerToken
                : getAccessToken,
              getToken,
              hasToken,
              selectedModel,
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
      workspaceId,
      getAccessToken,
      getToken,
      hasToken,
      connectedServerNames,
      ensureServersReady,
      workspaceServers,
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
        navigateToEvalsRoute({ type: "list" });
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
          navigateToEvalsRoute({
            type: "suite-overview",
            suiteId: newSuite._id,
          });
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
    },
    [mutations.deleteTestCaseMutation]
  );

  // Confirm test case deletion
  const confirmDeleteTestCase = useCallback(async () => {
    if (!testCaseToDelete || deletingTestCaseId) return;

    setDeletingTestCaseId(testCaseToDelete.id);

    try {
      await mutations.deleteTestCaseMutation({
        testCaseId: testCaseToDelete.id,
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
                workspaceServers,
              ),
            );
            return;
          }
        } else {
          toast.error(
            formatMcpConnectServerPrompt(disconnected, {
              remoteServers: workspaceServers,
              kind: "suite",
            }),
          );
          return;
        }
      }

      setIsGeneratingTests(true);

      try {
        const outcome = await generateAndPersistEvalTests({
          convex,
          getAccessToken,
          workspaceId,
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
        });

        if (outcome.apiReturnedTests === 0) {
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
      workspaceId,
      connectedServerNames,
      ensureServersReady,
      workspaceServers,
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
