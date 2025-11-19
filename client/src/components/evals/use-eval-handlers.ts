import { useCallback, useState } from "react";
import { useConvex } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { detectPlatform, detectEnvironment } from "@/logs/PosthogUtils";
import { useAiProviderKeys, type ProviderTokens } from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import type { EvalSuite, EvalSuiteOverviewEntry } from "./types";
import type { useEvalMutations } from "./use-eval-mutations";

interface UseEvalHandlersProps {
  mutations: ReturnType<typeof useEvalMutations>;
  selectedSuiteEntry: EvalSuiteOverviewEntry | null;
  selectedSuiteId: string | null;
  selectedTestId: string | null;
}

/**
 * Hook for all eval event handlers (rerun, delete, duplicate, etc.)
 */
export function useEvalHandlers({
  mutations,
  selectedSuiteEntry,
  selectedSuiteId,
  selectedTestId,
}: UseEvalHandlersProps) {
  const convex = useConvex();
  const { getAccessToken } = useAuth();
  const { getToken, hasToken } = useAiProviderKeys();

  // Action states
  const [rerunningSuiteId, setRerunningSuiteId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [deletingSuiteId, setDeletingSuiteId] = useState<string | null>(null);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);
  const [duplicatingSuiteId, setDuplicatingSuiteId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [runToDelete, setRunToDelete] = useState<string | null>(null);
  const [isCreatingTestCase, setIsCreatingTestCase] = useState(false);
  const [deletingTestCaseId, setDeletingTestCaseId] = useState<string | null>(null);
  const [duplicatingTestCaseId, setDuplicatingTestCaseId] = useState<string | null>(null);
  const [testCaseToDelete, setTestCaseToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // Query to get test cases for a suite
  const getTestCasesForRerun = useCallback(
    async (suiteId: string) => {
      try {
        const testCases = await convex.query(
          "testSuites:listTestCases" as any,
          { suiteId },
        );
        return testCases;
      } catch (error) {
        console.error("Failed to fetch test cases:", error);
        return [];
      }
    },
    [convex],
  );

  // Rerun handler
  const handleRerun = useCallback(
    async (suite: EvalSuite) => {
      if (rerunningSuiteId) return;

      const suiteServers = suite.environment?.servers || [];

      // Get current test cases from database (not from stale config)
      const testCases = (await getTestCasesForRerun(suite._id)) as any[];
      if (!testCases || testCases.length === 0) {
        toast.error("No test cases found in this suite");
        return;
      }

      // Generate tests array by expanding each test case's models
      const tests: any[] = [];

      for (const testCase of testCases) {
        // Skip test cases with no models
        if (!testCase.models || testCase.models.length === 0) {
          continue;
        }

        // Create one test per model
        for (const modelConfig of testCase.models) {
          tests.push({
            title: testCase.title,
            query: testCase.query,
            runs: testCase.runs || 1,
            model: modelConfig.model,
            provider: modelConfig.provider,
            expectedToolCalls: testCase.expectedToolCalls || [],
            advancedConfig: testCase.advancedConfig,
            testCaseId: testCase._id,
          });
        }
      }

      if (tests.length === 0) {
        toast.error("No tests to run. Please add models to your test cases.");
        return;
      }

      // Collect API keys for all providers used in the tests
      const modelApiKeys: Record<string, string> = {};
      const providersNeeded = new Set<string>();

      for (const test of tests) {
        if (!isMCPJamProvidedModel(test.model)) {
          providersNeeded.add(test.provider);
        }
      }

      // Check that we have all required API keys
      for (const provider of providersNeeded) {
        const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
        if (!hasToken(tokenKey)) {
          toast.error(
            `Please add your ${provider} API key in Settings before running evals`,
          );
          return;
        }
        const key = getToken(tokenKey);
        if (key) {
          modelApiKeys[provider] = key;
        }
      }

      setRerunningSuiteId(suite._id);

      // Show toast immediately when user clicks rerun
      toast.success(
        "Eval run started successfully! Results will appear shortly.",
      );

      try {
        const accessToken = await getAccessToken();

        // Get pass criteria from suite's defaultPassCriteria, or fall back to latest run, or default to 100%
        const suiteDefault = suite.defaultPassCriteria?.minimumPassRate;
        const latestRun = selectedSuiteEntry?.latestRun;
        const minimumPassRate =
          suiteDefault ?? latestRun?.passCriteria?.minimumPassRate ?? 100;
        const criteriaNote = `Pass Criteria: Min ${minimumPassRate}% Accuracy`;

        const response = await fetch("/api/mcp/evals/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suiteId: suite._id,
            suiteName: suite.name,
            suiteDescription: suite.description,
            tests: tests.map((test) => ({
              title: test.title,
              query: test.query,
              runs: test.runs ?? 1,
              model: test.model,
              provider: test.provider,
              expectedToolCalls: test.expectedToolCalls,
              advancedConfig: test.advancedConfig,
            })),
            serverIds: suiteServers,
            modelApiKeys:
              Object.keys(modelApiKeys).length > 0 ? modelApiKeys : undefined,
            convexAuthToken: accessToken,
            passCriteria: {
              minimumPassRate: minimumPassRate,
            },
            notes: criteriaNote,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Failed to start eval run");
        }

        // Track suite run started
        posthog.capture("eval_suite_run_started", {
          location: "evals_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          suite_id: suite._id,
          num_test_cases: testCases.length,
          num_tests: tests.length,
          num_models: providersNeeded.size,
          minimum_pass_rate: minimumPassRate,
        });

        // Optionally show completion toast
        toast.success("Eval run completed!");
      } catch (error) {
        console.error("Failed to rerun evals:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to start eval run",
        );
      } finally {
        setRerunningSuiteId(null);
      }
    },
    [
      rerunningSuiteId,
      selectedSuiteEntry,
      getAccessToken,
      hasToken,
      getToken,
      getTestCasesForRerun,
    ],
  );

  // Delete handler - opens confirmation modal
  const handleDelete = useCallback(
    (suite: EvalSuite) => {
      if (deletingSuiteId) return;
      setSuiteToDelete(suite);
    },
    [deletingSuiteId],
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
      toast.error(
        error instanceof Error ? error.message : "Failed to delete test suite",
      );
    } finally {
      setDeletingSuiteId(null);
    }
  }, [suiteToDelete, deletingSuiteId, mutations.deleteSuiteMutation, selectedSuiteId]);

  // Duplicate suite handler
  const handleDuplicateSuite = useCallback(
    async (suite: EvalSuite) => {
      if (duplicatingSuiteId) return;

      setDuplicatingSuiteId(suite._id);

      try {
        const newSuite = await mutations.duplicateSuiteMutation({ suiteId: suite._id });
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
          error instanceof Error
            ? error.message
            : "Failed to duplicate test suite",
        );
      } finally {
        setDuplicatingSuiteId(null);
      }
    },
    [duplicatingSuiteId, mutations.duplicateSuiteMutation],
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
        toast.error(
          error instanceof Error ? error.message : "Failed to cancel run",
        );
      } finally {
        setCancellingRunId(null);
      }
    },
    [cancellingRunId, mutations.cancelRunMutation],
  );

  // Delete run handler - opens confirmation modal (for single run from detail view)
  const handleDeleteRun = useCallback(
    (runId: string) => {
      if (deletingRunId) return;
      setRunToDelete(runId);
    },
    [deletingRunId],
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
    [mutations.deleteRunMutation],
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
      toast.error(
        error instanceof Error ? error.message : "Failed to delete run",
      );
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
        // Get test cases for the suite to extract models
        const testCases = await convex.query(
          "testSuites:listTestCases" as any,
          { suiteId },
        );

        // Extract unique models from existing test cases
        let modelsToUse: any[] = [];
        if (testCases && Array.isArray(testCases) && testCases.length > 0) {
          const uniqueModels = new Map<
            string,
            { model: string; provider: string }
          >();

          for (const testCase of testCases) {
            if (testCase.models && Array.isArray(testCase.models)) {
              for (const modelConfig of testCase.models) {
                if (modelConfig.model && modelConfig.provider) {
                  const key = `${modelConfig.provider}:${modelConfig.model}`;
                  if (!uniqueModels.has(key)) {
                    uniqueModels.set(key, {
                      model: modelConfig.model,
                      provider: modelConfig.provider,
                    });
                  }
                }
              }
            }
          }

          modelsToUse = Array.from(uniqueModels.values());
        }

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

        // Navigate to the new test case
        navigateToEvalsRoute({
          type: "test-detail",
          suiteId,
          testId: testCaseId,
        });

        return testCaseId;
      } catch (error) {
        console.error("Failed to create test case:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to create test case",
        );
        return null;
      } finally {
        setIsCreatingTestCase(false);
      }
    },
    [isCreatingTestCase, mutations.createTestCaseMutation, convex],
  );

  // Handle delete test case - opens confirmation modal
  const handleDeleteTestCase = useCallback(
    (testCaseId: string, testCaseTitle: string) => {
      if (deletingTestCaseId) return;
      setTestCaseToDelete({ id: testCaseId, title: testCaseTitle });
    },
    [deletingTestCaseId],
  );

  // Confirm test case deletion
  const confirmDeleteTestCase = useCallback(async () => {
    if (!testCaseToDelete || deletingTestCaseId) return;

    setDeletingTestCaseId(testCaseToDelete.id);

    try {
      await mutations.deleteTestCaseMutation({ testCaseId: testCaseToDelete.id });
      toast.success("Test case deleted successfully");

      // If we're viewing this test case, navigate back to suite overview
      if (selectedTestId === testCaseToDelete.id && selectedSuiteId) {
        navigateToEvalsRoute({
          type: "suite-overview",
          suiteId: selectedSuiteId,
        });
      }

      setTestCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete test case",
      );
    } finally {
      setDeletingTestCaseId(null);
    }
  }, [
    testCaseToDelete,
    deletingTestCaseId,
    mutations.deleteTestCaseMutation,
    selectedTestId,
    selectedSuiteId,
  ]);

  // Duplicate test case handler
  const handleDuplicateTestCase = useCallback(
    async (testCaseId: string, suiteId: string) => {
      if (duplicatingTestCaseId) return;

      setDuplicatingTestCaseId(testCaseId);

      try {
        const newTestCase = await mutations.duplicateTestCaseMutation({ testCaseId });
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
          navigateToEvalsRoute({
            type: "test-edit",
            suiteId,
            testId: newTestCase._id,
          });
        }

        return newTestCase;
      } catch (error) {
        console.error("Failed to duplicate test case:", error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to duplicate test case",
        );
        return null;
      } finally {
        setDuplicatingTestCaseId(null);
      }
    },
    [duplicatingTestCaseId, mutations.duplicateTestCaseMutation],
  );

  return {
    // Handlers
    handleRerun,
    handleDelete,
    confirmDelete,
    handleDuplicateSuite,
    handleCancelRun,
    handleDeleteRun,
    directDeleteRun,
    confirmDeleteRun,
    handleCreateTestCase,
    handleDeleteTestCase,
    confirmDeleteTestCase,
    handleDuplicateTestCase,
    // States
    rerunningSuiteId,
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
  };
}
