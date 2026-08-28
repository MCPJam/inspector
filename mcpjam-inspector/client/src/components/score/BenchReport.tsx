/**
 * One benchmark result, as a document a stranger can read.
 *
 * Six things this file exists to get right, all of them about the difference
 * between a claim and the absence of one:
 *
 *  1. **Sections, not one number — when there ARE sections.** `sections` is
 *     ABSENT on a v1 scorecard, and its presence is the only honest signal
 *     that this result has any: `scores.core` and `scores.composite` are
 *     populated for v1 rows too, so keying off them would report the v1 pooled
 *     number under a v2 heading. Present ⇒ the section view, with `overall`
 *     as the headline. Absent ⇒ the three v1 numbers, named as what they are.
 *  2. **`partial` is not a failure.** The measured sections keep their real
 *     scores and only the Overall is withheld. It reads as a withheld Overall.
 *  3. **A slice with `score: null` says "not measured".** "This connector
 *     scores 0 for support agents" and "no case in this exam represents a
 *     support agent" are different claims, and only the first is about the
 *     connector.
 *  4. **Coverage travels with every section.** `not_applicable` (the target
 *     does not advertise the thing) and `insufficient_evidence` (it does, and
 *     we failed to measure it) are opposite statements that a bare `null`
 *     flattens into one.
 *  5. **A deprecated or deleted result is labelled, never shown as active.**
 *     The link keeps resolving on purpose — a shared link should explain
 *     itself rather than 404 — so the label is the only thing standing between
 *     a reader and a retracted number.
 *  6. **A rerun warning distinguishes the two reruns.** Same definition hash
 *     is the same exam and stays in one comparison series; a new hash is a new
 *     exam, and its scores are not points on the same line.
 *
 * Nothing here computes a score, renormalizes a section, or fills in a null.
 */

