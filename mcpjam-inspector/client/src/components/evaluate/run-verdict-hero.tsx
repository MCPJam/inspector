/**
 * One measurement row per client/model pairing, then the insights.
 *
 * Reading order IS the design here. Everything a run measures is a per-client
 * fact, so the whole row belongs to the pairing: logo, name, pass rate,
 * passed/failed, and the four measurements. Latency, tokens, and tool calls
 * used to be one page-level strip underneath; rolled up across two clients
 * that figure described neither of them, so it now sits in each row against
 * the pairing it was measured on.
 *
 * Every string comes from {@link buildRunVerdictHero}. The view chooses type
 * and colour; it never decides what is true.
 */
import { useRunHeaderVerdict } from "./evaluate-run-page";
import { remedyForDiagnostic } from "./stage-remedy";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Lightbulb,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";

import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import {
  formatHeroCount,
  type HeroPairingPass,
  type HeroStatDelta,
} from "./run-verdict-hero-deltas";
import type {
  HeroVerdictTone,
  RunVerdictHeroView,
} from "./run-verdict-hero-model";

const VERDICT_TONE_CLASS: Record<HeroVerdictTone, string> = {
  passed: "text-success",
  failed: "text-destructive",
  // Amber. An inconclusive run measured too little to decide, and red would
  // report a defect the run never observed.
  caution: "text-warning",
  neutral: "text-muted-foreground",
};

/** Absent stays absent — a dash, never a zero. Callers label it for a reader. */
function formatCount(value: number | null): string {
  if (value === null) return "—";
  return formatHeroCount(value);
}

const DELTA_TONE_CLASS = {
  progress: "text-success",
  regression: "text-destructive",
  same: "text-muted-foreground",
} as const;

function StatDelta({ delta }: { delta: HeroStatDelta }) {
  // An unchanged measurement says nothing worth a second glyph. The row is
  // dense enough without a column of lonely equals signs.
  if (delta.direction === "same") return null;
  const Arrow = delta.direction === "up" ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[13px] font-medium tabular-nums",
        DELTA_TONE_CLASS[delta.tone],
      )}
      aria-label={`${delta.label} vs previous run`}
      data-testid="run-verdict-stat-delta"
    >
      <Arrow className="size-3" aria-hidden />
      {delta.label}
    </span>
  );
}

const PAIRING_STAT_TONE_CLASS = {
  pass: "text-success",
  fail: "text-destructive",
  neutral: "text-foreground",
} as const;

/** One labelled measurement inside a pairing row. */
function PairingStat({
  label,
  value,
  delta,
  tone = "neutral",
  unavailable = false,
  count = false,
}: {
  label: string;
  value: string;
  delta?: HeroStatDelta | null;
  tone?: keyof typeof PAIRING_STAT_TONE_CLASS;
  /** Absent is not zero. The dash carries the reason for a screen reader. */
  unavailable?: boolean;
  count?: boolean;
}) {
  return (
    <div className="min-w-0" data-testid="run-verdict-pairing-stat">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1">
        <span
          className={cn(
            "tabular-nums",
            count
              ? "text-[26px] font-medium leading-8"
              : "text-lg font-semibold leading-6",
            PAIRING_STAT_TONE_CLASS[tone],
          )}
          {...(unavailable ? { "aria-label": `${label} not recorded` } : {})}
        >
          {value}
        </span>
        {delta ? <StatDelta delta={delta} /> : null}
      </div>
    </div>
  );
}

