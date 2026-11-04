import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isMissingInputCheck, missingInputMessage } from "@mcpjam/sdk/browser";
import { StatusIcon } from "./conformance-ui";
import { UnscoredTag, NotRunTag } from "./ConformanceCheckRows";
import type { LoadReport, SavedReportCase } from "./use-saved-run-reports";

/**
 * The checks of a saved suite, read from the page's cached report when its
 * row first opens. Shared reports supply their checks inline.
 */
export function SuiteReportCases({
  suiteKind,
  reportUrl,
  loadReport,
  inlineCases,
  incompleteReason,
  load,
}: {
  suiteKind: string;
  reportUrl?: string | null;
  loadReport?: LoadReport;
  inlineCases?: SavedReportCase[];
  incompleteReason: string | null;
  load: boolean;
}) {
  const [fetched, setCases] = useState<SavedReportCase[] | null | "error">(
    null,
  );
  const cases = inlineCases ?? fetched;
  const unrun = Array.isArray(cases)
    ? cases.filter(
        (check) =>
          check.status === "skipped" && check.skipReason === "could-not-run",
      )
    : [];
  const onlyMissingInput = unrun.length > 0 && unrun.every(isMissingInputCheck);
  useEffect(() => {
    if (inlineCases || !load || !reportUrl || fetched !== null) return;
    if (!loadReport) return;
    let cancelled = false;
    loadReport(suiteKind, reportUrl)
      .then((json) => {
        if (cancelled) return;
        setCases((json.groups ?? []).flatMap((group) => group.cases ?? []));
      })
      .catch(() => {
        if (!cancelled) setCases("error");
      });
    return () => {
      cancelled = true;
    };
  }, [inlineCases, load, reportUrl, fetched, loadReport, suiteKind]);

  return (
    <div>
      {incompleteReason ? (
        <p
          className={
            onlyMissingInput
              ? "py-2 pl-7 text-[13px] text-muted-foreground"
              : "py-2 pl-7 text-[13px] text-amber-700 dark:text-amber-400"
          }
        >
          {onlyMissingInput
            ? "Select the missing tool inputs in setup, then run again."
            : incompleteReason}
        </p>
      ) : null}
      {(!reportUrl && !inlineCases) || cases === "error" ? (
        <p className="py-3 pl-7 text-[13px] text-muted-foreground">
          The detailed report for this suite is not available. Run the checks
          again to generate a new one.
        </p>
      ) : cases === null ? (
        <p className="flex items-center gap-2 py-3 pl-7 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading checks…
        </p>
      ) : (
        cases.map((check) => (
          <div
            key={check.id}
            className="flex items-start gap-2.5 border-b border-border/60 py-1.75 pl-7 pr-1 last:border-0"
          >
            <span className="mt-0.5">
              <StatusIcon
                status={check.status}
                skipReason={
                  isMissingInputCheck(check) ? undefined : check.skipReason
                }
                muted={check.pending === true}
              />
            </span>
            {isMissingInputCheck(check) ? (
              <NotRunTag />
            ) : check.pending ? (
              <UnscoredTag />
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={
                  check.status === "skipped" &&
                  (isMissingInputCheck(check) ||
                    check.skipReason !== "could-not-run")
                    ? "text-[13px] text-muted-foreground"
                    : "text-[13px]"
                }
              >
                {check.title}
              </span>
              {check.error ? (
                <span
                  className={
                    check.status === "failed" && !check.pending
                      ? "text-[13px] font-medium text-red-600 dark:text-red-400"
                      : "text-[13px] text-muted-foreground"
                  }
                >
                  {missingInputMessage(check) ?? check.error}
                </span>
              ) : null}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
