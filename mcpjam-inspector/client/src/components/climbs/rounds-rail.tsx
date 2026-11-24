import { Loader2, Play } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type { Climb } from "./climb-types";
import { ResultIcon } from "./result-badge";
import {
  RESULT_WORD,
  changeTitle,
  roundResult,
  submittedByLabel,
} from "./round-model";
import type { RoundChanges } from "./use-round-changes";

export type Selection = "base" | "new" | number;

function RailRow({
  active,
  onClick,
  tag,
  label,
  sub,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  tag: string;
  label: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-normal",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{tag}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate" title={label}>
          {label}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      {icon}
    </Button>
  );
}

/**
 * The baseline, then one row a round with who submitted it and where it
 * stands. While MCPJam is choosing the next change, a row says so.
 */
export function RoundsRail({
  climb,
  changes,
  selection,
  onSelect,
}: {
  climb: Climb;
  changes: RoundChanges;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const baselining = climb.state === "baselining";
  const picking = climb.picker === "mcpjam" && climb.step !== undefined && !climb.paused;
  return (
    <nav aria-label="Rounds" className="flex flex-col gap-0.5 border-border p-3 md:border-r">
      <Button
        className="mb-2 justify-start"
        disabled={baselining || climb.state === "stopped"}
        variant={selection === "new" ? "default" : "outline"}
        onClick={() => onSelect("new")}
      >
        <Play aria-hidden /> New round
      </Button>
      <RailRow
        active={selection === "base"}
        onClick={() => onSelect("base")}
        tag="B"
        label="Baseline"
        sub={baselining ? "Running" : "Two runs each"}
        icon={<ResultIcon result={baselining ? "running" : "kept"} />}
      />
      {climb.rounds.map((round) => {
        const result = roundResult(round);
        return (
          <RailRow
            key={round.number}
            active={selection === round.number}
            onClick={() => onSelect(round.number)}
            tag={String(round.number)}
            label={changeTitle(changes[round.number], round.number)}
            sub={`${submittedByLabel(climb, round)} · ${RESULT_WORD[result]}`}
            icon={<ResultIcon result={result} />}
          />
        );
      })}
      {picking ? (
        <p
          className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          MCPJam is choosing the next change.
        </p>
      ) : null}
    </nav>
  );
}
