/**
 * The run header's "where it ran" line: the server group each launch target
 * used and the servers it connected to.
 *
 * Owns its data reads so the page passes only its targets. The run records
 * come from the same per-run subscriptions the page already holds, and the
 * group list from the one the suite view already holds.
 */
import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useRunsIterations } from "../evals/use-runs-iterations";
import { runHostLabel } from "../evals/helpers";
import type { EvalSuiteRunListItem } from "../evals/types";
import { runServerScope } from "./run-server-scope";

export function RunServerGroups({
  targets,
  hostNamesById,
}: {
  targets: readonly EvalSuiteRunListItem[];
  hostNamesById: Map<string, string | null>;
}) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const showGroups = useProjectEnvironmentsEnabled();
  const { runsById } = useRunsIterations(targets.map((run) => run._id));
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

  return (
    <p
      className="text-[12.5px] text-muted-foreground"
      data-testid="evaluate-run-server-groups"
    >
      {entries
        .map((entry) => {
          const group = entry.group;
          const name = !group
            ? "Servers"
            : "name" in group
            ? group.name
            : "deleted" in group
            ? "Deleted group"
            : "…";
          const clients = entry.clients.length
            ? ` on ${entry.clients.join(", ")}`
            : "";
          return `${name}: ${entry.servers.join(", ")}${clients}`;
        })
        .join("   ")}
    </p>
  );
}
