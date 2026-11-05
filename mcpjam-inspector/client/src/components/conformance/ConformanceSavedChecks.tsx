import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isMissingInputCheck } from "@mcpjam/sdk/browser";
import { isRecord } from "@/lib/host-capabilities";
import { CheckRow, type CheckRowResult } from "./ConformanceCheckRows";
import type { LoadReport, SavedReportCase } from "./use-saved-run-reports";

function savedCheckRowResult(check: SavedReportCase): CheckRowResult {
  let details = check.details;
  let warnings: string[] | undefined;
  if (isRecord(details)) {
    const { details: nested, warnings: savedWarnings, ...metadata } = details;
    // Reports wrap live fields; keep their markers where CheckRow reads them.
    details = isRecord(nested)
      ? { ...nested, ...metadata }
      : nested === undefined
        ? metadata
        : { details: nested, ...metadata };
    warnings = Array.isArray(savedWarnings)
      ? savedWarnings.filter(
          (warning): warning is string => typeof warning === "string",
        )
      : undefined;
  }
  return {
    ...check,
    error: check.error ? { message: check.error } : undefined,
    details,
    warnings,
  };
}

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
          <CheckRow
            key={check.id}
            check={savedCheckRowResult(check)}
            pending={check.pending}
          />
        ))
      )}
    </div>
  );
}
