import { useMemo } from "react";
import type { ComparePaneTargetOption } from "@/components/ui-playground/compare-pane-target-select";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import type { HostListItem } from "@/hooks/useClients";
import {
  useEnvironmentPreview,
  type EnvironmentPreview,
} from "@/hooks/use-environment-preview";
import {
  useProjectEnvironments,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabledState } from "@/hooks/useProjectEnvironmentsEnabled";
import { clientDisplayName } from "@/lib/client-display-name";
import type { ComparePane } from "@/lib/compare-panes";
import type { EnvironmentErrorPayload } from "@/lib/environment-error";
import { environmentLabel } from "@/lib/environment-label";

/** What an environment pane knows about the environment it runs. */
export interface ComparePaneEnvironment {
  environmentId: string;
  /** Named environments are on for this member: undefined while that loads. */
  visible: boolean | undefined;
  preview: EnvironmentPreview | null;
  isLoading: boolean;
  error: EnvironmentErrorPayload | null;
}

/**
 * The named environments Compare's panes run: one preview per pane slot, three
 * fixed hooks, where an empty slot fetches nothing. The list of named
 * environments is read only while they are visible to a member (a hosted guest
 * never sees them), and feeds both each preview's revision (an edit elsewhere
 * refetches it) and the pane settings' target menu.
 */
export function useCompareEnvironmentPanes({
  projectId,
  panes,
  hosts,
}: {
  projectId: string | null;
  panes: readonly ComparePane[];
  /** The project's clients, which every pane may run. */
  hosts: readonly HostListItem[];
}): {
  environments: ProjectEnvironmentView[];
  byPane: ReadonlyMap<string, ComparePaneEnvironment>;
  /** What pane settings offer: clients, and environments while visible. */
  targets: {
    clients: ComparePaneTargetOption[];
    environments: ComparePaneTargetOption[];
  };
} {
  const flag = useProjectEnvironmentsEnabledState();
  const member = useIsMemberActor();
  // Off as soon as either answer is no; unknown while either still loads.
  const visible =
    flag === false || member === false
      ? false
      : flag === undefined || member === undefined
        ? undefined
        : true;
  const listed = useProjectEnvironments(visible ? projectId : null);
  const ids = [0, 1, 2].map((index) => {
    const target = panes[index]?.target;
    return visible && target?.kind === "environment"
      ? target.environmentId
      : null;
  });
  const revision = (environmentId: string | null) =>
    listed?.find((row) => row.environmentId === environmentId)?.revision ??
    null;
  const slot0 = useEnvironmentPreview(
    ids[0] ? projectId : null,
    ids[0],
    revision(ids[0]),
  );
  const slot1 = useEnvironmentPreview(
    ids[1] ? projectId : null,
    ids[1],
    revision(ids[1]),
  );
  const slot2 = useEnvironmentPreview(
    ids[2] ? projectId : null,
    ids[2],
    revision(ids[2]),
  );

  // Plain values per slot, so the memo below reruns only when one changes.
  const [p0, p1, p2] = [slot0, slot1, slot2].map((slot, index) =>
    ids[index] ? slot.preview : null,
  );
  const [l0, l1, l2] = [slot0, slot1, slot2].map(
    (slot, index) =>
      !!ids[index] && !slot.error && (slot.isLoading || !slot.preview),
  );
  const [e0, e1, e2] = [slot0, slot1, slot2].map((slot, index) =>
    ids[index] ? slot.error : null,
  );
  const byPane = useMemo(() => {
    const slots = [
      { preview: p0, isLoading: l0, error: e0 },
      { preview: p1, isLoading: l1, error: e1 },
      { preview: p2, isLoading: l2, error: e2 },
    ];
    const map = new Map<string, ComparePaneEnvironment>();
    panes.slice(0, 3).forEach((pane, index) => {
      if (pane.target.kind !== "environment") return;
      map.set(pane.paneId, {
        environmentId: pane.target.environmentId,
        visible,
        ...slots[index],
      });
    });
    return map;
  }, [panes, visible, p0, l0, e0, p1, l1, e1, p2, l2, e2]);

  const targets = useMemo(
    () => ({
      clients: hosts.map((host) => ({
        target: { kind: "host" as const, hostId: host.hostId },
        label: clientDisplayName(host),
      })),
      environments: (visible ? (listed ?? []) : []).map((row) => ({
        target: {
          kind: "environment" as const,
          environmentId: row.environmentId,
        },
        label: environmentLabel(row),
      })),
    }),
    [hosts, listed, visible],
  );

  return { environments: listed ?? [], byPane, targets };
}
