import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Loader2,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  NEGATIVE_TEST_MODE_DETAILS,
  isPolicyDependentNegativeTestMode,
  type NegativeTestMode,
} from "@/shared/xaa.js";
import {
  runNegativeTests,
  type NegativeTestCase,
  type NegativeTestsInput,
  type NegativeTestsResult,
} from "@/lib/xaa/discovery-client";

interface NegativeTestScorecardProps {
  /** The AS target to fire broken assertions at, or null when there is no
   * external auth server to test (MCPJam-issuer-only, or the token endpoint
   * isn't known yet). */
  input: NegativeTestsInput | null;
  /** A successful positive run has completed for this target this session. */
  unlocked: boolean;
  /** Why `input` is null — shown when the scorecard can't run at all. */
  unavailableReason?: string;
  /** Lets the parent grow the scorecard panel after a completed run. */
  onResultsReady?: () => void;
  /** Lets the parent return the panel to its compact starting size for a new target. */
  onTargetChange?: () => void;
  /** Keeps the resizable panel in sync when the card is collapsed or expanded. */
  onExpandedChange?: (expanded: boolean, hasResults: boolean) => void;
  /** Reports the compact card's actual height so its panel can fit its content. */
  onCompactContentHeightChange?: (height: number) => void;
}

type RunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: NegativeTestsResult }
  | { status: "error"; message: string };

function StatusPill({ row }: { row: NegativeTestCase }) {
  const httpSuffix = row.status ? ` · HTTP ${row.status}` : "";

  if (row.verdict === "pass") {
    return (
      <span className="shrink-0 text-[11px] font-medium text-green-700 dark:text-green-400">
        Rejected as expected{httpSuffix}
      </span>
    );
  }

  if (row.verdict === "fail") {
    return (
      <span className="shrink-0 text-[11px] font-medium text-red-600 dark:text-red-400">
        Accepted — security risk{httpSuffix}
      </span>
    );
  }

  if (row.verdict === "policy") {
    const outcomeLabel = row.outcome === "accepted" ? "Accepted" : "Rejected";
    return (
      <span className="shrink-0 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        {outcomeLabel} — policy-dependent{httpSuffix}
      </span>
    );
  }

  return (
    <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
      {row.outcome === "timeout" ? "Timed out" : "Inconclusive"}
    </span>
  );
}

