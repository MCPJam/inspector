/**
 * Presentational pieces shared by the live Conformance panel and a saved
 * run's detail page, so a run reads the same in both places.
 */

import type { ReactNode } from "react";
import { Check, ChevronRight, Loader2, Minus, X } from "lucide-react";
import type { ConformanceScore } from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";

/** What each suite covers, in the rows' subtitle. */
export const SUITE_COPY = {
  protocol: {
    title: "Protocol",
    description:
      "Initialize, tools, resources, and the rules every server has to follow.",
  },
  apps: {
    title: "Apps",
    description: "UI tools and the HTML resources they point at.",
  },
  tasks: {
    title: "Tasks",
    description:
      "Task creation, status, and the wire this server version uses.",
  },
  oauth: {
    title: "OAuth",
    description:
      "The authorization flow, from discovery to an authorized call.",
  },
} as const;

/**
 * Animates open and closed by transitioning the grid row from 0fr to 1fr, so
 * the content slides to its natural height without measuring it. Children
 * stay mounted while closed so the closing slide has something to show;
 * `inert` keeps them out of focus and the accessibility tree meanwhile.
 */
export function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * A check's verdict as a small filled circle. `muted` keeps the glyph but
 * drops the color, for a result that is reported without counting (an
 * unscored check): a red ✕ beside "unscored" read as a failure that counts.
 */
export function StatusIcon({
  status,
  skipReason,
  muted = false,
}: {
  status: string;
  skipReason?: string;
  muted?: boolean;
}) {
  const circle =
    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full";
  const [color, glyph] =
    status === "passed"
      ? [
          "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          <Check className="h-2.5 w-2.5" strokeWidth={3} />,
        ]
      : status === "failed"
        ? [
            "bg-red-500/15 text-red-600 dark:text-red-400",
            <X className="h-2.5 w-2.5" strokeWidth={3} />,
          ]
        : skipReason === "could-not-run"
          ? [
              "bg-amber-400/25 text-amber-700 dark:text-amber-400",
              <span className="text-[10px] leading-none font-bold">!</span>,
            ]
          : [
              "bg-muted text-muted-foreground",
              <Minus className="h-2.5 w-2.5" strokeWidth={3} />,
            ];
  return (
    <span
      className={cn(circle, muted ? "bg-muted text-muted-foreground" : color)}
    >
      {glyph}
    </span>
  );
}

export type VerdictTone = "success" | "danger" | "warning" | "neutral";

const TONE_CLASS: Record<VerdictTone, string> = {
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  danger: "bg-red-500/10 text-red-600 dark:text-red-400",
  warning: "bg-amber-400/25 text-amber-700 dark:text-amber-400",
  neutral: "bg-muted text-muted-foreground",
};

/** PASSED / FAILED / … chip used for suites and runs. */
export function VerdictBadge({
  label,
  tone,
  spinning = false,
}: {
  label: string;
  tone: VerdictTone;
  spinning?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5.5 shrink-0 items-center gap-1 rounded-sm px-2 text-[11px] font-semibold tracking-[0.06em]",
        TONE_CLASS[tone],
      )}
    >
      {spinning && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  );
}

/**
 * One suite in the results card: chevron, title and subtitle, verdict chip
 * and score. The body slides open under it.
 */
export function SuiteRow({
  title,
  subtitle,
  badge,
  score,
  expanded,
  collapsible,
  onToggle,
  notice,
  children,
}: {
  title: string;
  subtitle: string;
  badge: ReactNode;
  /** Null renders an em dash: nothing was scored. */
  score: { score: number; passed: number; applicable: number } | null;
  expanded: boolean;
  collapsible: boolean;
  onToggle: () => void;
  /** Shown under the header whether or not the row is open. */
  notice?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-start gap-3 p-4 text-left transition-colors enabled:hover:bg-muted/30 disabled:cursor-default"
        onClick={onToggle}
        disabled={!collapsible}
        aria-expanded={collapsible ? expanded : undefined}
      >
        <ChevronRight
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
            expanded ? "rotate-90 text-foreground" : "text-muted-foreground",
          )}
        />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-sm text-muted-foreground">{subtitle}</span>
        </span>
        <span className="flex shrink-0 items-center gap-4">
          {badge}
          <span className="flex w-22 shrink-0 items-baseline justify-end gap-1">
            {score ? (
              <>
                <span className="text-xl font-medium tabular-nums">
                  {score.score}
                </span>
                <span className="text-[13px] font-medium">%</span>
                <span className="pl-1 text-xs font-medium text-muted-foreground tabular-nums">
                  {score.passed}/{score.applicable}
                </span>
              </>
            ) : (
              <span className="text-xl font-medium text-muted-foreground/50">
                —
              </span>
            )}
          </span>
        </span>
      </button>
      {notice}
      <Collapse open={expanded}>
        <div className="border-t border-border/60 px-4">{children}</div>
      </Collapse>
    </div>
  );
}

