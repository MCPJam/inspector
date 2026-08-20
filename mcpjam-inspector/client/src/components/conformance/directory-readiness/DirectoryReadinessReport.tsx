/**
 * The findings, grouped by what they mean rather than by what they say.
 *
 * ## Why grouping is by CLASS
 *
 * Readiness findings do not sort into pass and fail. A `runtime-blocker` and a
 * `heuristic` can both read `violated` and mean completely different things:
 * one keeps a submission out of the directory, the other is an opinion worth
 * considering. `decideLaneStatus` only consults the dispositive classes, so a
 * reader who cannot see the class cannot tell which findings actually moved
 * the verdict — and a model-authored observation would look exactly like a
 * requirement.
 *
 * The order is the order somebody fixes things in: what blocks, then what is
 * required, then what is advice.
 *
 * ## Not-evaluated is a first-class row
 *
 * A finding that never ran carries its reason, and hiding it would leave the
 * reader believing the check passed. It renders in its own muted style with
 * the reason attached, so "nobody looked" never reads as "nothing wrong".
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

type FindingLike = {
  id: string;
  title: string;
  lane: string;
  class: string;
  status: string;
  remediation?: string;
  provenance?: string;
  notEvaluatedReason?: string;
  source?: { page?: string; section?: string };
};

/** Fix-order, and the label a reader needs to know what a group costs them. */
const CLASS_GROUPS: Array<{ key: string; title: string; blurb: string }> = [
  {
    key: "runtime-blocker",
    title: "Runtime blockers",
    blurb: "The host cannot use this server until these are fixed.",
  },
  {
    key: "required",
    title: "Directory requirements",
    blurb: "The publisher's rules require these before a submission is listed.",
  },
  {
    key: "recommended",
    title: "Recommended",
    blurb: "Not disqualifying, but expected of a good submission.",
  },
  {
    key: "manual-review",
    title: "Needs a human",
    blurb: "A reviewer decides these; no automated check can.",
  },
  {
    key: "heuristic",
    title: "Observations",
    blurb: "Judgement calls, never part of the verdict.",
  },
];

function StatusIcon({ status }: { status: string }) {
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

function FindingRow({ finding }: { finding: FindingLike }) {
  const [open, setOpen] = useState(false);
  const detail = finding.notEvaluatedReason ?? finding.remediation;
  const expandable = Boolean(detail || finding.source?.page);

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
        <StatusIcon status={finding.status} />
        <span className="min-w-0 flex-1 text-[11px] leading-snug">
          {finding.title}
        </span>
        {/*
          A model wrote this line. Saying so is not a disclaimer — it is what
          lets a reader weigh it differently from a wire observation.
        */}
        {finding.provenance === "llm" && (
          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground flex-shrink-0">
            <Sparkles className="h-2.5 w-2.5" />
            AI
          </span>
        )}
      </button>
      {open && detail && (
        <div className="pl-8 pr-1 pt-1 text-[10px] leading-relaxed text-muted-foreground">
          {detail}
          {finding.source?.page && (
            <div className="pt-0.5 opacity-70">
              Source: {finding.source.page}
              {finding.source.section ? ` — ${finding.source.section}` : ""}
            </div>
          )}
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

  // A run that ended without a report says so. The reason is the whole value
  // of the row — silence here would read as a run that found nothing.
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
  if (findings.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {CLASS_GROUPS.map((group) => {
        const rows = findings.filter((finding) => finding.class === group.key);
        if (rows.length === 0) return null;
        return (
          <div key={group.key}>
            <div className="px-1 pt-1 text-[10px] font-medium text-foreground/80">
              {group.title}{" "}
              <span className="font-normal text-muted-foreground">
                ({rows.length}) — {group.blurb}
              </span>
            </div>
            <div className="divide-y divide-border/30">
              {rows.map((finding) => (
                <FindingRow key={finding.id} finding={finding} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
