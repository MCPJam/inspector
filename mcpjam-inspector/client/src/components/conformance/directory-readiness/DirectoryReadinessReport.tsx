/**
 * Every finding, under the lane it graded, in the suites' own visual grammar.
 *
 * ## Why lanes, not classes, are the grouping
 *
 * The first version grouped findings by class — blockers, requirements,
 * advice — which is the right taxonomy and the wrong navigation. The suites
 * beside this render a flat list of check rows the moment a run finishes, and
 * that immediacy is what makes them legible: you click, you see every check,
 * you expand the red ones. Readiness now does the same, with the lane rows
 * the summary already showed becoming the group headers, so the number a
 * reader saw ("10/14 evaluated") sits directly above the fourteen rows it
 * counted. The class survives as a chip on each row, because it still decides
 * whether that row moved the verdict.
 *
 * ## Every row answers "so what do I do"
 *
 * A violated row expands to its remediation. A not-evaluated row expands to
 * the reason it never ran — the engine writes these as real sentences — and
 * the doc link names the exact page and section of the publisher's rules, so
 * an agent (or a person) can go from a red row to the requirement's source
 * without guessing. That is the "enough information to fix it" bar: id,
 * status, why, what to change, and where it is written.
 */

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MinusCircle,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { DirectoryReadinessResult } from "@/lib/apis/directory-readiness-api";
import {
  CLASS_LABEL,
  FINDING_STATUS_ORDER,
  describeMissingInputs,
} from "./readiness-copy";

type FindingLike = {
  id: string;
  title: string;
  lane: string;
  class: string;
  status: string;
  remediation?: string;
  provenance?: string;
  notEvaluatedReason?: string;
  source?: { page?: string; section?: string; url?: string };
  details?: Record<string, unknown>;
};

type LaneLike = {
  lane: string;
  status: "ready" | "not-ready" | "incomplete";
  coverage: {
    evaluated: number;
    notEvaluated: number;
    notApplicable: number;
    missingInputs: string[];
  };
};