/** The counts a headline needs; a live score and a saved run both have them. */
export type ScoreSummary = Pick<
  ConformanceScore,
  "score" | "outcome" | "applicable" | "passed" | "failed" | "couldNotRun"
> &
  Partial<Pick<ConformanceScore, "notApplicable" | "advisories">>;

/**
 * The run's headline: pooled score, what it was judged against, the verdict
 * in words, and a bar splitting the applicable checks by outcome.
 */
export function OverallScoreCard({
  score,
  serverName,
  version,
  isRunning = false,
  oauthNotScored = false,
}: {
  score: ScoreSummary | undefined;
  serverName: string;
  /** Protocol revision shown in the eyebrow, e.g. "2025-11-25" or "Auto". */
  version: string;
  isRunning?: boolean;
  oauthNotScored?: boolean;
}) {
  const scored = score && score.score !== null ? score : undefined;
  const initials = serverName.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";

  const verdict = (() => {
    // A partial score is no verdict: a clean Protocol would read "Fully
    // conformant." until a suite still running fails.
    if (isRunning) return "Running conformance checks...";
    if (!scored) {
      // A run that ended before any check was scored, such as one that timed
      // out, is incomplete rather than empty.
      return score?.outcome === "incomplete"
        ? "Incomplete. No check finished, so there is no score."
        : "Nothing applicable to score on this server.";
    }
    const plural = (n: number, word: string) =>
      `${n} ${word}${n === 1 ? "" : "s"}`;
    if (scored.outcome === "failed") {
      return `Not conformant. ${plural(scored.failed, "check")} failed.`;
    }
    if (scored.outcome === "incomplete") {
      return `Incomplete. ${plural(scored.couldNotRun, "check")} could not run.`;
    }
    // A saved run carries no advisories list, but a passed run only scores
    // under 100 when it has advisories.
    return scored.score! < 100
      ? "Conformant, with advice."
      : "Fully conformant.";
  })();

  const notes = [
    score?.notApplicable ? `${score.notApplicable} not applicable` : null,
    oauthNotScored ? "OAuth not scored (no auth)" : null,
  ].filter(Boolean);

  return (
    <div className="relative flex flex-col gap-4.5 overflow-hidden rounded-lg border border-border bg-popover px-6 pt-6 pb-5">
      <div className="text-[11px] font-semibold tracking-[0.08em] text-primary">
        OVERALL SCORE · PROTOCOL {version.toUpperCase()}
      </div>
      <div className="flex items-center justify-between gap-6">
        <div className="flex items-end gap-2.5">
          {scored ? (
            <>
              <div className="flex items-end gap-px">
                <span className="text-7xl leading-16 font-medium tracking-[-0.04em] tabular-nums">
                  {Math.round(scored.score!)}
                </span>
                <span className="pb-1 text-[28px] leading-8 font-medium">
                  %
                </span>
              </div>
              <span className="pb-2 text-sm font-medium text-muted-foreground tabular-nums">
                {scored.passed}/{scored.applicable}
              </span>
            </>
          ) : (
            <span className="text-7xl leading-16 font-medium text-muted-foreground/40">
              {isRunning ? <Loader2 className="h-12 w-12 animate-spin" /> : "—"}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-indigo-500/10 text-[13px] font-bold text-indigo-700 dark:text-indigo-300">
            {initials.charAt(0).toUpperCase() + initials.slice(1).toLowerCase()}
          </span>
          <span className="truncate text-base font-semibold">{serverName}</span>
        </div>
      </div>
      <div className="text-sm font-medium">
        {verdict}
        {notes.length > 0 && (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {notes.join(" · ")}
          </span>
        )}
      </div>
      {scored && scored.applicable > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex h-1.5">
          <div className="bg-emerald-500" style={{ flexGrow: scored.passed }} />
          <div className="bg-red-500" style={{ flexGrow: scored.failed }} />
          <div
            className="bg-amber-400"
            style={{ flexGrow: scored.couldNotRun }}
          />
        </div>
      )}
    </div>
  );
}
