/**
 * The six-stage chain, as one row of chips.
 *
 * This says HOW FAR the trial got and nothing else. The state WORD lives on
 * the Scorecard's group headings, where a reader is already looking at the
 * rows for that stage; here the state is only a colour, so nothing is stated
 * twice.
 *
 * It lives inside the Scorecard rather than above the tabs on purpose. The
 * trial header already carries PASSED / FAILED on every tab; this is a
 * breakdown of that verdict, which is analysis — and analysis is what the
 * Scorecard is. Above the tabs it would show half the story on Chat and Raw,
 * where the group headings that complete it do not exist.
 *
 * Clicking a chip opens its detail underneath. For Connection, Discovery and
 * Tool call that is the ONLY place they appear: nothing authors them, so they
 * have no rows and no group. The chip is their home, not a shortcut to one.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import {
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  USER_VALUE_STAGES,
} from "@mcpjam/sdk/contract";

const DOT_TONE: Record<string, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  notReached: "bg-border",
  notMeasured: "bg-border",
  notApplicable: "bg-border",
};

export function StageStrip({
  chain,
  resetKey,
}: {
  chain: EvalRunDecisionChain | null | undefined;
  /** A different trial is a different chain; a carried selection would lie. */
  resetKey?: string;
}) {
  const [openStage, setOpenStage] = useState<string | null>(null);
  useEffect(() => setOpenStage(null), [resetKey]);

  // Nothing to say YET is not nothing to say: a pane whose read has not landed
  // renders nothing rather than an absent-chain notice.
  if (!chain || chain.status !== "verified") return null;

  const byStage = new Map(chain.stages.map((row) => [row.stage, row]));
  const open = openStage
    ? byStage.get(openStage as (typeof USER_VALUE_STAGES)[number])
    : undefined;

  return (
    <div data-testid="stage-strip">
      <ul className="flex flex-wrap items-center gap-1.5">
        {USER_VALUE_STAGES.map((stage, index) => {
          const row = byStage.get(stage);
          const state = row?.state ?? "notMeasured";
          const active = openStage === stage;
          return (
            <li key={stage}>
              <button
                type="button"
                data-testid={`stage-chip-${stage}`}
                data-state={state}
                aria-pressed={active}
                aria-label={`${USER_VALUE_STAGE_LABELS[stage]}: ${STAGE_STATE_LABELS[state]}`}
                onClick={() => setOpenStage(active ? null : stage)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                  state === "failed"
                    ? "border-destructive/45 font-semibold text-destructive"
                    : state === "passed"
                      ? "border-border text-foreground"
                      : "border-border/60 text-muted-foreground",
                  active && "ring-1 ring-ring",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    DOT_TONE[state] ?? "bg-border",
                  )}
                />
                <span className="tabular-nums text-[10px] text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {USER_VALUE_STAGE_LABELS[stage]}
              </button>
            </li>
          );
        })}
      </ul>

      {open ? (
        <div
          className="mt-2 space-y-0.5 rounded-md border border-border/60 px-2.5 py-2"
          data-testid="stage-strip-detail"
        >
          <p className="text-[11px] font-medium text-foreground">
            {USER_VALUE_STAGE_LABELS[open.stage]}{" "}
            <span
              className={cn(
                "font-normal",
                open.state === "failed"
                  ? "text-destructive"
                  : open.state === "passed"
                    ? "text-success"
                    : "text-muted-foreground",
              )}
            >
              {STAGE_STATE_LABELS[open.state]}
            </span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {USER_VALUE_STAGE_QUESTIONS[open.stage]}
          </p>
          {open.reason ? (
            <p className="text-[11px] text-muted-foreground">
              {STAGE_REASON_LABELS[open.reason] ?? open.reason}
            </p>
          ) : null}
          {/* `evidence` is structured, not prose. Only the predicate reasons
              are readable as a sentence; span ids and prompt indexes are for
              the Trace tab, not for a person reading a verdict. */}
          {(open.evidence?.predicateReasons ?? []).map((reason) => (
            <p key={reason} className="text-[11px] text-muted-foreground/80">
              {reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