function laneLabel(lane: string): string {
  const spaced = lane.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function LaneIcon({ status }: { status: LaneLike["status"] }) {
  if (status === "ready") {
    return (
      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
    );
  }
  if (status === "not-ready") {
    return <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />;
  }
  return <MinusCircle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />;
}

function FindingIcon({ status }: { status: string }) {
  if (status === "violated") {
    return <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />;
  }
  if (status === "satisfied") {
    return (
      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
    );
  }
  if (status === "not-evaluated") {
    return (
      <MinusCircle className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
    );
  }
  return <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />;
}

/** `details` keys that repeat what the row already says. */
const NOISY_DETAIL_KEYS = new Set(["missingInput"]);

function detailRows(details: Record<string, unknown> | undefined) {
  if (!details) return [];
  return Object.entries(details).filter(
    ([key, value]) =>
      !NOISY_DETAIL_KEYS.has(key) &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"),
  );
}

function FindingRow({ finding }: { finding: FindingLike }) {
  const [open, setOpen] = useState(false);
  // The sentence the row exists to deliver: why it never ran, or how to fix
  // it. Satisfied rows usually carry neither and stay unexpandable.
  const explanation = finding.notEvaluatedReason ?? finding.remediation;
  const extra = detailRows(finding.details);
  const expandable = Boolean(explanation || extra.length > 0 || finding.source);

  const chip =
    finding.status === "satisfied" || finding.status === "not-applicable"
      ? undefined
      : CLASS_LABEL[finding.class];

  return (
    <div className="px-1 py-1">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 text-left"
        onClick={() => setOpen((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
      >
        {expandable ? (
          open ? (
            <ChevronDown className="mt-0.5 h-3 w-3 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-3 w-3 text-muted-foreground flex-shrink-0" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <FindingIcon status={finding.status} />
        <span className="min-w-0 flex-1 text-[11px] leading-snug">
          {finding.title}
        </span>
        {finding.provenance === "llm" && (
          // A model wrote this line; the label is what lets a reader weigh it
          // differently from a wire observation.
          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground flex-shrink-0">
            <Sparkles className="h-2.5 w-2.5" />
            AI
          </span>
        )}
        {chip && (
          <span className="rounded border border-border/60 px-1 py-0.5 text-[9px] text-muted-foreground flex-shrink-0">
            {chip}
          </span>
        )}
      </button>
      {open && (
        <div className="pl-8 pr-1 pt-1 text-[10px] leading-relaxed text-muted-foreground space-y-1">
          {explanation && <div>{explanation}</div>}
          {extra.length > 0 && (
            <div className="space-y-0.5">
              {extra.map(([key, value]) => (
                <div key={key} className="flex gap-1.5">
                  <span className="opacity-70">{key}:</span>
                  <span className="break-all">{String(value)}</span>
                </div>
              ))}
            </div>
          )}
          {finding.source?.url ? (
            <div className="opacity-80">
              Rule:{" "}
              <a
                href={finding.source.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {finding.source.page ?? finding.source.url}
                {finding.source.section ? ` ${finding.source.section}` : ""}
              </a>
            </div>
          ) : finding.source?.page ? (
            <div className="opacity-80">
              Rule: {finding.source.page}
              {finding.source.section ? ` ${finding.source.section}` : ""}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function LaneGroup({
  lane,
  findings,
}: {
  lane: LaneLike;
  findings: FindingLike[];
}) {
  // Open when there is something to act on; a clean lane stays folded so the
  // red ones carry the attention.
  const actionable = lane.status !== "ready";
  const [open, setOpen] = useState(actionable);
  const total = lane.coverage.evaluated + lane.coverage.notEvaluated;
  const guidance = describeMissingInputs(lane.coverage.missingInputs);

  return (
    <div className="rounded-md border border-border/40">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted/30"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          )}
          <LaneIcon status={lane.status} />
          <span className="text-xs font-medium truncate">
            {laneLabel(lane.lane)}
          </span>
        </span>
        {/* The denominator travels with the verdict: "ready over 3 of 8" and
            "ready over 8" are different statements. */}
        <span className="text-[10px] tabular-nums text-muted-foreground flex-shrink-0">
          {lane.coverage.evaluated}/{total} evaluated
          {lane.coverage.notApplicable > 0
            ? ` · ${lane.coverage.notApplicable} n/a`
            : ""}
        </span>
      </button>
      {open && (
        <div className="px-1 pb-1">
          {guidance.length > 0 && (
            <div className="mx-1 mb-1 rounded bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400 space-y-0.5">
              {guidance.map((sentence) => (
                <div key={sentence}>{sentence}</div>
              ))}
            </div>
          )}
          <div className="divide-y divide-border/30">
            {findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function DirectoryReadinessReport({
  report,
  loading,
  error,
  hasReport,
  terminalReason,
  errorMessage,
}: {
  report?: DirectoryReadinessResult;
  loading?: boolean;
  error?: string;
  hasReport: boolean;
  terminalReason?: string;
  errorMessage?: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading findings...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-1 py-2 text-[10px] text-red-400">
        The findings could not be loaded: {error}
      </div>
    );
  }

  // A run that ended without a report says so — silence would read as a run
  // that found nothing.
  if (!report && !hasReport) {
    return (
      <div className="px-1 py-2 text-[10px] text-muted-foreground">
        {terminalReason
          ? `No findings were stored for this run (${terminalReason}).`
          : "No findings were stored for this run."}
        {errorMessage ? ` ${errorMessage}` : ""}
      </div>
    );
  }

  if (!report) return null;

  const findings = (report.findings ?? []) as FindingLike[];
  const lanes = (report.lanes ?? []) as LaneLike[];

  return (
    <div className="space-y-2">
      {/* The engine writes this sentence for exactly this spot: what the
          verdict is and what would change it. */}
      {report.summary && (
        <div className="px-1 text-[11px] leading-relaxed text-foreground/80">
          {report.summary}
        </div>
      )}
      <div className="space-y-1.5">
        {lanes.map((lane) => {
          const rows = findings
            .filter((finding) => finding.lane === lane.lane)
            .sort(
              (left, right) =>
                (FINDING_STATUS_ORDER[left.status] ?? 9) -
                (FINDING_STATUS_ORDER[right.status] ?? 9),
            );
          if (
            rows.length === 0 &&
            lane.coverage.evaluated + lane.coverage.notEvaluated === 0
          ) {
            return null;
          }
          return <LaneGroup key={lane.lane} lane={lane} findings={rows} />;
        })}
      </div>
    </div>
  );
}
