import { useMemo } from "react";
import { useMutation } from "convex/react";

/**
 * Hook for all eval mutations (delete, duplicate, cancel, etc.)
 */
export function useEvalMutations({
  isDirectGuest = false,
}: { isDirectGuest?: boolean } = {}) {
  const convexDeleteSuite = useMutation("testSuites:deleteTestSuite" as any);
  const convexDeleteRun = useMutation("testSuites:deleteTestSuiteRun" as any);
  const convexCancelRun = useMutation("testSuites:cancelTestSuiteRun" as any);
  const convexDuplicateSuite = useMutation(
    "testSuites:duplicateTestSuite" as any
  );
  const convexCreateTestCase = useMutation("testSuites:createTestCase" as any);
  const convexDeleteTestCase = useMutation("testSuites:deleteTestCase" as any);
  const convexDuplicateTestCase = useMutation(
    "testSuites:duplicateTestCase" as any
  );
  const convexCreateTestSuite = useMutation(
    "testSuites:createTestSuite" as any
  );

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
      throw new Error("Not available for guests yet. Sign in to use this.");
    };

    return {
      deleteSuiteMutation: convexDeleteSuite,
      deleteRunMutation: guestUnsupported,
      cancelRunMutation: guestUnsupported,
      duplicateSuiteMutation: guestUnsupported,
      createTestCaseMutation: convexCreateTestCase,
      deleteTestCaseMutation: convexDeleteTestCase,
      duplicateTestCaseMutation: guestUnsupported,
      createTestSuiteMutation: convexCreateTestSuite,
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
  ]);

  return mutations;
}
