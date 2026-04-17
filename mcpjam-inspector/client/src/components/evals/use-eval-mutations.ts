import { useMemo } from "react";
import { useMutation } from "convex/react";
import { useGuestEvalsStore } from "@/stores/guest-evals-store";

/**
 * Hook for all eval mutations (delete, duplicate, cancel, etc.)
 *
 * When `isDirectGuest` is true, returns wrappers that read/write the
 * guest evals store instead of Convex. Mutations that have no meaning
 * for guests (run/cancel/duplicate-suite) throw.
 */
export function useEvalMutations({
  isDirectGuest = false,
}: { isDirectGuest?: boolean } = {}) {
  const convexDeleteSuite = useMutation("testSuites:deleteTestSuite" as any);
  const convexDeleteRun = useMutation("testSuites:deleteTestSuiteRun" as any);
  const convexCancelRun = useMutation("testSuites:cancelTestSuiteRun" as any);
  const convexDuplicateSuite = useMutation(
    "testSuites:duplicateTestSuite" as any,
  );
  const convexCreateTestCase = useMutation(
    "testSuites:createTestCase" as any,
  );
  const convexDeleteTestCase = useMutation(
    "testSuites:deleteTestCase" as any,
  );
  const convexDuplicateTestCase = useMutation(
    "testSuites:duplicateTestCase" as any,
  );
  const convexCreateTestSuite = useMutation(
    "testSuites:createTestSuite" as any,
  );

  const guestStore = useGuestEvalsStore;

  const mutations = useMemo(() => {
    if (!isDirectGuest) {
      return {
        deleteSuiteMutation: convexDeleteSuite,
        deleteRunMutation: convexDeleteRun,
        cancelRunMutation: convexCancelRun,
        duplicateSuiteMutation: convexDuplicateSuite,
        createTestCaseMutation: convexCreateTestCase,
        deleteTestCaseMutation: convexDeleteTestCase,
        duplicateTestCaseMutation: convexDuplicateTestCase,
        createTestSuiteMutation: convexCreateTestSuite,
      };
    }

    const guestUnsupported = async () => {
      throw new Error("Not available in guest mode");
    };

    return {
      deleteSuiteMutation: async ({ suiteId: _suiteId }: { suiteId: string }) => {
        // Suites are created per server and managed via the explore flow;
        // guests never need to delete a suite directly.
        return null;
      },
      deleteRunMutation: guestUnsupported,
      cancelRunMutation: guestUnsupported,
      duplicateSuiteMutation: guestUnsupported,
      createTestCaseMutation: async (input: {
        suiteId: string;
        title: string;
        query: string;
        models: Array<{ model: string; provider: string }>;
        runs?: number;
        expectedToolCalls?: Array<{
          toolName: string;
          arguments: Record<string, unknown>;
        }>;
        isNegativeTest?: boolean;
        scenario?: string;
        expectedOutput?: string;
        promptTurns?: any;
        advancedConfig?: Record<string, unknown>;
      }) => {
        const created = guestStore.getState().createTestCase(input);
        return created?._id ?? null;
      },
      deleteTestCaseMutation: async ({
        testCaseId,
      }: {
        testCaseId: string;
      }) => {
        guestStore.getState().deleteTestCase(testCaseId);
        return null;
      },
      duplicateTestCaseMutation: async ({
        testCaseId,
      }: {
        testCaseId: string;
      }) => {
        const copy = guestStore.getState().duplicateTestCase(testCaseId);
        return copy ?? null;
      },
      createTestSuiteMutation: async (args: {
        workspaceId?: string | null;
        name: string;
        description?: string;
        environment?: { servers?: string[] };
      }) => {
        const serverName = args.environment?.servers?.[0] ?? args.name;
        const suite = guestStore.getState().ensureSuite(serverName);
        return suite;
      },
    };
  }, [
    isDirectGuest,
    convexDeleteSuite,
    convexDeleteRun,
    convexCancelRun,
    convexDuplicateSuite,
    convexCreateTestCase,
    convexDeleteTestCase,
    convexDuplicateTestCase,
    convexCreateTestSuite,
    guestStore,
  ]);

  return mutations;
}
