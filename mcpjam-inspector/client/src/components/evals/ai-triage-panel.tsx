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
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import { navigateToEvalsRoute } from "@/lib/evals-router";
import type { EvalSuiteRun } from "./types";
import { TRIAGE_PENDING_STALE_MS, useAiTriage } from "./use-ai-triage";

function excerpt(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

interface AiTriagePanelProps {
  run: EvalSuiteRun;
  failedCount?: number;
  /** When false, triage starts only when the user clicks (default: true). */
  autoRequestTriage?: boolean;
  /** Maps failed test case title (from triage) to `testCaseId` for editor deep-links. */
  failedTestTitleToCaseId?: Record<string, string>;
}

export function AiTriagePanel({
  run,
  failedCount,
  autoRequestTriage = true,
  failedTestTitleToCaseId = {},
}: AiTriagePanelProps) {
  const { canTriage, error, unavailable, requested, requestTriage, cancelTriage } =
    useAiTriage(run, failedCount, { autoRequest: autoRequestTriage });

  const isUiRun = run.source !== "sdk";
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

  const suggestions = run.triageSummary?.suggestedTestCases ?? [];

  const isSuggestionDismissed = useCallback(
    (index: number) => dismissedSuggestionIndices.includes(index),
    [dismissedSuggestionIndices],
  );

  const hasVisibleSuggestions =
    isUiRun &&
    suggestions.some((_, index) => !dismissedSuggestionIndices.includes(index));

  const needSuiteModels =
    isUiRun &&
    run.triageStatus === "completed" &&
    hasVisibleSuggestions;

  const testCasesForModels = useQuery(
    "testSuites:listTestCases" as any,
    needSuiteModels ? { suiteId: run.suiteId } : ("skip" as const),
  );

  const modelsForSuggestions = useMemo(
    () => collectUniqueModelsFromTestCases(testCasesForModels as any),
    [testCasesForModels],
  );

  const { triageStatus, triageSummary } = run;
  const triageGeneratedAt = triageSummary?.generatedAt;

  useEffect(() => {
    setDismissedSuggestionIndices([]);
    setSuggestionRowState({});
  }, [run._id, triageGeneratedAt, triageStatus]);

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
          models: modelsForSuggestions,
          expectedToolCalls: item.expectedToolCalls ?? [],
          isNegativeTest: item.isNegativeTest,
          scenario: item.scenario,
          expectedOutput: item.expectedOutput,
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
      modelsForSuggestions,
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
        isNegativeTest: item.isNegativeTest,
        scenario: item.scenario,
        expectedOutput: item.expectedOutput,
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

  const failed = failedCount ?? run.summary?.failed ?? 0;

  if (failed === 0) return null;

  const showStalePendingBanner =
    triageStatus === "pending" &&
    staleTick >= 0 &&
    pendingSinceRef.current !== null &&
    Date.now() - pendingSinceRef.current > TRIAGE_PENDING_STALE_MS;

  if (triageStatus === "pending") {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 space-y-3">
        <div className="flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
          <span className="text-sm text-muted-foreground">
            Analyzing failures…
          </span>
        </div>
        {showStalePendingBanner ? (
          <div className="flex flex-col gap-2 border-t border-border/50 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              This is taking longer than usual. You can cancel and run analysis again.
            </p>
            <div className="flex gap-2 shrink-0">
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
          </div>
        ) : null}
      </div>
    );
  }

  if (triageStatus === "completed" && triageSummary) {
    const applySuggestion =
      applyDialogIndex !== null ? suggestions[applyDialogIndex] : null;
    const applyTargetCase = (testCasesForModels as any[] | undefined)?.find(
      (c) => c._id === applyTargetCaseId,
    );

    return (
      <>
        <Collapsible
          defaultOpen
          className="group/collapse rounded-lg border border-border/60 bg-card text-card-foreground"
        >
          <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border/50">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-0.5 text-left -my-0.5 outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/collapse:-rotate-90 group-data-[state=open]/collapse:rotate-0" />
              <div className="min-w-0 flex flex-col items-start gap-0.5">
                <span className="text-xs font-medium text-foreground">
                  Failure summary
                </span>
                <span className="text-[10px] text-muted-foreground truncate max-w-full">
                  {triageSummary.modelUsed}
                </span>
              </div>
            </CollapsibleTrigger>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 text-[10px] text-muted-foreground"
              onClick={requestTriage}
              disabled={requested}
            >
              <RotateCw className="h-3 w-3" />
              Re-triage
            </Button>
          </div>

          <CollapsibleContent>
            <div className="px-4 py-4 space-y-5 max-w-prose">
              <p className="text-sm leading-snug text-foreground/90">
                {triageSummary.summary}
              </p>

              {triageSummary.failureCategories.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-medium text-muted-foreground">
                    What failed
                  </h4>
                  <ul className="divide-y divide-border/60 rounded-md border border-border/50">
                    {triageSummary.failureCategories.map((cat, i) => (
                      <li key={`${cat.category}-${i}`} className="px-3 py-2.5 space-y-1.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                          <span className="text-xs font-medium text-foreground">
                            {cat.category}
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {cat.count} failure{cat.count !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">
                          {cat.recommendation}
                        </p>
                        {cat.testCaseTitles.length > 0 && (
                          <div className="flex flex-wrap gap-x-2 gap-y-1 pt-0.5">
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
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {triageSummary.topRecommendations.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-medium text-muted-foreground">
                    Next steps
                  </h4>
                  <ol className="list-decimal list-inside space-y-1.5 text-xs text-foreground/90 leading-snug marker:text-muted-foreground">
                    {triageSummary.topRecommendations.map((rec, i) => (
                      <li key={i}>{rec}</li>
                    ))}
                  </ol>
                </div>
              )}

              {hasVisibleSuggestions && (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-medium text-muted-foreground">
                    Suggested tests
                  </h4>
                  <ul className="space-y-2">
                    {suggestions.map((s, index) => {
                      if (isSuggestionDismissed(index)) return null;
                      const st = suggestionRowState[index] ?? "idle";
                      return (
                        <li
                          key={`${s.title}-${index}`}
                          className="rounded-md border border-border/50 px-3 py-2.5 space-y-2"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-medium text-foreground">
                                  {s.title}
                                </span>
                                {s.isNegativeTest ? (
                                  <span className="text-[10px] text-muted-foreground">
                                    Negative
                                  </span>
                                ) : null}
                              </div>
                              <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">
                                {excerpt(s.query, 200)}
                              </p>
                              {s.rationale ? (
                                <p className="text-[10px] text-muted-foreground/90 leading-snug">
                                  {s.rationale}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap gap-1.5 justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 shrink-0 gap-1 text-[10px]"
                                disabled={
                                  st === "loading" ||
                                  (needSuiteModels &&
                                    testCasesForModels === undefined)
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
                                className="h-7 shrink-0 gap-1 text-[10px]"
                                disabled={
                                  st === "loading" ||
                                  (needSuiteModels &&
                                    testCasesForModels === undefined)
                                }
                                onClick={() => handleAddSuggestion(index)}
                              >
                                {st === "loading" ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Plus className="h-3 w-3" />
                                )}
                                Add to suite
                              </Button>
                            </div>
                          </div>
                          {st === "error" ? (
                            <p className="text-[10px] text-destructive">
                              Could not add test case.
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

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

  if (triageStatus === "failed") {
    return (
      <div className="rounded-lg border border-border/60 border-destructive/20 bg-destructive/5 px-4 py-3 flex items-center gap-3">
        <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
        <span className="text-sm text-destructive flex-1">
          Couldn’t complete analysis.{error ? ` ${error}` : ""}
        </span>
        <Button variant="outline" size="sm" onClick={requestTriage}>
          Retry
        </Button>
      </div>
    );
  }

  if (!canTriage) return null;

  return (
    <div className="flex items-center mt-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={requestTriage}
        disabled={requested}
      >
        Triage failures
      </Button>
      {error && <span className="ml-3 text-xs text-destructive">{error}</span>}
    </div>
  );
}
