import type { EnvironmentOverrides } from "@/shared/execution-target";
import type { ComparePane } from "./compare-panes";
import type { RecoveryPane } from "./comparison-recovery-record";

export type PaneOverrides = Pick<
  RecoveryPane,
  "serverIds" | "pluginVersionIds"
>;

/**
 * How an environment pane narrows its environment for a turn, or undefined
 * to follow it. `[]` is an explicit "none" and is sent, unlike null.
 */
export function paneEnvironmentOverrides({
  serverIds,
  pluginVersionIds,
}: PaneOverrides): EnvironmentOverrides | undefined {
  if (serverIds == null && pluginVersionIds == null) return undefined;
  return {
    ...(serverIds != null ? { serverIds } : {}),
    ...(pluginVersionIds != null ? { pluginVersionIds } : {}),
  };
}

/** A lineup write from another surface carries no overrides. Keep this tab's
 * overrides only while the same pane still targets the same setup. */
export function retainPaneOverrides(
  next: readonly ComparePane[],
  current: readonly RecoveryPane[],
): RecoveryPane[] {
  return next.map((pane) => {
    const prior = current.find((p) => p.paneId === pane.paneId);
    if (!prior) return pane;
    const a = prior.target;
    const b = pane.target;
    const sameTarget =
      a.kind === "host"
        ? b.kind === "host" && a.hostId === b.hostId
        : b.kind === "environment" && a.environmentId === b.environmentId;
    return sameTarget
      ? {
          ...pane,
          serverIds: prior.serverIds,
          pluginVersionIds: prior.pluginVersionIds,
        }
      : pane;
  });
}