function PairingPassList({
  pairings,
  showDeltas,
}: {
  pairings: HeroPairingPass[];
  showDeltas: boolean;
}) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  return (
    <ul
      className="divide-y divide-border/60"
      data-testid="run-verdict-pairings"
    >
      {pairings.map((pairing) => (
        <li
          key={pairing.key}
          className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3 py-4"
          data-testid="run-verdict-pairing"
        >
          <div className="flex w-[250px] min-w-0 shrink-0 items-center gap-2">
            <img
              src={resolveHostLogoByName(pairing.client, theme)}
              alt=""
              className="size-6 shrink-0 object-contain"
            />
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold text-foreground">
                {pairing.client}
              </span>
              <span className="block truncate text-sm text-muted-foreground">
                {pairing.model}
              </span>
            </span>
          </div>

          <div
            className="flex min-w-[120px] shrink-0 items-baseline gap-2"
            data-testid="run-verdict-pairing-rate"
          >
            <span className="text-[34px] font-bold leading-none tabular-nums text-foreground">
              {pairing.passRate == null
                ? "—"
                : `${Math.round(pairing.passRate)}%`}
            </span>
            {showDeltas && pairing.pending === 0 && pairing.passRateDelta ? (
              <StatDelta delta={pairing.passRateDelta} />
            ) : null}
          </div>

          <div className="flex shrink-0 items-start gap-5">
            <PairingStat
              label="Passed"
              count
              value={String(pairing.passed)}
              tone="pass"
              delta={showDeltas && pairing.pending === 0 ? pairing.delta : null}
            />
            <PairingStat
              label="Failed"
              count
              value={String(pairing.failed)}
              tone="fail"
            />
            {/* Only when they exist: a run with no pending rows should not
                carry a column of zeroes, but one that has them must not be
                reported as though every iteration decided. */}
            {pairing.pending > 0 ? (
              <PairingStat label="Pending" value={String(pairing.pending)} />
            ) : null}
            {pairing.cancelled > 0 ? (
              <PairingStat
                label="Cancelled"
                value={String(pairing.cancelled)}
              />
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-start gap-x-8 gap-y-3 border-l border-border/60 pl-9">
            <PairingStat
              label="P50"
              value={formatRunCaseLatencyMs(pairing.stats.latencyP50Ms)}
              delta={showDeltas && pairing.pending === 0 ? pairing.statDeltas.latencyP50 : null}
              unavailable={pairing.stats.latencyP50Ms == null}
            />
            <PairingStat
              label="P95"
              value={formatRunCaseLatencyMs(pairing.stats.latencyP95Ms)}
              delta={showDeltas && pairing.pending === 0 ? pairing.statDeltas.latencyP95 : null}
              unavailable={pairing.stats.latencyP95Ms == null}
            />
            <PairingStat
              label="Tokens"
              value={formatCount(pairing.stats.tokens)}
              delta={showDeltas && pairing.pending === 0 ? pairing.statDeltas.tokens : null}
              unavailable={pairing.stats.tokens == null}
            />
            <PairingStat
              label="Calls"
              value={formatCount(pairing.stats.toolCalls)}
              delta={showDeltas && pairing.pending === 0 ? pairing.statDeltas.toolCalls : null}
              unavailable={pairing.stats.toolCalls == null}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The hero's own contract-derived explanation.
 *
 * Exported because the run page now hands the findings block into the
 * explanation slot and needs THIS as the fallback: a run with no findings
 * built must still say what broke, in the words prod already ships.
 */
export function HeroExplanation({ view }: { view: RunVerdictHeroView }) {
  const remedy = view.focus ? remedyForDiagnostic(view.focus.diagnostic) : null;
  const hasSentence = view.sentence.text.trim().length > 0;
  const summaryLoading =
    view.pending ||
    (!hasSentence &&
      ["Running", "Pending", "Queued"].includes(view.verdict.word));
  return summaryLoading ? (
    <div
      className="grid divide-y divide-border/40 border-t border-border/60 pt-3 lg:grid-cols-2 lg:divide-x lg:divide-y-0"
      role="status"
      aria-label="Loading run summary"
      data-testid="run-summary-loading"
    >
      {[0, 1].map((column) => (
        <div
          key={column}
          className="min-w-0 space-y-3 py-3 lg:px-4 lg:py-2 lg:first:pl-0"
          aria-hidden="true"
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ))}
    </div>
  ) : hasSentence ? (
    <div
      className="grid divide-y divide-border/40 border-t border-border/60 pt-3 lg:grid-cols-2 lg:divide-x lg:divide-y-0"
      data-testid="run-verdict-insights"
    >
      <div className="min-w-0 py-3 lg:px-4 lg:py-2 lg:first:pl-0">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            {view.sentence.kind === "noFailure" ? (
              <CircleCheck
                className="size-4 text-muted-foreground"
                aria-hidden
              />
            ) : view.sentence.kind === "brokeAt" ? (
              <TriangleAlert
                className="size-4 text-muted-foreground"
                aria-hidden
              />
            ) : (
              <CircleAlert
                className="size-4 text-muted-foreground"
                aria-hidden
              />
            )}
            {view.sentence.kind === "noFailure"
              ? "What passed"
              : view.sentence.kind === "brokeAt"
                ? "What broke"
                : "What happened"}
          </h4>
        </div>
        {hasSentence ? (
          <p
            className="mt-2 max-w-[72ch] text-sm leading-relaxed text-foreground"
            data-testid="run-verdict-sentence"
          >
            {view.sentence.text}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 py-3 lg:px-4 lg:py-2">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            {remedy ? (
              <Wrench className="size-4 text-muted-foreground" aria-hidden />
            ) : (
              <Lightbulb className="size-4 text-muted-foreground" aria-hidden />
            )}
            {remedy ? "How to fix" : "Next step"}
          </h4>
        </div>
        <p
          className="mt-2 text-sm leading-relaxed text-foreground"
          data-testid="run-verdict-remedy"
        >
          {remedy?.text ??
            (view.pending
              ? "Results are still arriving. Inspect the live case matrix below as iterations complete."
              : view.sentence.kind === "noFailure"
                ? "Compare with a previous run to check for regressions, or export this report to share the evidence."
                : "Open the case evidence to inspect the recorded result. No specific remediation has been established for this run.")}
        </p>
      </div>
    </div>
  ) : null;
}

export function RunVerdictHero({
  view,
  headerVerdict = view.verdict,
  onOpenFailingTrace,
  actions,
  explanation,
}: {
  view: RunVerdictHeroView;
  headerVerdict?: RunVerdictHeroView["verdict"];
  onOpenFailingTrace?: () => void;
  /** The primary action slot, so the copy-prompt button can land here later. */
  actions?: React.ReactNode;
  /**
   * What sits under the pairing rows.
   *
   * `undefined` keeps the hero's own two columns — the shape prod ships, and
   * what a surface with no findings block still gets. A node REPLACES them, so
   * the run page renders exactly one explanation instead of the hero's and the
   * findings block's side by side. `null` renders neither.
   */
  explanation?: React.ReactNode | null;
}) {
  const inHeader = useRunHeaderVerdict(headerVerdict);
  const showVerdict = !inHeader && view.verdict.word !== "Running";
  const pairings = view.pairings ?? [];
  const hasPairings = pairings.length > 0;
  const canOpenTrace = Boolean(onOpenFailingTrace && view.focus);

  return (
    <section
      className="flex flex-col gap-5 px-5 py-4"
      data-testid="run-verdict-hero"
    >
      <div className="min-w-0 flex-1">
        {showVerdict ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3
              className={cn(
                "text-[30px] font-bold leading-none tracking-tight",
                VERDICT_TONE_CLASS[view.verdict.tone],
              )}
              data-testid="run-verdict-word"
            >
              {view.verdict.word}
            </h3>
            {view.verdict.undecidedLine ? (
              <span className="text-[12.5px] text-muted-foreground">
                {view.verdict.undecidedLine}
              </span>
            ) : null}
          </div>
        ) : null}

        {hasPairings ? (
          <div className={cn(showVerdict && "mt-4")}>
            <PairingPassList
              pairings={pairings}
              showDeltas={
                !view.pending &&
                !["Running", "Pending", "Queued"].includes(headerVerdict.word) &&
                !["Running", "Pending", "Queued"].includes(view.verdict.word)
              }
            />
          </div>
        ) : null}

        {explanation !== undefined ? (
          explanation === null ? null : (
            <div className="border-t border-border/60 pt-3">{explanation}</div>
          )
        ) : (
          <HeroExplanation view={view} />
        )}

        {actions || canOpenTrace ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {actions}
            {canOpenTrace ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onOpenFailingTrace}
                data-testid="run-verdict-open-trace"
              >
                Open failing trace
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
