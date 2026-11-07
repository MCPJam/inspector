/**
 * Stats on the Suite run page: per client · model, either the results or the
 * speed and cost, with each change against the same pairing's previous run
 * as a chip under its value.
 */
import { TrendingDown, TrendingUp } from "lucide-react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { cn } from "@/lib/utils";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import { InfoHint } from "../../evals/global-gates-info";
import { formatRunCaseLatencyMs } from "../../evals/run-case-groups";
import {
  formatHeroCount,
  type HeroPairingPass,
  type HeroStatDelta,
} from "../run-verdict-hero-deltas";

export type NavRunStatsView = "results" | "speed";

export const STATS_HINT =
  "This run at a glance: pass rate, iterations passed and failed, latency (P50, P95), tokens and tool calls, per client · model. Arrows compare with the previous run on the same model.";

const MISSING = "—";

const CHIP_TONE: Record<HeroStatDelta["tone"], string> = {
  progress: "bg-success/10 text-success",
  regression: "bg-destructive/10 text-destructive",
  same: "bg-muted text-muted-foreground",
};

/** "−17%" on a pass rate reads "−17 pts"; "=" reads "No change". */
export function deltaChipText(delta: HeroStatDelta, unit?: "pts"): string {
  if (delta.direction === "same") return "No change";
  return unit === "pts" ? delta.label.replace(/%$/, " pts") : delta.label;
}

function DeltaChip({ delta, unit }: { delta: HeroStatDelta; unit?: "pts" }) {
  const same = delta.direction === "same";
  const text = deltaChipText(delta, unit);
  const verdict = same
    ? ""
    : delta.tone === "progress"
      ? ", better"
      : ", worse";
  const Arrow = delta.direction === "up" ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        CHIP_TONE[delta.tone],
      )}
      aria-label={`${text}${verdict} vs previous run`}
      data-testid="run-verdict-stat-delta"
    >
      {same ? null : <Arrow className="size-3" aria-hidden />}
      {text}
    </span>
  );
}

type Cell = {
  label: string;
  value: string;
  delta?: HeroStatDelta | null;
  unit?: "pts";
  tone?: "pass" | "fail";
};

function StatGroup({
  label,
  columns,
  cells,
  showDeltas,
}: {
  label: string;
  columns: number;
  cells: Cell[];
  showDeltas: boolean;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      role="group"
      aria-label={label}
    >
      <div
        className="grid gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="flex min-w-0 flex-col gap-1 bg-card px-2.5 py-2"
            data-testid="run-verdict-pairing-stat"
          >
            <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {cell.label}
            </span>
            <span
              className={cn(
                "text-lg font-semibold leading-6 tabular-nums",
                cell.tone === "pass" && "text-success",
                cell.tone === "fail" && "text-destructive",
              )}
            >
              {cell.value}
            </span>
            {showDeltas && cell.delta ? (
              <DeltaChip delta={cell.delta} unit={cell.unit} />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function resultCells(pairing: HeroPairingPass): Cell[] {
  return [
    {
      label: "Pass rate",
      value:
        pairing.passRate == null ? MISSING : `${Math.round(pairing.passRate)}%`,
      delta: pairing.passRateDelta,
      unit: "pts",
    },
    {
      label: "Passed",
      value: String(pairing.passed),
      delta: pairing.delta,
      tone: "pass",
    },
    { label: "Failed", value: String(pairing.failed), tone: "fail" },
    ...(pairing.pending > 0
      ? [{ label: "Pending", value: String(pairing.pending) }]
      : []),
    ...(pairing.cancelled > 0
      ? [{ label: "Cancelled", value: String(pairing.cancelled) }]
      : []),
  ];
}

function speedCells(pairing: HeroPairingPass): Cell[] {
  const { stats, statDeltas } = pairing;
  const count = (value: number | null) =>
    value == null ? MISSING : formatHeroCount(value);
  return [
    {
      label: "P50",
      value: formatRunCaseLatencyMs(stats.latencyP50Ms),
      delta: statDeltas.latencyP50,
    },
    {
      label: "P95",
      value: formatRunCaseLatencyMs(stats.latencyP95Ms),
      delta: statDeltas.latencyP95,
    },
    { label: "Tokens", value: count(stats.tokens), delta: statDeltas.tokens },
    {
      label: "Calls",
      value: count(stats.toolCalls),
      delta: statDeltas.toolCalls,
    },
  ];
}

function Footnote({ previousRunNumber }: { previousRunNumber: number | null }) {
  return (
    <p className="text-[11px] text-muted-foreground">
      {previousRunNumber == null ? (
        "First run of this client and model."
      ) : (
        <>
          vs run #{previousRunNumber} ·{" "}
          <span className="text-success">green</span> better,{" "}
          <span className="text-destructive">red</span> worse
        </>
      )}
    </p>
  );
}

export function NavRunStats({
  pairings,
  view,
  onViewChange,
  onPick,
  picked,
  hideIdentity,
}: {
  pairings: readonly HeroPairingPass[];
  view: NavRunStatsView;
  onViewChange: (view: NavRunStatsView) => void;
  /** Absent with one target: there is nothing to filter. */
  onPick?: (key: string) => void;
  picked: string | null;
  /** The Showing bar already names a run's only client · model. */
  hideIdentity: boolean;
}) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  return (
    <section
      className="flex flex-col gap-5 px-5 py-4"
      aria-label="Stats"
      data-testid="nav-run-stats"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            Stats
            <InfoHint
              label="About Stats"
              className="border border-border bg-muted/50"
            >
              {STATS_HINT}
            </InfoHint>
          </h3>
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value === "results" || value === "speed") onViewChange(value);
            }}
            aria-label="Stats view"
            className="rounded-md bg-muted/50 p-0.5"
          >
            {(
              [
                ["results", "Results"],
                ["speed", "Speed and cost"],
              ] as const
            ).map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="h-7 min-w-0 flex-none rounded-sm px-2.5 text-xs font-normal text-muted-foreground first:rounded-sm last:rounded-sm hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <ul
          className="divide-y divide-border/60"
          data-testid="run-verdict-pairings"
        >
          {pairings.map((pairing) => {
            const showDeltas = pairing.pending === 0;
            const identity = (
              <>
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
              </>
            );
            const cells =
              view === "speed" ? speedCells(pairing) : resultCells(pairing);
            return (
              <li
                key={pairing.key}
                className="flex min-w-0 flex-col gap-2 py-3"
                data-testid="run-verdict-pairing"
              >
                {hideIdentity ? null : onPick ? (
                  <button
                    type="button"
                    aria-pressed={picked === pairing.key}
                    title={
                      picked === pairing.key
                        ? "Show all models"
                        : "Show only this model"
                    }
                    onClick={() => onPick(pairing.key)}
                    className="-mx-2 flex min-w-0 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {identity}
                  </button>
                ) : (
                  <div className="flex min-w-0 shrink-0 items-center gap-2">
                    {identity}
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <StatGroup
                    label={view === "speed" ? "Speed and cost" : "Results"}
                    columns={view === "speed" ? 2 : Math.min(3, cells.length)}
                    cells={cells}
                    showDeltas={showDeltas}
                  />
                  <Footnote previousRunNumber={pairing.previousRunNumber} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
