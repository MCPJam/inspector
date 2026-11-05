import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { track } from "@/lib/analytics";
import { convexErrMessage } from "@/lib/convex-error";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteOverviewEntry,
} from "../../evals/types";

export const CI_LOCKED_COPY_TARGET_REASON =
  "Runs from CI. Edit its cases in the repo.";
const COPY_FAILED_FALLBACK =
  "The test case wasn't copied. Try again, or pick another suite.";

const suitesOverviewQuery = makeFunctionReference<
  "query",
  { projectId: string },
  EvalSuiteOverviewEntry[]
>("testSuites:getTestSuitesOverview");
const duplicateTestCaseMutation = makeFunctionReference<
  "mutation",
  { testCaseId: string; targetSuiteId?: string },
  EvalCase
>("testSuites:duplicateTestCase");

export interface CopyTarget {
  suite: EvalSuite;
  /** Why the case cannot be copied there; absent when it can. */
  disabledReason?: string;
}

/** Every other suite in the project, CI-owned ones disabled (D8). */
export function copyTargets(
  entries: readonly EvalSuiteOverviewEntry[],
  sourceSuiteId: string,
): CopyTarget[] {
  return entries
    .map((entry) => entry.suite)
    .filter((suite) => suite._id !== sourceSuiteId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((suite) =>
      isCiOwnedSuite(suite)
        ? { suite, disabledReason: CI_LOCKED_COPY_TARGET_REASON }
        : { suite },
    );
}

/**
 * Copy a case's definition into another suite (D3, D6). The person stays on
 * the page; the toast links to the copy (D7).
 */
export function useCopyCaseToSuite({
  projectId,
  sourceSuiteId,
  onOpenCopy,
}: {
  projectId: string | null;
  sourceSuiteId: string;
  onOpenCopy: (suiteId: string, caseId: string) => void;
}) {
  const overview = useQuery(
    suitesOverviewQuery,
    projectId ? { projectId } : "skip",
  );
  const targets = useMemo(
    () => copyTargets(overview ?? [], sourceSuiteId),
    [overview, sourceSuiteId],
  );
  const duplicate = useMutation(duplicateTestCaseMutation);
  const [copyingCaseId, setCopyingCaseId] = useState<string | null>(null);

  const copyCase = useCallback(
    async (testCase: EvalCase, target: EvalSuite) => {
      setCopyingCaseId(testCase._id);
      try {
        const copy = await duplicate({
          testCaseId: testCase._id,
          targetSuiteId: target._id,
        });
        track("eval_test_case_duplicated", {
          location: "evaluate_suite_settings",
          suite_id: target._id,
          original_test_case_id: testCase._id,
          new_test_case_id: copy._id,
        });
        toast.success(`Copied “${testCase.title}” to ${target.name}.`, {
          description: "Runs were not copied.",
          action: {
            label: "Open copy",
            onClick: () => onOpenCopy(copy.testSuiteId, copy._id),
          },
        });
      } catch (error) {
        toast.error(convexErrMessage(error, COPY_FAILED_FALLBACK));
      } finally {
        setCopyingCaseId(null);
      }
    },
    [duplicate, onOpenCopy],
  );

  return { targets, copyCase, copyingCaseId };
}

/** The copy icon on a Test cases row, with the project's other suites. */
export function CopyCaseMenu({
  testCase,
  targets,
  copying,
  onCopy,
}: {
  testCase: EvalCase;
  targets: readonly CopyTarget[];
  copying: boolean;
  onCopy: (testCase: EvalCase, target: EvalSuite) => void;
}) {
  const title = testCase.title || "Untitled test case";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground/60 hover:text-foreground"
              aria-label={`Copy test case: ${title}`}
              disabled={copying}
              onClick={(event) => event.stopPropagation()}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent variant="muted">Copy to another suite</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-xs">
        <DropdownMenuLabel>Copy to another suite</DropdownMenuLabel>
        {targets.length === 0 ? (
          <DropdownMenuItem disabled>
            This project has no other suites. Create one to copy cases into it.
          </DropdownMenuItem>
        ) : (
          targets.map(({ suite, disabledReason }) => (
            <DropdownMenuItem
              key={suite._id}
              disabled={Boolean(disabledReason)}
              onSelect={() => onCopy(testCase, suite)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{suite.name}</span>
                {disabledReason ? (
                  <span className="text-xs text-muted-foreground">
                    {disabledReason}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
