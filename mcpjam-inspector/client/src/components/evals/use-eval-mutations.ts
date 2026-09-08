import { useMemo } from "react";
import { useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { CI_OWNED_REASON_COPY } from "@/lib/evals/is-ci-owned-suite";

/** The platform's refusal code for a write to a CI-owned suite. */
const CI_OWNED_SUITE_READ_ONLY = "CI_OWNED_SUITE_READ_ONLY";

/**
 * Report the CI-ownership refusal for the one write whose errors nobody else
 * reports, then rethrow.
 *
 * Applied to `createTestCase` ALONE, and the narrowness is the point. The
 * refusal is a `ConvexError`, so its message survives to the client on
 * `err.data` — which is why the backend throws one — and every other caller
 * here already renders that message through `getBillingErrorMessage`. Wrapping
 * those too produced two toasts for one refusal, the wrapper's short line and
 * then the platform's fuller one ("its configuration lives in your
 * repository"), with the better sentence arriving second.
 *
 * `createTestCase` is the exception because `generateAndPersistEvalTests`
 * deliberately swallows a per-case failure — it is generating many, and one
 * that will not persist should not abort the batch — so without this a locked
 * suite would answer "Generate tests" with silence and zero new cases.
 *
 * RETHROWN, not swallowed: the caller decides what else to do, and returning
 * normally would tell it the write succeeded.
 */
function withCiOwnedToast<TArgs, TResult>(
  mutation: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    try {
      return await mutation(args);
    } catch (error) {
      const data = (error as { data?: { code?: unknown } } | null)?.data;
      if (data?.code === CI_OWNED_SUITE_READ_ONLY) {
        toast.error(CI_OWNED_REASON_COPY);
      }
      throw error;
    }
  };
}

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
    "testSuites:duplicateTestSuite" as any,
  );
  const convexCreateTestCase = useMutation("testSuites:createTestCase" as any);
  const convexDeleteTestCase = useMutation("testSuites:deleteTestCase" as any);
  const convexDuplicateTestCase = useMutation(
    "testSuites:duplicateTestCase" as any,
  );
  const convexCreateTestSuite = useMutation(
    "testSuites:createTestSuite" as any,
  );
  const updateTestSuiteMutation = useMutation(
    "testSuites:updateTestSuite" as any,
  );

  const mutations = useMemo(() => {
    if (!isDirectGuest) {
      return {
        deleteSuiteMutation: convexDeleteSuite,
        deleteRunMutation: convexDeleteRun,
        cancelRunMutation: convexCancelRun,
        // Duplicate is the escape hatch out of the lock, and the platform never
        // refuses it.
        duplicateSuiteMutation: convexDuplicateSuite,
        createTestCaseMutation: withCiOwnedToast(convexCreateTestCase),
        deleteTestCaseMutation: convexDeleteTestCase,
        duplicateTestCaseMutation: convexDuplicateTestCase,
        createTestSuiteMutation: convexCreateTestSuite,
        updateTestSuiteMutation,
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
      createTestCaseMutation: withCiOwnedToast(convexCreateTestCase),
      deleteTestCaseMutation: convexDeleteTestCase,
      duplicateTestCaseMutation: guestUnsupported,
      createTestSuiteMutation: convexCreateTestSuite,
      updateTestSuiteMutation,
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
    updateTestSuiteMutation,
  ]);

  return mutations;
}
