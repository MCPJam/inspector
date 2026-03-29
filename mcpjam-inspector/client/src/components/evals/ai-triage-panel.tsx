import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Loader2,
  AlertCircle,
  RotateCw,
  ChevronDown,
  Plus,
  Pencil,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import { toast } from "sonner";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { cn } from "@/lib/utils";
import type {
  EvalIteration,
  EvalRunRefinementCase,
  EvalSuiteRun,
} from "./types";
import { TRIAGE_PENDING_STALE_MS, useAiTriage } from "./use-ai-triage";

function excerpt(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

function stringifyToolCalls(value: unknown): string {
  return JSON.stringify(value ?? [], null, 2);
}

function outcomeLabel(
  outcome: EvalRunRefinementCase["session"] extends infer T
    ? T extends { outcome?: infer O }
      ? O
      : never
    : never,
): string | null {
  switch (outcome) {
    case "improved_test":
      return "Improved test";
    case "still_ambiguous":
      return "Still ambiguous";
    case "server_likely":
      return "Server likely";
    default:
      return null;
  }
}

function outcomeToneClass(
  outcome: EvalRunRefinementCase["session"] extends infer T
    ? T extends { outcome?: infer O }
      ? O
      : never
    : never,
): string {
  switch (outcome) {
    case "improved_test":
      return "text-emerald-600 dark:text-emerald-400";
    case "server_likely":
      return "text-destructive";
    case "still_ambiguous":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

type FailedCaseReadonlyDisplay = {
  badgeLabel: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline";
  badgeClassName?: string;
  statusLine: string;
};

function summarizeExpectedToolCalls(
  expectedToolCalls: Array<{ toolName: string; arguments: Record<string, any> }> = [],
  isNegativeTest?: boolean,
): string {
  if (isNegativeTest) {
    return "Expected tools: none";
  }

  if (!expectedToolCalls.length) {
    return "Expected tools: none";
  }

  const toolNames = expectedToolCalls.map((toolCall) => toolCall.toolName);
  return `Expected tools: ${toolNames.join(", ")}`;
}

function getVerificationStepState(
  verificationRuns: Array<{ label: string; passed: boolean }>,
  label: string,
): "pending" | "passed" | "failed" {
  const step = verificationRuns.find((run) => run.label === label);
  if (!step) {
    return "pending";
  }
  return step.passed ? "passed" : "failed";
}

function getFailedCaseReadonlyDisplay(
  failedCase: EvalRunRefinementCase,
): FailedCaseReadonlyDisplay {
  const session = failedCase.session;
  const streakText =
    failedCase.failureStreak > 1
      ? ` Failed ${failedCase.failureStreak} runs in a row.`
      : "";

  if (!session) {
    return {
      badgeLabel: "Unreviewed",
      badgeVariant: "outline",
      statusLine: `No repair session for this failure yet.${streakText} Use Trace repair from the suite header or run detail.`,
    };
  }

  if (session.status === "pending_candidate") {
    return {
      badgeLabel: "Generating",
      badgeVariant: "secondary",
      statusLine: `Repair is generating a candidate.${streakText}`,
    };
  }

  if (session.status === "ready") {
    return {
      badgeLabel: "Candidate ready",
      badgeVariant: "secondary",
      statusLine: `A candidate exists from trace repair or a prior session.${streakText}`,
    };
  }

  if (session.status === "verifying") {
    return {
      badgeLabel: `Verifying ${session.verificationRuns.length}/4`,
      badgeVariant: "secondary",
      statusLine: "Checking whether the failure stays stable across reruns.",
    };
  }

  if (session.status === "failed") {
    return {
      badgeLabel: "Needs retry",
      badgeVariant: "destructive",
      statusLine:
        session.attributionSummary ??
        "Candidate generation did not complete.",
    };
  }

  if (session.outcome === "improved_test") {
    return {
      badgeLabel: "Test fixed",
      badgeVariant: "outline",
      badgeClassName: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
      statusLine: "The rewritten version passed verification.",
    };
  }

  if (session.outcome === "server_likely") {
    return {
      badgeLabel: "Server issue likely",
      badgeVariant: "outline",
      badgeClassName: "border-destructive/30 text-destructive",
      statusLine: "The rewritten version still failed in a stable way.",
    };
  }

  if (session.outcome === "still_ambiguous") {
    return {
      badgeLabel: "Still ambiguous",
      badgeVariant: "outline",
      badgeClassName: "border-amber-500/30 text-amber-600 dark:text-amber-400",
      statusLine: "Verification changed shape; the test still needs work.",
    };
  }

  return {
    badgeLabel: "Unreviewed",
    badgeVariant: "outline",
    statusLine: `No repair session for this failure yet.${streakText}`,
  };
}

interface AiTriagePanelProps {
  run: EvalSuiteRun;
  failedCount?: number;
  failedIterations?: EvalIteration[];
  /** When false, triage starts only when the user clicks (default: true). */
  autoRequestTriage?: boolean;
  /** Maps failed test case title (from triage) to `testCaseId` for editor deep-links. */
  failedTestTitleToCaseId?: Record<string, string>;
}

export function AiTriagePanel({
  run,
  failedCount,
  failedIterations = [],
  autoRequestTriage = false,
  failedTestTitleToCaseId = {},
}: AiTriagePanelProps) {
  const { canTriage, error, unavailable, requested, requestTriage, cancelTriage } =
    useAiTriage(run, failedCount, { autoRequest: autoRequestTriage });

  const isUiRun = run.source !== "sdk";
  const failed = failedCount ?? run.summary?.failed ?? 0;
  const [suggestionRowState, setSuggestionRowState] = useState<
    Record<number, "idle" | "loading" | "error">
  >({});

  const [dismissedSuggestionIndices, setDismissedSuggestionIndices] = useState<
    number[]
  >([]);

  const createTestCaseMutation = useMutation(
    "testSuites:createTestCase" as any,
  );
  const updateTestCaseMutation = useMutation(
    "testSuites:updateTestCase" as any,
  );

  const [applyDialogIndex, setApplyDialogIndex] = useState<number | null>(null);
  const [applyTargetCaseId, setApplyTargetCaseId] = useState<string>("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyLoading, setApplyLoading] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [moreIdeasOpen, setMoreIdeasOpen] = useState(false);
  const [expandedCaseKey, setExpandedCaseKey] = useState<string | null>(null);
  const [technicalDetailsCaseKey, setTechnicalDetailsCaseKey] = useState<
    string | null
  >(null);
  const expansionInitializedForRunRef = useRef<string | null>(null);

  const suggestions = run.triageSummary?.suggestedTestCases ?? [];

  const isSuggestionDismissed = useCallback(
    (index: number) => dismissedSuggestionIndices.includes(index),
    [dismissedSuggestionIndices],
  );

  const hasVisibleSuggestions =
    isUiRun &&
    suggestions.some((_, index) => !dismissedSuggestionIndices.includes(index));

  const needSuiteModels =
    isUiRun && failed > 0;

  const testCasesForModels = useQuery(
    "testSuites:listTestCases" as any,
    needSuiteModels ? { suiteId: run.suiteId } : ("skip" as const),
  );

  const refinementState = useQuery(
    "testSuites:getRunRefinementState" as any,
    isUiRun && failed > 0 ? { suiteRunId: run._id } : ("skip" as const),
  ) as { failedCases: EvalRunRefinementCase[] } | undefined;

  const suiteModels = useMemo(
    () => collectUniqueModelsFromTestCases(testCasesForModels as any),
    [testCasesForModels],
  );

  const fallbackFailedCases = useMemo(() => {
    const seenCaseKeys = new Set<string>();
    const cases: EvalRunRefinementCase[] = [];

    for (const iteration of failedIterations) {
      if (iteration.result !== "failed") {
        continue;
      }

      const caseKey =
        iteration.testCaseSnapshot?.caseKey ??
        iteration.testCaseId ??
        iteration._id;

      if (seenCaseKeys.has(caseKey)) {
        continue;
      }

      seenCaseKeys.add(caseKey);
      cases.push({
        sourceIterationId: iteration._id,
        testCaseId: iteration.testCaseId,
        caseKey,
        title: iteration.testCaseSnapshot?.title ?? "Unknown test",
        query: iteration.testCaseSnapshot?.query ?? "",
        failureSignature: undefined,
        failureStreak: 1,
        session: null,
      });
    }

    return cases;
  }, [failedIterations]);

  const refinementCases = useMemo(() => {
    const fallbackOrder = fallbackFailedCases.map((failedCase) => failedCase.caseKey);
    const fallbackMap = new Map(
      fallbackFailedCases.map((failedCase) => [failedCase.caseKey, failedCase]),
    );
    const refinedMap = new Map(
      (refinementState?.failedCases ?? []).map((failedCase) => [
        failedCase.caseKey,
        failedCase,
      ]),
    );

    const orderedKeys = [
      ...fallbackOrder,
      ...(refinementState?.failedCases ?? [])
        .map((failedCase) => failedCase.caseKey)
        .filter((caseKey) => !fallbackOrder.includes(caseKey)),
    ];

    return orderedKeys
      .map((caseKey) => refinedMap.get(caseKey) ?? fallbackMap.get(caseKey))
      .filter((failedCase): failedCase is EvalRunRefinementCase =>
        Boolean(failedCase),
      );
  }, [fallbackFailedCases, refinementState]);

  const { triageStatus, triageSummary } = run;
  const triageGeneratedAt = triageSummary?.generatedAt;

  useEffect(() => {
    setDismissedSuggestionIndices([]);
    setSuggestionRowState({});
  }, [run._id, triageGeneratedAt, triageStatus]);

  useEffect(() => {
    setSummaryOpen(false);
    setMoreIdeasOpen(false);
    setExpandedCaseKey(null);
    setTechnicalDetailsCaseKey(null);
    expansionInitializedForRunRef.current = null;
  }, [run._id]);

  useEffect(() => {
    if (expansionInitializedForRunRef.current === run._id) {
      return;
    }

    if (refinementCases.length === 0) {
      return;
    }

    expansionInitializedForRunRef.current = run._id;
    const firstNotCompleted =
      refinementCases.find((failedCase) => failedCase.session?.status !== "completed")
        ?.caseKey ?? null;
    setExpandedCaseKey(firstNotCompleted);
  }, [refinementCases, run._id]);

  useEffect(() => {
    if (
      expandedCaseKey &&
      !refinementCases.some((failedCase) => failedCase.caseKey === expandedCaseKey)
    ) {
      const firstNotCompleted =
        refinementCases.find(
          (failedCase) => failedCase.session?.status !== "completed",
        )?.caseKey ?? null;
      setExpandedCaseKey(firstNotCompleted);
      setTechnicalDetailsCaseKey(null);
    }
  }, [expandedCaseKey, refinementCases]);

  const handleAddSuggestion = useCallback(
    async (index: number) => {
      const item = suggestions[index];
      if (!item || isSuggestionDismissed(index)) return;
      setSuggestionRowState((s) => ({ ...s, [index]: "loading" }));
      try {
        await createTestCaseMutation({
          suiteId: run.suiteId,
          title: item.title,
          query: item.query,
          runs: 1,
          models: suiteModels,
          expectedToolCalls: item.expectedToolCalls ?? [],
          isNegativeTest: item.isNegativeTest ?? false,
          scenario: item.scenario,
          expectedOutput: item.expectedOutput,
          changeSource: "triage",
          sourceRunId: run._id,
          revisionMetadata: item.rationale
            ? { rationale: item.rationale }
            : undefined,
        });
        setDismissedSuggestionIndices((prev) =>
          prev.includes(index) ? prev : [...prev, index],
        );
        setSuggestionRowState((s) => {
          const next = { ...s };
          delete next[index];
          return next;
        });
      } catch (err) {
        setSuggestionRowState((s) => ({ ...s, [index]: "error" }));
        console.error("Add suggested test case failed:", err);
      }
    },
    [
      suggestions,
      createTestCaseMutation,
      run.suiteId,
      suiteModels,
      isSuggestionDismissed,
    ],
  );

  const pendingSinceRef = useRef<number | null>(null);
  const [staleTick, setStaleTick] = useState(0);
  const [cancelBusy, setCancelBusy] = useState(false);

  useEffect(() => {
    if (run.triageStatus === "pending") {
      if (pendingSinceRef.current === null) {
        pendingSinceRef.current = Date.now();
      }
      const id = window.setInterval(() => setStaleTick((n) => n + 1), 4000);
      return () => window.clearInterval(id);
    }
    pendingSinceRef.current = null;
    return undefined;
  }, [run._id, run.triageStatus]);

  useEffect(() => {
    if (applyDialogIndex === null) return;
    const cases = testCasesForModels as any[] | undefined;
    if (!cases?.length) return;
    setApplyTargetCaseId((prev) => {
      if (prev && cases.some((c: { _id: string }) => c._id === prev)) {
        return prev;
      }
      return cases[0]._id;
    });
  }, [applyDialogIndex, testCasesForModels]);

  const handleApplyToExisting = useCallback(async () => {
    if (applyDialogIndex === null) return;
    const item = suggestions[applyDialogIndex];
    if (!item || !applyTargetCaseId) return;
    const indexToDismiss = applyDialogIndex;
    setApplyLoading(true);
    setApplyError(null);
    try {
      await updateTestCaseMutation({
        testCaseId: applyTargetCaseId as any,
        title: item.title,
        query: item.query,
        expectedToolCalls: item.expectedToolCalls ?? [],
        isNegativeTest: item.isNegativeTest ?? false,
        scenario: item.scenario,
        expectedOutput: item.expectedOutput,
        changeSource: "triage",
        sourceRunId: run._id,
        revisionMetadata: item.rationale
          ? { rationale: item.rationale }
          : undefined,
      });
      setDismissedSuggestionIndices((prev) =>
        prev.includes(indexToDismiss) ? prev : [...prev, indexToDismiss],
      );
      setSuggestionRowState((s) => {
        const next = { ...s };
        delete next[indexToDismiss];
        return next;
      });
      setApplyDialogIndex(null);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "Could not update test case.");
    } finally {
      setApplyLoading(false);
    }
  }, [
    applyDialogIndex,
    applyTargetCaseId,
    suggestions,
    updateTestCaseMutation,
  ]);

  const openTestInEditor = useCallback(
    (testCaseId: string) => {
      navigateToEvalsRoute({
        type: "test-edit",
        suiteId: run.suiteId,
        testId: testCaseId,
      });
    },
    [run.suiteId],
  );
  if (unavailable) return null;

  if (failed === 0) return null;

  const showStalePendingBanner =
    triageStatus === "pending" &&
    staleTick >= 0 &&
    pendingSinceRef.current !== null &&
    Date.now() - pendingSinceRef.current > TRIAGE_PENDING_STALE_MS;

  const applySuggestion =
    applyDialogIndex !== null ? suggestions[applyDialogIndex] : null;
  const applyTargetCase = (testCasesForModels as any[] | undefined)?.find(
    (c) => c._id === applyTargetCaseId,
  );

  const summaryStatusLabel =
    triageStatus === "completed"
      ? "Ready"
      : triageStatus === "pending"
        ? "Analyzing"
        : triageStatus === "failed"
          ? "Failed"
          : "Not run";

  const summarySubtitle =
    triageStatus === "completed"
      ? "AI summary is ready."
      : triageStatus === "pending"
        ? "Analyzing failed cases."
        : triageStatus === "failed"
          ? "AI summary needs a retry."
          : "Run AI triage when you want a summary.";

  const showSummaryPanel =
    triageStatus === "completed" ||
    triageStatus === "pending" ||
    triageStatus === "failed" ||
    canTriage;
  const showFailedCases = isUiRun && refinementCases.length > 0;
  const showMoreIdeas = isUiRun && hasVisibleSuggestions;

  if (!showSummaryPanel && !showFailedCases && !showMoreIdeas) {
    return null;
  }

  const renderSummaryContent = () => {
    if (triageStatus === "pending") {
      return (
        <div className="space-y-3 px-4 pb-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>Analyzing failures…</span>
          </div>
          {showStalePendingBanner ? (
            <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                This is taking longer than usual. You can cancel and try again.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={cancelBusy}
                onClick={async () => {
                  setCancelBusy(true);
                  try {
                    await cancelTriage();
                  } finally {
                    setCancelBusy(false);
                  }
                }}
              >
                {cancelBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : null}
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    if (triageStatus === "failed") {
      return (
        <div className="space-y-3 px-4 pb-4">
          <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
            Couldn’t complete analysis.{error ? ` ${error}` : ""}
          </div>
          <Button variant="outline" size="sm" onClick={requestTriage}>
            Retry
          </Button>
        </div>
      );
    }

    if (triageStatus === "completed" && triageSummary) {
      return (
        <div className="space-y-4 px-4 pb-4">
          <p className="text-sm leading-snug text-foreground/90">
            {triageSummary.summary}
          </p>

          {triageSummary.failureCategories.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                What failed
              </div>
              <ul className="space-y-2">
                {triageSummary.failureCategories.map((cat, index) => (
                  <li
                    key={`${cat.category}-${index}`}
                    className="rounded-md border border-border/50 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {cat.category}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {cat.count} failure{cat.count === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                      {cat.recommendation}
                    </p>
                    {cat.testCaseTitles.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {cat.testCaseTitles.map((title) => {
                          const caseId = failedTestTitleToCaseId[title];
                          return caseId ? (
                            <button
                              key={title}
                              type="button"
                              className="text-[11px] text-primary/90 hover:underline inline-flex items-center gap-0.5"
                              onClick={() => openTestInEditor(caseId)}
                            >
                              {title}
                              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                            </button>
                          ) : (
                            <span
                              key={title}
                              className="text-[11px] text-muted-foreground"
                            >
                              {title}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {triageSummary.topRecommendations.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                Recommendations
              </div>
              <ol className="list-decimal pl-4 space-y-1 text-[11px] text-foreground/90">
                {triageSummary.topRecommendations.map((recommendation, index) => (
                  <li key={index}>{recommendation}</li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-3">
            <span className="text-[10px] text-muted-foreground">
              {triageSummary.modelUsed}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-[10px]"
              onClick={requestTriage}
              disabled={requested}
            >
              <RotateCw className="h-3 w-3" />
              Re-triage
            </Button>
          </div>
        </div>
      );
    }

    if (!canTriage) {
      return null;
    }

    return (
      <div className="space-y-3 px-4 pb-4">
        <p className="text-sm text-muted-foreground">
          AI triage is optional. Run it when you want a summary of the failed cases.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={requestTriage}
            disabled={requested}
          >
            Triage failures
          </Button>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      </div>
    );
  };

  const renderExpandedCase = (failedCase: EvalRunRefinementCase) => {
    const session = failedCase.session;
    const candidate = session?.candidateSnapshot;
    const base = session?.baseSnapshot;
    const verificationRuns = session?.verificationRuns ?? [];
    const detailsOpen = technicalDetailsCaseKey === failedCase.caseKey;

    const candidateStep =
      !session || session.status === "pending_candidate" || session.status === "failed"
        ? (
            <div className="space-y-3">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Step 1 of 3
                </div>
                <div className="mt-1 text-xs font-medium text-foreground">
                  Candidate
                </div>
              </div>
              <div className="rounded-md border border-border/50 bg-muted/20 p-3">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Current test
                </div>
                <p className="mt-1 text-[11px] leading-snug text-foreground/90">
                  {failedCase.query}
                </p>
              </div>
              {session?.status === "pending_candidate" ? (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Building a cleaner candidate.
                </div>
              ) : session?.status === "failed" ? (
                <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-[11px] text-destructive">
                  {session.attributionSummary ??
                    "Candidate generation did not complete."}
                </div>
              ) : null}
            </div>
          )
        : null;

    const readyStep =
      session?.status === "ready" && candidate ? (
        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Step 1 of 3
            </div>
            <div className="mt-1 text-xs font-medium text-foreground">
              Candidate
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border/50 bg-muted/20 p-3">
              <div className="text-[11px] font-medium text-muted-foreground">
                Current test
              </div>
              <p className="mt-1 text-[11px] leading-snug text-foreground/90">
                {base?.query ?? failedCase.query}
              </p>
            </div>
            <div className="rounded-md border border-border/50 bg-muted/20 p-3">
              <div className="text-[11px] font-medium text-muted-foreground">
                Candidate test
              </div>
              <p className="mt-1 text-[11px] leading-snug text-foreground/90">
                {candidate.query}
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground">
                {summarizeExpectedToolCalls(
                  candidate.expectedToolCalls,
                  candidate.isNegativeTest,
                )}
              </p>
            </div>
          </div>
        </div>
      ) : null;

    const verificationStep =
      session?.status === "verifying" ? (
        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Step 2 of 3
            </div>
            <div className="mt-1 text-xs font-medium text-foreground">
              Verification
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            We rerun the same intent four ways to separate test ambiguity from server behavior.
          </p>
          <ul className="space-y-2">
            {[
              ["same-model-1", "Same model 1"],
              ["same-model-2", "Same model 2"],
              ["paraphrase", "Paraphrase"],
              ["cross-model", "Cross-model"],
            ].map(([label, title]) => {
              const stepState = getVerificationStepState(verificationRuns, label);
              return (
                <li
                  key={label}
                  className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2"
                >
                  <span className="text-[11px] text-foreground">{title}</span>
                  <span
                    className={cn(
                      "text-[10px] font-medium",
                      stepState === "passed"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : stepState === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {stepState}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null;

    const verdictStep =
      session?.status === "completed" ? (
        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Step 3 of 3
            </div>
            <div className="mt-1 text-xs font-medium text-foreground">
              Verdict
            </div>
          </div>
          <div
            className={cn(
              "rounded-md border p-3",
              session.outcome === "improved_test"
                ? "border-emerald-500/20 bg-emerald-500/5"
                : session.outcome === "server_likely"
                  ? "border-destructive/20 bg-destructive/5"
                  : "border-amber-500/20 bg-amber-500/5",
            )}
          >
            <div
              className={cn(
                "text-xs font-medium",
                outcomeToneClass(session.outcome),
              )}
            >
              {session.outcome === "improved_test"
                ? "This looks like a better test"
                : session.outcome === "server_likely"
                  ? "This still looks like a server problem"
                  : "We still can’t tell"}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-foreground/90">
              {session.attributionSummary ??
                (session.outcome === "improved_test"
                  ? "The rewritten version passed, so the original test was probably underspecified."
                  : session.outcome === "server_likely"
                    ? "The rewritten version still failed the same way, so the server is the likely cause."
                    : "The failure changed during verification, so we still need a better test.")}
            </p>
          </div>
        </div>
      ) : null;

    return (
      <div className="border-t border-border/50 px-3 py-3 space-y-3">
        {candidateStep}
        {readyStep}
        {verificationStep}
        {verdictStep}

        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-[10px] text-muted-foreground"
            onClick={() =>
              setTechnicalDetailsCaseKey((current) =>
                current === failedCase.caseKey ? null : failedCase.caseKey,
              )
            }
          >
            Technical details
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                detailsOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </Button>
        </div>

        {detailsOpen ? (
          <div className="space-y-3 rounded-md border border-border/50 bg-muted/10 p-3">
            {session?.testWeaknessHypothesis ? (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Test weakness
                </div>
                <p className="text-[11px] text-foreground/90 leading-snug">
                  {session.testWeaknessHypothesis}
                </p>
              </div>
            ) : null}

            {session?.serverHypothesis ? (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Server hypothesis
                </div>
                <p className="text-[11px] text-foreground/90 leading-snug">
                  {session.serverHypothesis}
                </p>
              </div>
            ) : null}

            {failedCase.failureSignature ? (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Failure signature
                </div>
                <p className="text-[10px] font-mono text-muted-foreground break-all">
                  {failedCase.failureSignature}
                </p>
              </div>
            ) : null}

            {session?.confidenceChecklist?.length ? (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Confidence checklist
                </div>
                <ul className="list-disc pl-4 space-y-1 text-[11px] text-foreground/90">
                  {session.confidenceChecklist.map((item, index) => (
                    <li key={`${failedCase.caseKey}-check-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {session?.verificationRuns?.length ? (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Verification evidence
                </div>
                <ul className="space-y-1">
                  {session.verificationRuns.map((verificationRun) => (
                    <li
                      key={`${failedCase.caseKey}-${verificationRun.label}`}
                      className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5"
                    >
                      <span className="font-medium text-foreground/90">
                        {verificationRun.label}
                      </span>
                      <span>
                        {verificationRun.provider}/{verificationRun.model}
                      </span>
                      <span>{verificationRun.passed ? "passed" : "failed"}</span>
                      {verificationRun.failureSignature ? (
                        <span className="font-mono break-all">
                          {verificationRun.failureSignature}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {candidate ? (
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Expected tool calls (JSON)
                </div>
                <pre className="text-[10px] font-mono whitespace-pre-wrap break-all rounded border border-border/50 bg-background/80 p-2 max-h-32 overflow-y-auto">
                  {stringifyToolCalls(candidate.expectedToolCalls)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-3">
        {showSummaryPanel ? (
          <Collapsible
            open={summaryOpen}
            onOpenChange={setSummaryOpen}
            className="rounded-lg border border-border/60 bg-card text-card-foreground"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    summaryOpen ? "rotate-0" : "-rotate-90",
                  )}
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    AI triage summary
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {summarySubtitle}
                  </div>
                </div>
              </CollapsibleTrigger>
              <Badge variant="outline" className="text-[10px]">
                {summaryStatusLabel}
              </Badge>
            </div>
            {summaryOpen ? <CollapsibleContent>{renderSummaryContent()}</CollapsibleContent> : null}
          </Collapsible>
        ) : null}

        {showFailedCases ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-foreground">
                  Failed cases
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Status from trace repair and verification (read-only). Use Trace
                  repair in the suite header or run detail to drive fixes.
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {refinementCases.length} case{refinementCases.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="space-y-2">
              {refinementCases.map((failedCase) => {
                const display = getFailedCaseReadonlyDisplay(failedCase);
                const isExpanded = expandedCaseKey === failedCase.caseKey;

                return (
                  <li
                    key={failedCase.caseKey}
                    className="rounded-lg border border-border/60 bg-card text-card-foreground"
                  >
                    <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-foreground">
                            {failedCase.title}
                          </span>
                          <Badge
                            variant={display.badgeVariant}
                            className={cn("text-[10px]", display.badgeClassName)}
                          >
                            {display.badgeLabel}
                          </Badge>
                        </div>
                        <p className="text-[11px] leading-snug text-muted-foreground">
                          {display.statusLine}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-initial">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 text-[10px] text-muted-foreground"
                          onClick={() => {
                            setExpandedCaseKey((current) =>
                              current === failedCase.caseKey ? null : failedCase.caseKey,
                            );
                            if (expandedCaseKey === failedCase.caseKey) {
                              setTechnicalDetailsCaseKey(null);
                            }
                          }}
                        >
                          Details
                          <ChevronDown
                            className={cn(
                              "h-3 w-3 transition-transform",
                              isExpanded ? "rotate-180" : "rotate-0",
                            )}
                          />
                        </Button>
                      </div>
                    </div>
                    {isExpanded ? renderExpandedCase(failedCase) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {showMoreIdeas ? (
          <Collapsible
            open={moreIdeasOpen}
            onOpenChange={setMoreIdeasOpen}
            className="rounded-lg border border-border/60 bg-card text-card-foreground"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    moreIdeasOpen ? "rotate-0" : "-rotate-90",
                  )}
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    More test ideas
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Extra follow-up cases from AI triage.
                  </div>
                </div>
              </CollapsibleTrigger>
              <Badge variant="outline" className="text-[10px]">
                {suggestions.filter((_, index) => !isSuggestionDismissed(index)).length}
              </Badge>
            </div>
            {moreIdeasOpen ? (
              <CollapsibleContent>
                <div className="space-y-2 px-4 pb-4">
                  {suggestions.map((suggestion, index) => {
                    if (isSuggestionDismissed(index)) return null;
                    const suggestionState = suggestionRowState[index] ?? "idle";

                    return (
                      <div
                        key={`${suggestion.title}-${index}`}
                        className="rounded-md border border-border/50 px-3 py-2.5 space-y-2"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-foreground">
                              {suggestion.title}
                            </span>
                            {suggestion.isNegativeTest ? (
                              <Badge variant="outline" className="text-[10px]">
                                Negative
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-[11px] text-muted-foreground leading-snug">
                            {excerpt(suggestion.query, 200)}
                          </p>
                          {suggestion.rationale ? (
                            <p className="text-[10px] text-muted-foreground">
                              {suggestion.rationale}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 text-[10px]"
                            disabled={
                              suggestionState === "loading" ||
                              (needSuiteModels && testCasesForModels === undefined)
                            }
                            onClick={() => {
                              setApplyError(null);
                              setApplyDialogIndex(index);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                            Apply to test…
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-7 gap-1 text-[10px]"
                            disabled={
                              suggestionState === "loading" ||
                              (needSuiteModels && testCasesForModels === undefined)
                            }
                            onClick={() => handleAddSuggestion(index)}
                          >
                            {suggestionState === "loading" ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Plus className="h-3 w-3" />
                            )}
                            Add to suite
                          </Button>
                        </div>
                        {suggestionState === "error" ? (
                          <p className="text-[10px] text-destructive">
                            Could not add test case.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </CollapsibleContent>
            ) : null}
          </Collapsible>
        ) : null}
      </div>

      <Dialog
        open={applyDialogIndex !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApplyDialogIndex(null);
            setApplyError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">
              Apply suggestion to a test
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Overwrites the selected case with this suggestion. Review the
              diff below before confirming.
            </DialogDescription>
          </DialogHeader>
          {applySuggestion ? (
            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Test case
                </span>
                <Select
                  value={applyTargetCaseId}
                  onValueChange={setApplyTargetCaseId}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select test case" />
                  </SelectTrigger>
                  <SelectContent>
                    {((testCasesForModels as any[]) ?? []).map((c) => (
                      <SelectItem key={c._id} value={c._id} className="text-xs">
                        {c.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    Current query
                  </div>
                  <pre className="text-[10px] whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/30 p-2 max-h-28 overflow-y-auto">
                    {applyTargetCase?.query ?? "—"}
                  </pre>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    Suggested query
                  </div>
                  <pre className="text-[10px] whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/30 p-2 max-h-28 overflow-y-auto">
                    {applySuggestion.query}
                  </pre>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Expected tool calls (JSON)
                </div>
                <pre className="text-[10px] font-mono whitespace-pre-wrap break-all rounded border border-border/50 bg-muted/30 p-2 max-h-32 overflow-y-auto">
                  {JSON.stringify(
                    applySuggestion.expectedToolCalls ?? [],
                    null,
                    2,
                  )}
                </pre>
              </div>
              {applyError ? (
                <p className="text-[11px] text-destructive">{applyError}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setApplyDialogIndex(null)}
              disabled={applyLoading}
            >
              Close
            </Button>
            <Button
              size="sm"
              disabled={
                applyLoading ||
                !applySuggestion ||
                !applyTargetCaseId ||
                !(testCasesForModels as any[])?.length
              }
              onClick={() => void handleApplyToExisting()}
            >
              {applyLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              Apply to test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
