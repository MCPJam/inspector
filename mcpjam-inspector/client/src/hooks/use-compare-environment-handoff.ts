import { useCallback, useMemo } from "react";
import {
  createPane,
  panesForHostIds,
  type ComparePane,
} from "@/lib/compare-panes";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import type { ComparePaneTargetOption } from "@/components/ui-playground/compare-pane-target-select";

/** An environment pane as the client chip shows it. */
export interface ComparePaneChip {
  paneId: string;
  label: string;
}

/**
 * The client chip's lineup changes, carrying the page's environment into
 * Compare and back:
 * - Comparing from an environment's chat runs that environment in pane 0, in
 *   place of its client, and the page stops running it.
 * - A lineup left with one environment pane becomes that environment's chat.
 * - A lineup left with one client, or picking one client, leaves the page's
 *   environment too.
 */
export function useCompareEnvironmentHandoff({
  panes,
  restorePanes,
  setSelectedHostIds,
  pageEnvironmentId,
  selectEnvironment,
  clearEnvironment,
  environmentTargets,
}: {
  panes: readonly RecoveryPane[];
  restorePanes: (panes: readonly RecoveryPane[]) => void;
  setSelectedHostIds: (hostIds: string[]) => void;
  /** The environment the page selected, even while Compare rests it. */
  pageEnvironmentId: string | null;
  selectEnvironment: (environmentId: string) => void;
  clearEnvironment: () => void;
  /** The environments a pane may run, with their names. */
  environmentTargets: readonly ComparePaneTargetOption[];
}) {
  const comparing = panes.length > 1;

  /** Leaves Compare when `next` holds one pane; otherwise sets the lineup. */
  const settle = useCallback(
    (next: readonly ComparePane[]) => {
      const [only] = next;
      if (next.length === 1 && only.target.kind === "environment") {
        selectEnvironment(only.target.environmentId);
        restorePanes([]);
        return;
      }
      if (next.length < 2 && pageEnvironmentId) clearEnvironment();
      restorePanes(next);
    },
    [clearEnvironment, pageEnvironmentId, restorePanes, selectEnvironment],
  );

  const onSelectedHostIdsChange = useCallback(
    (hostIds: string[]) => {
      const next = panesForHostIds(panes, hostIds);
      if (!comparing && pageEnvironmentId && next.length > 1) {
        const rest = next.slice(1);
        clearEnvironment();
        restorePanes([
          createPane(
            { kind: "environment", environmentId: pageEnvironmentId },
            rest,
          ),
          ...rest,
        ]);
        return;
      }
      if (comparing && next.length < 2) {
        settle(next);
        return;
      }
      setSelectedHostIds(hostIds);
    },
    [
      clearEnvironment,
      comparing,
      pageEnvironmentId,
      panes,
      restorePanes,
      setSelectedHostIds,
      settle,
    ],
  );

  const onPickSingleClient = useCallback(
    (hostId: string) => {
      if (pageEnvironmentId) clearEnvironment();
      restorePanes([createPane({ kind: "host", hostId }, [])]);
    },
    [clearEnvironment, pageEnvironmentId, restorePanes],
  );

  const onRemovePane = useCallback(
    (paneId: string) => settle(panes.filter((pane) => pane.paneId !== paneId)),
    [panes, settle],
  );

  const environmentPanes = useMemo<ComparePaneChip[]>(
    () =>
      comparing
        ? panes.flatMap(({ paneId, target }) =>
            target.kind === "environment"
              ? [
                  {
                    paneId,
                    label:
                      environmentTargets.find(
                        (option) =>
                          option.target.kind === "environment" &&
                          option.target.environmentId === target.environmentId,
                      )?.label ?? "Saved setup",
                  },
                ]
              : [],
          )
        : [],
    [comparing, environmentTargets, panes],
  );

  return {
    onSelectedHostIdsChange,
    onPickSingleClient,
    onRemovePane,
    environmentPanes,
    /** Pane 0 runs an environment, so no client chip leads. */
    environmentLeads: comparing && panes[0]?.target.kind === "environment",
  };
}