function VerdictRow({ row }: { row: NegativeTestCase }) {
  const tone =
    row.verdict === "pass"
      ? { Icon: CheckCircle2, className: "text-green-600 dark:text-green-400" }
      : row.verdict === "fail"
      ? { Icon: ShieldAlert, className: "text-red-500" }
      : row.verdict === "policy"
      ? { Icon: HelpCircle, className: "text-amber-600 dark:text-amber-400" }
      : { Icon: HelpCircle, className: "text-muted-foreground" };

  // Strict passes use the shared "what this checks" copy. Failures and
  // transport errors prefer their server-supplied detail; policy probes retain
  // the neutral shared explanation regardless of acceptance or rejection.
  const description =
    NEGATIVE_TEST_MODE_DETAILS[row.mode as NegativeTestMode]?.description;
  const body = row.verdict === "pass" ? description : row.detail || description;

  return (
    <div
      data-testid={`xaa-negtest-row-${row.mode}`}
      data-verdict={row.verdict}
      className={`rounded-lg border px-3 py-2.5 text-xs ${
        row.verdict === "fail"
          ? "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-950/20"
          : "border-border bg-background"
      }`}
    >
      <div className="flex items-start gap-2">
        <tone.Icon
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone.className}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{row.label}</span>
            <StatusPill row={row} />
          </div>
          {body && <p className="text-muted-foreground">{body}</p>}
          {row.diff && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[11px]">
              <span className="text-muted-foreground">
                {row.diff.field} sent
              </span>
              <span className="break-all text-foreground">{row.diff.sent}</span>
              <span className="text-muted-foreground">expected</span>
              <span className="break-all text-foreground">
                {row.diff.expected}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function NegativeTestScorecard({
  input,
  unlocked,
  unavailableReason,
  onResultsReady,
  onTargetChange,
  onExpandedChange,
  onCompactContentHeightChange,
}: NegativeTestScorecardProps) {
  const [expanded, setExpanded] = useState(true);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [overrideAccepted, setOverrideAccepted] = useState(false);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  // Reset the last run whenever the target changes — including when config is
  // cleared (input → null). Without this, stale result rows from a previous
  // target linger and contradict the empty/locked body.
  const targetKey = input
    ? [
        input.registrationId ?? input.serverId ?? input.tokenEndpoint ?? "",
        input.audience,
        input.resource,
        // Issuer mode, org, and kind all change the minted `iss`, so they are
        // part of the target identity: switching any of them must reset a
        // prior run's results (e.g. a guest→signed-in promotion keeps the org
        // but flips the kind /g/→/o/).
        input.issuerMode ?? "local",
        input.organizationId ?? "",
        input.issuerKind ?? "org",
        // Managed-policy context: managed and unmanaged runs go through
        // different evaluators, and a managed ruling is per person — completed
        // rows from one mode/person must not survive a switch to the other.
        input.policyMode ?? "",
        input.testIdentityId ?? "",
      ].join("|")
    : "";
  useEffect(() => {
    setRun({ status: "idle" });
    setOverrideAccepted(false);
    onTargetChange?.();
  }, [onTargetChange, targetKey]);

  const canRun = input !== null && (unlocked || overrideAccepted);

  const handleRun = async () => {
    if (!input) return;
    setRun({ status: "loading" });
    try {
      const result = await runNegativeTests(input);
      setRun({ status: "done", result });
      onResultsReady?.();
    } catch (error) {
      setRun({
        status: "error",
        message:
          error instanceof Error ? error.message : "Negative tests failed",
      });
    }
  };

  const passedCount =
    run.status === "done"
      ? run.result.results.filter((r) => r.verdict === "pass").length
      : 0;
  const hasResults = run.status === "done";
  const policyCount =
    run.status === "done"
      ? run.result.results.filter((r) =>
          isPolicyDependentNegativeTestMode(r.mode as NegativeTestMode)
        ).length
      : 0;
  const strictCheckCount =
    run.status === "done" ? run.result.results.length - policyCount : 0;
  const fillPanel = hasResults && expanded;

  useLayoutEffect(() => {
    if (fillPanel || !onCompactContentHeightChange) return;
    const element = cardContainerRef.current;
    if (!element) return;

    const reportHeight = () => {
      onCompactContentHeightChange(element.getBoundingClientRect().height);
    };
    reportHeight();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fillPanel, onCompactContentHeightChange]);

  const handleExpandedToggle = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded, hasResults);
  };

  return (
    <div ref={cardContainerRef} className={fillPanel ? "h-full" : undefined}>
      <Card
        className={`mx-3 mt-1 mb-3 gap-0 p-0 ${
          fillPanel ? "flex h-[calc(100%-1rem)] flex-col overflow-hidden" : ""
        }`}
      >
        <button
          type="button"
          onClick={handleExpandedToggle}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
        >
          <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold">
              Negative-test scorecard
            </span>
            <p className="truncate text-xs text-muted-foreground">
              Test invalid assertions and inspect policy-dependent behavior.
            </p>
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        {expanded && (
          <div
            className={
              hasResults
                ? "flex min-h-0 flex-1 flex-col space-y-3 px-4 pb-4"
                : "space-y-3 px-4 pb-4"
            }
          >
            {input === null ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {unavailableReason ??
                  "Negative tests need a resource with its own auth server."}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleRun}
                    disabled={!canRun || run.status === "loading"}
                  >
                    {run.status === "loading" ? (
                      <>
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        Running
                      </>
                    ) : (
                      "Run negative tests"
                    )}
                  </Button>
                  {!unlocked && !overrideAccepted && (
                    <span className="text-xs text-muted-foreground">
                      Run a successful flow first to unlock.
                    </span>
                  )}
                </div>

                {!unlocked && (
                  <div className="flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={overrideAccepted}
                      onCheckedChange={(value) =>
                        setOverrideAccepted(value === true)
                      }
                      className="mt-0.5"
                      aria-label="I own this auth server and want to run before a passing flow"
                    />
                    <span>
                      I&apos;m building this auth server — let me run the tests
                      before a passing happy-path run. Use this only for a
                      server you own and are developing.
                    </span>
                  </div>
                )}

                {run.status === "error" && (
                  <div
                    data-testid="xaa-negtest-error"
                    className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300"
                  >
                    {run.message}
                  </div>
                )}

                {run.status === "done" && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {passedCount} of {strictCheckCount} strict rejection
                      checks passed.
                      {policyCount > 0
                        ? ` ${policyCount} policy ${
                            policyCount === 1 ? "probe" : "probes"
                          } reported separately.`
                        : ""}
                    </p>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                      {run.result.results.map((row) => (
                        <VerdictRow key={row.mode} row={row} />
                      ))}
                    </div>
                  </>
                )}

                {run.status === "done" && run.result.failures > 0 && (
                  <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Your auth server issued a token for at least one broken
                    assertion. Each red row is a token it should have rejected.
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
