/**
 * What a finished run's IMPORTED cases were allowed to prove, and on whose say-so.
 *
 * Everything rendered here is FROZEN: the platform derived it from the run's
 * own snapshot at the moment the run started. Nothing on this card is read
 * from the suite's current cases, and nothing on it is the viewer — a run
 * approved last Tuesday by somebody else must not read as approved by whoever
 * happens to be looking at it now.
 *
 * The load-bearing wording is `incomplete`. It is NOT a test verdict: the run
 * has not said the server regressed, it has said its own evidence cannot be
 * relied on. So the card says "not gateable", never "failed" — a screen that
 * blamed the server under test for a conversion nobody finished reviewing
 * would send people to debug the wrong thing.
 */

import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { ImportEligibility } from "./types";
import { cn } from "@/lib/utils";

function formatTimestamp(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return String(epochMs);
  }
}

export function ImportEvidenceCard({
  eligibility,
  className,
}: {
  eligibility: ImportEligibility | undefined;
  className?: string;
}) {
  // Absent means either "still loading" or "this deployment reports none".
  // Both render nothing: a placeholder saying "no imported cases" would be a
  // claim, and neither state supports one.
  if (!eligibility) return null;
  // A run with no imported cases at all — every native run, forever. There is
  // nothing to disclose, and a card on every run would be noise on the surface
  // where native runs are the norm.
  if (eligibility.status === "legacy" && eligibility.importedCaseCount === 0) {
    return null;
  }

  const notGateable =
    eligibility.status === "incomplete" || eligibility.gateable === false;

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-xs",
        notGateable
          ? "border-warning/40 bg-warning/5"
          : "border-border/60 bg-muted/20",
        className,
      )}
      data-testid="import-evidence-card"
    >
      <div className="flex items-center gap-2">
        {notGateable ? (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warning-foreground" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground">
          {notGateable
            ? "Import evidence incomplete — this run is not gateable"
            : "Imported cases"}
        </span>
      </div>

      <p className="mt-1 text-muted-foreground">
        {notGateable
          ? "This is not a test failure. The run's imported cases do not carry " +
            "the decisions a deployment gate would rely on, so the run cannot " +
            "be used as one."
          : `${eligibility.importedCaseCount} imported ${
              eligibility.importedCaseCount === 1 ? "case" : "cases"
            } ran with a recorded decision.`}
      </p>

      {eligibility.claimedExactCaseIds.length > 0 ? (
        <p className="mt-1.5 text-muted-foreground">
          {eligibility.claimedExactCaseIds.length}{" "}
          {eligibility.claimedExactCaseIds.length === 1 ? "case" : "cases"} ran
          on a converter-claimed exact mapping. MCPJam did not verify semantic
          equivalence.
        </p>
      ) : null}

      {eligibility.approvedApproximationReceipts.length > 0 ? (
        <div className="mt-2 space-y-1.5" data-testid="import-approval-receipts">
          <p className="font-medium text-foreground">
            Approved approximations
          </p>
          {eligibility.approvedApproximationReceipts.map((receipt) => (
            <div
              key={receipt.testCaseId}
              className="rounded border border-border/50 bg-background/60 px-2 py-1.5"
            >
              <div className="text-foreground">
                {receipt.caseKey ?? receipt.testCaseId}
              </div>
              {/*
                WHO and WHEN come from the run, not from the session. A run
                approved by somebody else last week must not read as approved
                by whoever opened this screen today.
              */}
              <div className="mt-0.5 text-muted-foreground">
                Approved by {receipt.approvedBy} ·{" "}
                {formatTimestamp(receipt.approvedAt)}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-foreground">
                {receipt.reason}
              </div>
              {receipt.sourceCaseKey ? (
                <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                  Source case: {receipt.sourceCaseKey}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {eligibility.issues.length > 0 ? (
        <div className="mt-2 space-y-0.5" data-testid="import-evidence-issues">
          {eligibility.issues.map((issue, index) => (
            <div
              key={`${issue.code}-${issue.testCaseId ?? index}`}
              className="text-muted-foreground"
            >
              <span className="font-mono text-[11px]">{issue.code}</span>
              {issue.caseKey || issue.testCaseId ? (
                <span> · {issue.caseKey ?? issue.testCaseId}</span>
              ) : null}
              {issue.toolName ? <span> · {issue.toolName}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
