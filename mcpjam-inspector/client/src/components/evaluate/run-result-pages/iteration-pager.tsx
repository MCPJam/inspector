import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { DisabledReasonTooltip } from "@mcpjam/design-system/tooltip";
import type { IterationTab } from "@/lib/eval-route-types";
import type { PagerNeighbor, PagerPosition } from "./iteration-pager-model";
import {
  FROM_PAGER_STATE,
  followLink,
  openResult,
  resultHref,
  type RunRef,
} from "./result-page-links";

/** Previous and next within this test case on this model, keeping the open tab. */
export function IterationPager({
  run,
  position,
  tab,
}: {
  run: RunRef;
  position: PagerPosition;
  tab?: IterationTab;
}) {
  return (
    <div
      role="group"
      aria-label="Iterations of this test case"
      className="flex items-center gap-1"
    >
      <PagerArrow
        run={run}
        tab={tab}
        neighbor={position.prev}
        label="Previous iteration"
        tooltip="Previous"
        disabledReason="First iteration of this test case"
      >
        <ChevronLeft />
      </PagerArrow>
      <span className="min-w-12 text-center text-xs text-muted-foreground tabular-nums">
        {position.index + 1} of {position.total}
      </span>
      <PagerArrow
        run={run}
        tab={tab}
        neighbor={position.next}
        label="Next iteration"
        tooltip="Next"
        disabledReason="Last iteration of this test case"
      >
        <ChevronRight />
      </PagerArrow>
    </div>
  );
}

function PagerArrow({
  run,
  tab,
  neighbor,
  label,
  tooltip,
  disabledReason,
  children,
}: {
  run: RunRef;
  tab?: IterationTab;
  neighbor?: PagerNeighbor;
  label: string;
  tooltip: string;
  disabledReason: string;
  children: ReactNode;
}) {
  const page = neighbor && {
    caseKey: neighbor.caseKey,
    iterationId: neighbor.iterationId,
    ...(tab ? { tab } : {}),
  };
  return (
    <DisabledReasonTooltip
      reason={page ? undefined : disabledReason}
      fallback={neighbor ? `${tooltip}: ${neighbor.label}` : undefined}
    >
      {page ? (
        <Button asChild variant="ghost" size="icon" className="size-8">
          <a
            href={resultHref(run, page)}
            aria-label={label}
            onClick={(event) =>
              followLink(event, () =>
                openResult(run, page, { state: FROM_PAGER_STATE }),
              )
            }
          >
            {children}
          </a>
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={label}
          disabled
        >
          {children}
        </Button>
      )}
    </DisabledReasonTooltip>
  );
}
