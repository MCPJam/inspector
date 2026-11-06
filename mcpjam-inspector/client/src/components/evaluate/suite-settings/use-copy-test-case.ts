import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import type { EvalSuite } from "@/components/evals/types";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import type { CopyTarget } from "./suite-cases-card";

export type CopyTestCaseArgs = { testCaseId: string; targetSuiteId: string };
export type CopyTestCaseResult = { testCaseId: string; title: string };

/** Copies one case's definition (never its runs) into another suite. */
export const copyTestCaseToSuiteRef = makeFunctionReference<
  "mutation",
  CopyTestCaseArgs,
  CopyTestCaseResult
>("testCaseCopy:copyTestCaseToSuite");

/** Every other suite in the project, in Suites-list order; CI-owned ones locked. */
export function buildCopyTargets(
  suites: readonly EvalSuite[],
  currentSuiteId: string,
): CopyTarget[] {
  return suites
    .filter((suite) => suite._id !== currentSuiteId)
    .map((suite) => ({
      suiteId: suite._id,
      name: stripTimestampSuffix(suite.name),
      locked: isCiOwnedSuite(suite),
    }));
}

export function copiedToastTitle(caseTitle: string, suiteName: string): string {
  return `Copied “${caseTitle}” to ${suiteName}`;
}

/** Open copy on its own line as a primary text link, for this toast only. */
const OPEN_COPY_ACTION_CLASS =
  "!ml-0 !mt-1 !h-auto !basis-full !justify-start !rounded-none !bg-transparent !p-0 !text-xs !font-medium !text-primary underline-offset-2 hover:underline";

/** The success toast: no icon, Open copy as a text link on its own line. */
export function showCopiedToast(
  caseTitle: string,
  suiteName: string,
  onOpenCopy: () => void,
) {
  toast(copiedToastTitle(caseTitle, suiteName), {
    description: "Runs were not copied.",
    action: { label: "Open copy", onClick: onOpenCopy },
    closeButton: false,
    classNames: {
      toast: "!gap-y-0 !py-3",
      title: "!leading-5",
      description: "!text-xs",
      actionButton: OPEN_COPY_ACTION_CLASS,
    },
  });
}

export function useCopyTestCase(args: {
  onOpenCopy(copy: { suiteId: string; testCaseId: string }): void;
}): {
  pendingCaseId: string | null;
  copy(
    testCase: { caseId: string; title: string },
    target: CopyTarget,
  ): Promise<void>;
} {
  const copyMutation = useMutation(copyTestCaseToSuiteRef);
  const [pendingCaseId, setPendingCaseId] = useState<string | null>(null);
  // The backend has no idempotency key, so a second pick while one is in
  // flight would make a second copy. A ref answers before the re-render.
  const inFlight = useRef(false);
  const onOpenCopyRef = useRef(args.onOpenCopy);
  useEffect(() => {
    onOpenCopyRef.current = args.onOpenCopy;
  }, [args.onOpenCopy]);

  const copy = useCallback(
    async (testCase: { caseId: string; title: string }, target: CopyTarget) => {
      if (inFlight.current || target.locked) return;
      inFlight.current = true;
      setPendingCaseId(testCase.caseId);
      try {
        const result = await copyMutation({
          testCaseId: testCase.caseId,
          targetSuiteId: target.suiteId,
        });
        showCopiedToast(testCase.title, target.name, () =>
          onOpenCopyRef.current({
            suiteId: target.suiteId,
            testCaseId: result.testCaseId,
          }),
        );
      } catch (error) {
        toast.error(
          convexErrMessage(
            error,
            `Could not copy “${testCase.title}” to ${target.name}. Try again.`,
          ),
        );
      } finally {
        inFlight.current = false;
        setPendingCaseId(null);
      }
    },
    [copyMutation],
  );

  return { pendingCaseId, copy };
}
