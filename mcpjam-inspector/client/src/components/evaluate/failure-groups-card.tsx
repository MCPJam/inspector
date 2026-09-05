/**
 * Collapsed Case → Route → Reason flow for judged failures on this suite.
 *
 * Flag-off callers must not mount this. The card also fail-closes itself so
 * a test can assert no query and no DOM when the flag is off.
 */

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";

import { FlowSankeyDiagram } from "@/components/shared/usage-insights/flow-sankey-diagram";
import { SANKEY_UNLABELED } from "@/components/shared/usage-insights/insights-sankey";
import { useFailureGroupsEnabled } from "@/hooks/useFailureGroupsEnabled";
import { useSuiteFailureGroups } from "@/hooks/use-suite-failure-groups";
import {
  FAILURE_SANKEY_STAGES,
  FAILURE_STAGE_COLORS,
  FAILURE_STAGE_TITLES,
  UNJUDGED_REASON_LABEL,
  buildFailureSankey,
  failureGroupsBusy,
  failureGroupsHeader,
  flatReasonList,
} from "./failure-groups-model";

export function FailureGroupsCard({ suiteId }: { suiteId: string }) {
  const enabled = useFailureGroupsEnabled();
  const groups = useSuiteFailureGroups({ suiteId, enabled });
  const [open, setOpen] = useState(false);

  const row = groups.latest;
  // Only a completed row has results. A queued or running row is still
  // being grouped and a failed one never was; neither carries members a
  // diagram could be drawn from, and rendering them as though they did
  // would show an empty flow under a header that promised counts.
  const completed = row && row.status === "completed" ? row : null;
  const grouping = row?.status === "queued" || row?.status === "running";
  const groupingFailed = row?.status === "failed";
  const header = failureGroupsHeader(completed);
  const busy = failureGroupsBusy(row, groups.inFlight, groups.requesting);
  const sankey = useMemo(
    () => (completed?.grouped ? buildFailureSankey(completed) : null),
    [completed],
  );
  const flat = useMemo(
    () => (completed && !completed.grouped ? flatReasonList(completed) : []),
    [completed],
  );

  if (!enabled) return null;

  return (
    <section
      className="border-t border-border/40"
      data-testid="failure-groups-card"
    >
      <div className="flex items-center gap-2 px-5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left hover:bg-muted/40"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 text-[13px] text-foreground">
            {header.summary}
            {header.noveltyLabel ? (
              <>
                {" · "}
                <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {header.noveltyLabel}
                </span>
              </>
            ) : null}
          </span>
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-[12px]"
          disabled={busy}
          onClick={() => {
            void groups.request();
          }}
        >
          {busy ? "Grouping…" : "Group failures"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 px-5 pb-4">
          {groups.error ? (
            <p className="text-[12.5px] text-destructive">{groups.error}</p>
          ) : null}
          {groups.loading && !row ? (
            <p className="text-[12.5px] text-muted-foreground">
              Loading failure groups…
            </p>
          ) : null}
          {grouping ? (
            <p
              className="text-[12.5px] text-muted-foreground"
              data-testid="failure-groups-grouping"
            >
              grouping…
            </p>
          ) : null}
          {groupingFailed ? (
            <p
              className="text-[12.5px] text-destructive"
              data-testid="failure-groups-failed"
            >
              grouping failed{row?.errorCode ? ` (${row.errorCode})` : ""}
            </p>
          ) : null}
          {completed && !completed.grouped ? (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] text-muted-foreground">
                reasons did not separate into groups — showing the list
              </p>
              <ul className="flex flex-col gap-1">
                {flat.map((item) => (
                  <li
                    key={item.label}
                    className="flex items-baseline justify-between gap-3 text-[12.5px]"
                  >
                    <span className="text-foreground">{item.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {item.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {sankey && sankey.nodes.length > 0 ? (
            <FlowSankeyDiagram
              sankey={sankey}
              stages={FAILURE_SANKEY_STAGES}
              stageTitles={FAILURE_STAGE_TITLES}
              stageColors={FAILURE_STAGE_COLORS}
              unitNoun="trials"
              ariaLabel="Failed trials from case through route to reason"
              labelForNode={(node) =>
                node.key === SANKEY_UNLABELED
                  ? UNJUDGED_REASON_LABEL
                  : node.label
              }
            />
          ) : null}
          {!row && !groups.loading && !groups.error ? (
            <p className="text-[12.5px] text-muted-foreground">
              Group judged failures on this suite over the last 30 days.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
