/**
 * Presentational pieces shared by the live Conformance panel and a saved
 * run's detail page, so a run reads the same in both places.
 */

import { useState, type ReactNode } from "react";
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
          <span className="flex shrink-0 items-baseline gap-1">
            {score ? (
              <>
                <span className="text-xl font-medium tabular-nums">
                  {score.score}
                </span>
                <span className="text-[13px] font-medium">%</span>
                <span className="pl-1 text-sm font-medium text-muted-foreground tabular-nums">
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

function initialsOf(name: string): string {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

/**
 * A server's logo, or its initials when it has none or the image fails, so
 * a broken link never leaves an empty square.
 */
export function ServerAvatar({
  name,
  iconUrl,
  className,
}: {
  name: string;
  iconUrl?: string;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const box = cn(
    "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md",
    className,
  );
  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <span className={cn(box, "bg-muted/40")}>
        <img
          src={iconUrl}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="size-full object-contain p-1"
          onError={() => setFailedUrl(iconUrl)}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(box, "bg-primary/10 text-[13px] font-bold text-primary")}
    >
      {initialsOf(name)}
    </span>
  );
}

/** The counts a headline needs; a live score and a saved run both have them. */
export type ScoreSummary = Pick<
  ConformanceScore,
  "score" | "outcome" | "applicable" | "passed" | "failed" | "couldNotRun"
> &
  Partial<Pick<ConformanceScore, "notApplicable" | "advisories" | "pending">> & {
    /** A saved run's advice count, where there is no advisories list. */
    advisoryCount?: number;
  };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A sentence after the verdict: "11 checks could not run and 15 checks not applicable." */
function exceptionSentence(parts: string[]): string {
  if (parts.length <= 1) return `${parts[0] ?? ""}.`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;
}

/**
 * The run's headline: pooled score, what it was judged against, the verdict
 * in words, every count by kind, and a bar splitting the applicable checks by
 * outcome.
 */
export function OverallScoreCard({
  score,
  serverName,
  serverIconUrl,
  version,
  isRunning = false,
  progress,
  oauthNotScored = false,
  blockedBySignIn = 0,
  timedOut = 0,
  action,
  note,
}: {
  score: ScoreSummary | undefined;
  serverName: string;
  serverIconUrl?: string;
  /** Protocol revision shown in the eyebrow, e.g. "2025-11-25" or "Auto". */
  version: string;
  isRunning?: boolean;
  /** How many suites have finished, while the run is going. */
  progress?: { done: number; total: number };
  oauthNotScored?: boolean;
  /**
   * How many checks were refused for credentials. A run blocked that way says
   * nothing definitive about the server, so the verdict names the sign-in
   * instead of calling the server not conformant. It can count checks the
   * score counts, so pass only scored refusals; the verdict also clamps it to
   * `couldNotRun`.
   */
  blockedBySignIn?: number;
  /**
   * How many scored checks timed out. They could not run, so the verdict
   * names the timeout; clamped to `couldNotRun` like `blockedBySignIn`.
   */
  timedOut?: number;
  /** Shown at the end of the verdict line, e.g. a link to the saved run. */
  action?: ReactNode;
  /**
   * Why the run ended early, e.g. "Run stopped before every requested suite
   * settled". It sits under the verdict it explains, inside the card.
   */
  note?: string | null;
}) {
  // No number while the run is going: it moves as each suite lands (a clean
  // first suite reads 100% before a later one fails), so it would claim a
  // result the run has not reached. The card shows progress until it ends.
  const scored =
    !isRunning && score && score.score !== null ? score : undefined;
  const missingInputs = score
    ? Math.max(0, score.passed + score.failed + score.couldNotRun - score.applicable)
    : 0;
  const signInBlocked = Math.min(blockedBySignIn, score?.couldNotRun ?? 0);
  // A check a 401 stopped is a setup gap too, and the sign-in sentence already
  // counts it; the setup sentence counts only the rest.
  const setupGaps =
    signInBlocked > 0 ? Math.max(0, missingInputs - signInBlocked) : missingInputs;
  const inputSentence =
    setupGaps > 0
      ? `${plural(setupGaps, "check")} need${setupGaps === 1 ? "s" : ""} a setup change. Each one says what to change, then run again.`
      : null;

  const verdict = (() => {
    // A partial score is no verdict: a clean Protocol would read
    // "Conformant." until a suite still running fails.
    if (isRunning) {
      return progress
        ? `Running conformance checks. ${progress.done} of ${progress.total} suites done.`
        : "Running conformance checks...";
    }
    if (score && signInBlocked > 0) {
      const otherUnrun = score.couldNotRun - signInBlocked;
      return [
        `Incomplete. ${plural(signInBlocked, "check")} could not run because sign-in failed.`,
        otherUnrun > 0 ? `${otherUnrun} more could not run.` : null,
        "Reconnect the server and run again.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (
      score?.outcome === "incomplete" &&
      missingInputs > 0 &&
      score.couldNotRun === missingInputs
    ) {
      return `Incomplete. ${inputSentence}`;
    }
    if (!scored) {
      // A run that ended before any check was scored, such as one that timed
      // out, is incomplete rather than empty.
      return score?.outcome === "incomplete"
        ? "Incomplete. No check finished, so there is no score."
        : "Nothing applicable to score on this server.";
    }
    if (scored.outcome === "failed") {
      return "Not conformant.";
    }
    if (scored.outcome === "incomplete") {
      const otherUnrun = scored.couldNotRun - missingInputs;
      const late = Math.min(timedOut, otherUnrun);
      if (late === 0) {
        return [
          `Incomplete. ${plural(otherUnrun, "check")} could not run.`,
          inputSentence,
        ]
          .filter(Boolean)
          .join(" ");
      }
      return [
        `Incomplete. ${plural(late, "check")} could not run because the server did not answer in time.`,
        otherUnrun > late ? `${otherUnrun - late} more could not run.` : null,
        inputSentence,
      ]
        .filter(Boolean)
        .join(" ");
    }
    // Advice is worth 0 points, so the score cannot tell a passed run with
    // advice from one without; read the advice itself.
    const advised =
      (scored.advisories?.length ?? scored.advisoryCount ?? 0) > 0;
    // Checks that need input are optional and out of the score, like checks
    // that are not applicable, so they don't change the verdict. The input
    // sentence still says how to run them.
    const conformant = advised
      ? "Conformant, with guidance."
      : "Conformant.";
    return [conformant, inputSentence].filter(Boolean).join(" ");
  })();

  // The fraction already says how many passed. This line is only the checks
  // the fraction leaves out, minus the counts the verdict already gives.
  const verdictCountsUnrun =
    signInBlocked > 0 || scored?.outcome === "incomplete";
  const verdictCountsInputs =
    inputSentence !== null && verdict.includes(inputSentence);
  const counts =
    score && !isRunning
      ? [
          score.couldNotRun > missingInputs && !verdictCountsUnrun
            ? `${plural(score.couldNotRun - missingInputs, "check")} could not run`
            : null,
          setupGaps && !verdictCountsInputs
            ? `${plural(setupGaps, "check")} not run (needs setup)`
            : null,
          score.pending ? `${plural(score.pending, "check")} unscored` : null,
          score.notApplicable
            ? `${plural(score.notApplicable, "check")} not applicable`
            : null,
          oauthNotScored ? "OAuth not scored (no auth)" : null,
        ].filter((part): part is string => part !== null)
      : [];

  return (
    <div className="relative flex flex-col gap-4.5 overflow-hidden rounded-lg border border-border bg-popover px-6 pt-6 pb-5">
      <div className="text-xs font-semibold tracking-[0.08em] text-primary">
        OVERALL SCORE · PROTOCOL {version.toUpperCase()}
      </div>
      <div className="flex items-center justify-between gap-6">
        <div className="flex items-baseline gap-2.5">
          {scored ? (
            <>
              <div className="flex items-baseline gap-px">
                <span className="text-6xl leading-none font-medium tracking-[-0.04em] tabular-nums">
                  {scored.score!}
                </span>
                <span className="text-3xl leading-none font-medium">%</span>
              </div>
              <span className="text-2xl font-medium text-muted-foreground tabular-nums">
                {scored.passed}/{scored.applicable}
              </span>
            </>
          ) : isRunning ? (
            <span className="flex h-16 items-center gap-3 text-muted-foreground">
              <Loader2 className="h-10 w-10 animate-spin" aria-hidden="true" />
              {progress ? (
                <span className="text-2xl font-medium tabular-nums">
                  {progress.done}/{progress.total}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-6xl leading-none font-medium text-muted-foreground/40">
              —
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          <ServerAvatar name={serverName} iconUrl={serverIconUrl} />
          <span className="truncate text-base font-semibold">{serverName}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <div className="text-base font-medium">{verdict}</div>
          {counts.length > 0 && (
            <div className="text-sm text-muted-foreground tabular-nums">
              {exceptionSentence(counts)}
            </div>
          )}
        </div>
        {action}
      </div>
      {note ? (
        <p className="-mt-2.5 text-sm text-amber-700 dark:text-amber-400">
          {note}
        </p>
      ) : null}
      {isRunning ? (
        // Indeterminate: the run's length is not known up front.
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1.5 animate-pulse bg-primary/40 motion-reduce:animate-none"
        />
      ) : null}
      {scored && scored.applicable > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex h-1.5">
          <div className="bg-emerald-500" style={{ flexGrow: scored.passed }} />
          <div className="bg-red-500" style={{ flexGrow: scored.failed }} />
          <div
            className="bg-amber-400"
            style={{ flexGrow: scored.couldNotRun - missingInputs }}
          />
          {missingInputs > 0 && <div className="bg-muted-foreground/30" style={{ flexGrow: missingInputs }} />}
        </div>
      )}
    </div>
  );
}