import type { ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { AlertTriangle, ShieldCheck, Trash2 } from "lucide-react";
import { StageFunnel } from "@/components/shared/user-value-chain/StageFunnel";
import type { ChatSessionStageFunnel } from "@/components/shared/user-value-chain/user-value-chain-types";
import { SessionFlowSankey } from "@/components/shared/usage-insights/SessionFlowSankey";
import { ExplanatoryFlowOptIn } from "@/components/shared/usage-insights/ExplanatoryFlowOptIn";
import type {
  InsightsScope,
  SankeyStage,
  UsageBreakdown,
} from "@/hooks/useUsageInsights";
import type {
  BenchResult,
  BenchScorecard,
  BenchSection,
  BenchSectionKey,
  BenchSlice,
} from "@/lib/apis/bench-api";
import { benchCleanupState } from "@/lib/apis/bench-api";
import { cn } from "@/lib/utils";

/**
 * The benchmark's own column names.
 *
 * The first column is PINNED to the exam — each trace's band is read off the
 * definition's hashed per-case metadata rather than clustered — so calling it
 * "Goal" would imply we discovered it. The other three are a model's reading
 * of the traces and keep their emergent names.
 */
export const BENCH_STAGE_TITLES: Partial<Record<SankeyStage, string>> = {
  goal: "Exam case",
  behavior: "What it did",
  outcome: "Outcome",
  sentiment: "How it read",
};

const SECTION_TITLES: Record<BenchSectionKey, string> = {
  coreProtocol: "Core Protocol",
  protocolExtensions: "Protocol Extensions",
  workflowReliability: "Workflow Reliability",
};

const COVERAGE_LABELS: Record<BenchSection["coverage"], string> = {
  eligible: "measured",
  provisional: "below the publication floor",
  insufficient_evidence: "not enough evidence",
  not_applicable: "not advertised by this connector",
};

const STATUS_LABELS: Record<BenchScorecard["status"], string> = {
  scored: "Scored",
  provisional: "Provisional",
  partial: "Partial",
  insufficient_evidence: "Not enough evidence",
};

const STATUS_BLURBS: Record<BenchScorecard["status"], string> = {
  scored: "Every applicable input was measured and every floor was met.",
  provisional:
    "Real evidence throughout, below a publication floor. Every number below stands; the result is not public-eligible.",
  // Rule 2. Not a failure — a withheld Overall over sections that measured.
  partial:
    "The sections below measured normally. The Overall is withheld because not every section it needs produced a number.",
  insufficient_evidence:
    "We ran, and what came back does not support a claim in either direction.",
};

function Score({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-xs text-muted-foreground">not measured</span>;
  }
  return (
    <span className="text-sm font-semibold tabular-nums">
      {Math.round(value)}
      <span className="text-[10px] font-normal text-muted-foreground">
        /100
      </span>
    </span>
  );
}

function SectionRow({ section }: { section: BenchSection }) {
  return (
    <li
      className="flex items-start justify-between gap-3 border-b border-border/30 px-4 py-2 last:border-b-0"
      data-section={section.section}
    >
      <div className="min-w-0">
        <div className="text-xs font-medium">
          {SECTION_TITLES[section.section]}
        </div>
        {/* Rule 4. `not_applicable` and `insufficient_evidence` stay apart. */}
        <div className="text-[11px] text-muted-foreground">
          {COVERAGE_LABELS[section.coverage]}
          {section.components?.length
            ? ` · ${section.components.length} input${
                section.components.length === 1 ? "" : "s"
              }`
            : ""}
        </div>
      </div>
      <Score value={section.score} />
    </li>
  );
}

/**
 * A v1 scorecard, in v1's own vocabulary.
 *
 * Three pooled numbers with no sections behind them. They are NOT relabelled
 * as Core Protocol / Workflow Reliability / Overall: under v2 those names mean
 * a specific rollup over specific components, and a v1 row has neither. The
 * headline is deliberately smaller than the v2 Overall — it is a weaker claim,
 * and it should not read as the same one.
 */
function LegacyScores({
  scores,
}: {
  scores: NonNullable<BenchScorecard["scores"]>;
}) {
  return (
    <Panel title="Scores">
      <ul>
        {(
          [
            ["Core", scores.core],
            ["Category", scores.category],
            ["Composite", scores.composite],
          ] as const
        ).map(([label, value]) => (
          <li
            key={label}
            className="flex items-center justify-between gap-3 border-b border-border/30 px-4 py-2 last:border-b-0"
            data-legacy-score={label.toLowerCase()}
          >
            <span className="text-xs font-medium">{label}</span>
            <Score value={value} />
          </li>
        ))}
      </ul>
      <p className="px-4 py-2 text-[11px] text-muted-foreground">
        Scored by an earlier version of the scorer, which reported these three
        pooled numbers and no sections. They are not comparable with a sectioned
        result&apos;s Overall.
      </p>
    </Panel>
  );
}

function SliceGroup({
  title,
  slices,
}: {
  title: string;
  slices: BenchSlice[];
}) {
  if (slices.length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold">{title}</h4>
      <ul className="space-y-0.5">
        {slices.map((slice) => (
          <li
            key={`${slice.kind}:${slice.slug}`}
            className="flex items-baseline justify-between gap-3 text-[11px]"
            data-slice={slice.slug}
          >
            <span className="min-w-0 truncate">
              {slice.label ?? slice.slug}
            </span>
            {slice.score === null ? (
              // Rule 3. Never a zero: no case measured this persona.
              <span className="shrink-0 text-muted-foreground">
                not measured
                {slice.casesTagged > 0
                  ? ` · ${slice.casesTagged} case${
                      slice.casesTagged === 1 ? "" : "s"
                    } tagged, none scored`
                  : " · no case in this exam carries this tag"}
              </span>
            ) : (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">
                  {Math.round(slice.score)}
                </span>{" "}
                ({slice.casesScored}/{slice.casesTagged} cases)
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-md border border-border/50", className)}
      aria-label={title}
    >
      <div className="border-b border-border/40 bg-muted/20 px-4 py-2 text-xs font-medium">
        {title}
      </div>
      {children}
    </section>
  );
}

export function BenchReport({
  result,
  funnel,
  flow,
  flowScope = null,
  onRerunSameExam,
  onRerunLatestExam,
}: {
  result: BenchResult;
  /** Stage rollups over this run's traces. Free — no model call produced it. */
  funnel?: ChatSessionStageFunnel | null;
  /** The four-column flow. Absent until somebody paid for the analyzer pass. */
  flow?: UsageBreakdown | null;
  /**
   * The cohort a not-yet-bought analysis would be filed against. Supplied only
   * where the reader can actually authorize the spend — the public result link
   * has no session to bill, so it passes nothing and the offer never appears.
   */
  flowScope?: InsightsScope | null;
  onRerunSameExam?: () => void;
  onRerunLatestExam?: () => void;
}) {
  const cleanupState = benchCleanupState(result.cleanup);
  const scorecard = result.scorecard;
  const sections = scorecard?.sections;
  // On the SCORECARD, not the result. The backend nests lifecycle state with
  // the document it describes, and a top-level read finds nothing — so this
  // check was constantly false and a withdrawn score rendered as a live one,
  // which is the single thing the banner below exists to prevent.
  const publication = scorecard?.publication;
  const retracted =
    publication?.status === "deprecated" || publication?.status === "deleted";

  const icpSlices = (scorecard?.slices ?? []).filter(
    (slice) => slice.kind === "icp",
  );
  const goalSlices = (scorecard?.slices ?? []).filter(
    (slice) => slice.kind === "goal",
  );

  return (
    <div className="space-y-5">
      {/* Rule 5. A retracted result explains itself; it is never shown active. */}
      {retracted ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px]">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div>
            <div className="font-medium">
              This result was{" "}
              {publication?.status === "deleted" ? "deleted" : "deprecated"}.
            </div>
            <p className="text-muted-foreground">
              {publication?.reason ??
                "It no longer appears in leaderboards or aggregate statistics. The link still resolves so it can explain itself."}
            </p>
          </div>
        </div>
      ) : null}

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {scorecard ? (
            <Badge variant="outline" className="text-[10px]">
              {STATUS_LABELS[scorecard.status]}
            </Badge>
          ) : null}
          {scorecard?.verification === "mcpjam_verified" ? (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <ShieldCheck className="h-3 w-3" />
              MCPJam verified
            </Badge>
          ) : scorecard?.verification ? (
            <Badge variant="outline" className="text-[10px]">
              {scorecard.verification === "mixed"
                ? "Mixed evidence"
                : "Client reported"}
            </Badge>
          ) : null}
          {result.category?.userSelected ? (
            // The visitor said what to score this as. That is a real
            // measurement of a real question — it is not a registry fact, and
            // it can never back a public claim.
            <Badge variant="outline" className="text-[10px]">
              User-selected · not registry verified
            </Badge>
          ) : null}
        </div>
        {result.definition ? (
          <p className="text-xs text-muted-foreground">
            {result.definition.profileId ?? "Benchmark"}
            {result.definition.version ? ` ${result.definition.version}` : ""}
            {result.category?.slug ? ` · ${result.category.slug}` : ""}
          </p>
        ) : null}
        {scorecard ? (
          <p className="text-[11px] text-muted-foreground">
            {STATUS_BLURBS[scorecard.status]}
          </p>
        ) : null}
      </header>

      {/* Rule 1. The PRESENCE of `sections` picks the view, not the value of
          any number inside it. */}
      {sections ? (
        <>
          {sections.overall !== null ? (
            <div className="flex items-center gap-4 rounded-md border border-border/50 bg-muted/30 px-6 py-5">
              <div className="text-6xl font-semibold leading-none tabular-nums">
                {Math.round(sections.overall)}
                <span className="ml-0.5 text-lg font-normal text-muted-foreground">
                  /100
                </span>
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium">Overall</div>
                <div className="text-xs text-muted-foreground">
                  The equal-weight mean of the sections that produced a number.
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              No Overall. It needs both Core Protocol and Workflow Reliability
              to have produced a number
              {sections.unmeasured?.length
                ? `, and ${sections.unmeasured
                    .map((key) => SECTION_TITLES[key])
                    .join(" and ")} did not.`
                : "."}
            </div>
          )}
          <Panel title="Sections">
            <ul>
              <SectionRow section={sections.coreProtocol} />
              <SectionRow section={sections.protocolExtensions} />
              <SectionRow section={sections.workflowReliability} />
            </ul>
          </Panel>
        </>
      ) : scorecard?.scores ? (
        <LegacyScores scores={scorecard.scores} />
      ) : null}

      {scorecard?.provisionalReasons?.length ? (
        <div className="rounded-md border border-border/50 px-4 py-2.5">
          <div className="text-[11px] font-medium">
            Why this is not public-eligible
          </div>
          <ul className="mt-1 space-y-0.5">
            {scorecard.provisionalReasons.map((reason) => (
              <li key={reason} className="text-[11px] text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {icpSlices.length > 0 || goalSlices.length > 0 ? (
        <Panel title="Who and what this was measured for">
          <div className="space-y-3 px-4 py-3">
            <SliceGroup title="By persona" slices={icpSlices} />
            <SliceGroup title="By goal" slices={goalSlices} />
            <p className="text-[11px] text-muted-foreground">
              A slice is a view of the same case outcomes the sections are built
              from. It never changes how a section is weighted.
            </p>
          </div>
        </Panel>
      ) : null}

      {funnel ? (
        <StageFunnel
          summary={funnel}
          title="User value chain"
          populationLabel="Traces from this benchmark run"
        />
      ) : null}

      {flow ? (
        <Panel title="How the run flowed">
          <div className="px-1 py-1">
            <SessionFlowSankey
              breakdown={flow}
              selection={null}
              // A published report is a document, not a workbench: there is
              // nothing to drill into and no cohort to rebuild from here.
              onSelectNode={() => {}}
              onSelectLink={() => {}}
              onRebuild={() => {}}
              rebuildBusy={false}
              stageTitles={BENCH_STAGE_TITLES}
            />
          </div>
          <p className="px-4 pb-3 text-[11px] text-muted-foreground">
            The first column is read off the exam&apos;s own pinned case tags.
            The other three are a model&apos;s reading of the traces and feed
            nothing that scores.
          </p>
        </Panel>
      ) : (
        // No pass has been bought for this run yet. The opt-in is the only
        // thing that can buy one, it issues nothing until it is clicked, and
        // it renders nothing at all without a scope — which is what the public
        // result link passes, having no session to bill.
        <ExplanatoryFlowOptIn
          scope={flowScope}
          stageTitles={BENCH_STAGE_TITLES}
          costLabel="It is priced into the run's own budget."
        />
      )}

      {/*
        Read from the counts, because counts are all there are: the ledger is
        `{recorded, removed, residue}` and carries no status word. The previous
        block branched on a `status`/`residueCount`/`detail` shape that nothing
        produces, so `"Everything this run created was removed"` was the
        rendered default for a document that had told it nothing.

        Nothing renders when the ledger is absent — "no cleanup reported" is
        not the same claim as "nothing was left behind", and this panel exists
        to make exactly that distinction.
      */}
      {cleanupState.kind !== "unreported" ? (
        <div className="flex items-start gap-2 rounded-md border border-border/50 px-3 py-2 text-[11px]">
          <Trash2 className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div>
            <div className="font-medium">
              {cleanupState.kind === "clean"
                ? cleanupState.removed === 0
                  ? "This run created nothing on the connector."
                  : "Everything this run created was removed."
                : cleanupState.kind === "residual"
                ? "Some of what this run created could not be removed."
                : "Cleanup had not finished when this was written."}
            </div>
            {cleanupState.kind === "residual" ? (
              <p className="text-amber-600 dark:text-amber-400">
                {cleanupState.residue} of {cleanupState.recorded} item
                {cleanupState.recorded === 1 ? "" : "s"} left behind, and may
                still be on the connector.
              </p>
            ) : null}
            {cleanupState.kind === "in_progress" ? (
              <p className="text-muted-foreground">
                {cleanupState.removed} of {cleanupState.recorded} removed.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Rule 6. Two different reruns, said differently. */}
      {result.rerun?.sameHashVersion || result.rerun?.latestVersion ? (
        <div className="space-y-2 rounded-md border border-border/50 px-3 py-2.5">
          <div className="text-[11px] font-medium">Run this again</div>
          {result.rerun.sameHashVersion && onRerunSameExam ? (
            <div className="space-y-1">
              <Button size="sm" variant="outline" onClick={onRerunSameExam}>
                Run again with {result.rerun.sameHashVersion}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                The same exam. The new score is another point on this same
                comparison series.
              </p>
            </div>
          ) : null}
          {result.rerun.definitionHashChanged &&
          result.rerun.latestVersion &&
          onRerunLatestExam ? (
            <div className="space-y-1">
              <Button size="sm" variant="outline" onClick={onRerunLatestExam}>
                Run the current exam ({result.rerun.latestVersion})
              </Button>
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                A new exam, and a new comparison series. Its score is not
                comparable with the one above.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
