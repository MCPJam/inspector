/**
 * The run header's "where it ran" line: the server group each launch target
 * used and the servers it connected to, drawn like the group picker so it
 * reads as what the user picked.
 *
 * Owns its data reads so the page passes only its targets. The run records
 * come from the same per-run subscriptions the page already holds, and the
 * group list from the one the suite view already holds.
 */
import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { Server } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { CHIP, fitChips } from "@mcpjam/design-system/server-chips";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useRunsIterations } from "../evals/use-runs-iterations";
import { runHostLabel } from "../evals/helpers";
import type { EvalSuiteRunListItem } from "../evals/types";
import { runServerScope, type RunServerScopeEntry } from "./run-server-scope";

/**
 * Chip room per entry, in pixels, against `chipWidth`'s estimate. A launch
 * with several entries shares the line, so each gets less. A narrow window
 * may still wrap the line; that is accepted.
 */
const CHIP_ROOM_PX = 320;
const MIXED_CHIP_ROOM_PX = 200;

export function RunServerGroups({
  targets,
  hostNamesById,
}: {
  targets: readonly EvalSuiteRunListItem[];
  hostNamesById: Map<string, string | null>;
}) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const showGroups = useProjectEnvironmentsEnabled();
  const {
    runsById,
    isLoading: runsLoading,
    failedRunIds,
  } = useRunsIterations(targets.map((run) => run._id));
  const projectId = targets[0]?.projectId ?? null;
  const { serverAttachments, isLoading: groupsLoading } =
    useProjectServerAttachments({ isAuthenticated, authLoading, projectId });

  const groupNamesById = useMemo(
    () =>
      groupsLoading
        ? undefined
        : new Map(serverAttachments.map((group) => [group._id, group.name])),
    [groupsLoading, serverAttachments],
  );
  // Every target or nothing: a missing one would pass the rest off as the
  // whole launch, whether it is still loading or its read failed.
  if (runsLoading || failedRunIds.size > 0) return null;
  const runs = targets.flatMap((run) => {
    const full = runsById.get(run._id);
    return full ? [full] : [];
  });
  const entries = runServerScope(runs, groupNamesById, {
    showGroups,
    clientLabel: (run) => runHostLabel(run, hostNamesById),
  });
  if (entries.every((entry) => !entry.group && entry.servers.length === 0)) {
    return null;
  }

  const label = entries.some(
    (entry) => entry.group && !("pending" in entry.group),
  )
    ? "Server group"
    : "Servers";
  const room = entries.length > 1 ? MIXED_CHIP_ROOM_PX : CHIP_ROOM_PX;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]"
      data-testid="evaluate-run-server-groups"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={label}
            className="-mr-2.5 inline-flex text-muted-foreground"
          >
            <Server className="size-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {entries.map((entry, index) => (
        <ScopeEntry key={entry.group?.id ?? index} entry={entry} room={room} />
      ))}
    </div>
  );
}

function ScopeEntry({
  entry,
  room,
}: {
  entry: RunServerScopeEntry;
  room: number;
}) {
  const { group } = entry;
  const { shown, hidden } = fitChips(entry.servers, room);
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      data-testid="evaluate-run-server-group"
    >
      {group && "name" in group ? (
        <span className="font-medium text-foreground">{group.name}</span>
      ) : group && "deleted" in group ? (
        <span className="italic text-muted-foreground">Deleted group</span>
      ) : null}
      <span className="inline-flex flex-wrap items-center gap-1">
        {shown.map((name, i) => (
          <Badge key={`${name}-${i}`} className={CHIP}>
            {name}
          </Badge>
        ))}
        {hidden.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                tabIndex={0}
                aria-label={`${hidden.length} more: ${hidden.join(", ")}`}
                className={CHIP}
              >
                {`+${hidden.length}`}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{hidden.join(", ")}</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
      {entry.clients.length > 0 ? (
        <span className="text-muted-foreground">
          on {entry.clients.join(", ")}
        </span>
      ) : null}
    </span>
  );
}
