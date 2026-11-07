/**
 * The Suite run page's body: one model filter for the whole page. Picking a
 * client · model (a Showing chip or a pairing in Stats) scopes Stats,
 * Findings and Test runs together; picking it again returns to all models.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { RunTestRuns } from "../run-case-rows";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import type { HeroPairingPass } from "../run-verdict-hero-deltas";
import { NavRunStats, type NavRunStatsView } from "./nav-run-stats";

type Target = RunResultsMatrixData["targets"][number];

const tally = (targets: readonly Target[]) =>
  `${targets.reduce((sum, target) => sum + target.counts.passed, 0)}/${targets.reduce(
    (sum, target) => sum + target.iterations.length,
    0,
  )}`;

function Chip({
  label,
  score,
  on,
  inert,
  onClick,
}: {
  label: string;
  score: string;
  on: boolean;
  inert: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={on ? "secondary" : "outline"}
      aria-pressed={on}
      className={cn(
        "h-7 gap-1.5 rounded-full px-2.5 text-xs",
        on && "ring-1 ring-primary/50",
        inert && "pointer-events-none",
      )}
      onClick={onClick}
    >
      {label}
      <span className="tabular-nums text-muted-foreground">{score}</span>
    </Button>
  );
}

export function NavRunLayout({
  matrix,
  pairings,
  passThreshold,
  findings,
  onOpenTestRun,
  onEditTestCase,
}: {
  matrix: RunResultsMatrixData;
  /** Keyed by the matrix targets' keys. */
  pairings: readonly HeroPairingPass[];
  /** 0–1, or null. */
  passThreshold: number | null;
  /** The Findings section for the picked target, or for the run when null. */
  findings: (picked: Target | null) => ReactNode;
  /** targetKey is set when one model of several is picked. */
  onOpenTestRun: (caseKey: string, targetKey: string | null) => void;
  onEditTestCase: (testCaseId: string) => void;
}) {
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [statsView, setStatsView] = useState<NavRunStatsView>("results");
  const { targets } = matrix;
  const several = targets.length > 1;
  const picked =
    (several && targets.find((target) => target.key === pickedKey)) || null;
  const pick = (key: string) =>
    setPickedKey((current) => (current === key ? null : key));
  const shown = picked ? [picked] : targets;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="nav-run-content">
      <div
        className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-border/60 bg-card px-5 py-3"
        role="group"
        aria-label="Filter this run by client and model"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Showing
        </span>
        {several ? (
          <Chip
            label="All models"
            score={tally(targets)}
            on={picked === null}
            inert={false}
            onClick={() => setPickedKey(null)}
          />
        ) : null}
        {targets.map((target) => (
          <Chip
            key={target.key}
            label={`${target.client} · ${target.model}`}
            score={tally([target])}
            on={!several || picked?.key === target.key}
            inert={!several}
            onClick={() => pick(target.key)}
          />
        ))}
        {several ? (
          <span className="text-[11px] text-muted-foreground">
            Click a model anywhere on this page to filter it.
          </span>
        ) : null}
      </div>
      <div className="@container/nav-run shrink-0">
        <div className="grid gap-px bg-border/40 @min-[44rem]/nav-run:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="min-w-0 bg-card">
            <NavRunStats
              pairings={
                picked
                  ? pairings.filter((pairing) => pairing.key === picked.key)
                  : pairings
              }
              view={statsView}
              onViewChange={setStatsView}
              {...(several ? { onPick: pick } : {})}
              picked={picked?.key ?? null}
              hideIdentity={!several}
            />
          </div>
          <div className="min-w-0 bg-card">
            <div className="px-5 py-4">{findings(picked)}</div>
            <div className="border-t border-border/40 px-5 py-4">
              <RunTestRuns
                rows={matrix.rows}
                targets={shown}
                passThreshold={passThreshold}
                onOpen={(caseKey) =>
                  onOpenTestRun(caseKey, picked ? picked.targetKey : null)
                }
                onEdit={onEditTestCase}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
