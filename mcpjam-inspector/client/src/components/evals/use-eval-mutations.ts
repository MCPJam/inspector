import { useMemo } from "react";
import { useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { CI_OWNED_REASON_COPY } from "@/lib/evals/is-ci-owned-suite";

/** The platform's refusal code for a write to a CI-owned suite. */
const CI_OWNED_SUITE_READ_ONLY = "CI_OWNED_SUITE_READ_ONLY";

/**
 * Turn the CI-ownership refusal into the sentence the disabled controls
 * already use, then rethrow.
 *
 * The UI disables these controls, so in normal use this never fires. It fires
 * when the two disagree — a suite that became CI-owned in another tab, a client
 * older than the lock, a backend that starts refusing something this build does
 * not know about yet. Convex redacts plain errors in production, so without
 * this the person gets "Server Error" for a decision that has a clear cause and
 * two clear remedies.
 *
 * RETHROWN, not swallowed: every caller has its own catch that decides what
 * else to do (revert an optimistic edit, keep a dialog open), and returning
 * normally here would tell them the write succeeded.
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

  // Wrapped once, at the seam, rather than at each of the ~dozen call sites:
  // the refusal is a property of the mutation, not of who called it. Only the
  // writes the lock can refuse are wrapped — `duplicateTestSuite` is the escape
  // hatch and must never be, and the run mutations are deliberately allowed.
  const mutations = useMemo(() => {
    if (!isDirectGuest) {
      return {
        deleteSuiteMutation: withCiOwnedToast(convexDeleteSuite),
        deleteRunMutation: convexDeleteRun,
        cancelRunMutation: convexCancelRun,
        // NOT wrapped: duplicate is the escape hatch out of the lock, and the
        // platform never refuses it.
        duplicateSuiteMutation: convexDuplicateSuite,
        createTestCaseMutation: withCiOwnedToast(convexCreateTestCase),
        deleteTestCaseMutation: withCiOwnedToast(convexDeleteTestCase),
        duplicateTestCaseMutation: withCiOwnedToast(convexDuplicateTestCase),
        createTestSuiteMutation: convexCreateTestSuite,
        updateTestSuiteMutation: withCiOwnedToast(updateTestSuiteMutation),
      };
    }

    const guestUnsupported = async () => {
      throw new Error("Not available for guests yet. Sign in to use this.");
    };

    return {
      deleteSuiteMutation: withCiOwnedToast(convexDeleteSuite),
      deleteRunMutation: guestUnsupported,
      cancelRunMutation: guestUnsupported,
      duplicateSuiteMutation: guestUnsupported,
      createTestCaseMutation: withCiOwnedToast(convexCreateTestCase),
      deleteTestCaseMutation: withCiOwnedToast(convexDeleteTestCase),
      duplicateTestCaseMutation: guestUnsupported,
      createTestSuiteMutation: convexCreateTestSuite,
      updateTestSuiteMutation: withCiOwnedToast(updateTestSuiteMutation),
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
