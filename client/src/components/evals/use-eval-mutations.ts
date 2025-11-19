import { useMutation } from "convex/react";

/**
 * Hook for all eval mutations (delete, duplicate, cancel, etc.)
 */
export function useEvalMutations() {
  const deleteSuiteMutation = useMutation("testSuites:deleteTestSuite" as any);
  const deleteRunMutation = useMutation("testSuites:deleteTestSuiteRun" as any);
  const cancelRunMutation = useMutation("testSuites:cancelTestSuiteRun" as any);
  const duplicateSuiteMutation = useMutation(
    "testSuites:duplicateTestSuite" as any,
  );
  const createTestCaseMutation = useMutation(
    "testSuites:createTestCase" as any,
  );
  const deleteTestCaseMutation = useMutation(
    "testSuites:deleteTestCase" as any,
  );
  const duplicateTestCaseMutation = useMutation(
    "testSuites:duplicateTestCase" as any,
  );

  return {
    deleteSuiteMutation,
    deleteRunMutation,
    cancelRunMutation,
    duplicateSuiteMutation,
    createTestCaseMutation,
    deleteTestCaseMutation,
    duplicateTestCaseMutation,
  };
}
