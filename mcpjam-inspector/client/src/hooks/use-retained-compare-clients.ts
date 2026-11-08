import { useLayoutEffect, useRef } from "react";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import type { HostSlot } from "./use-playground-host-slots";
import type {
  PlaygroundClientColumn,
  PlaygroundClientResolution,
} from "@/lib/playground-client-columns";

type Ready = {
  status: "ready";
  column: PlaygroundClientColumn;
  ownerKey: string;
  pausedReason?: string;
};
type Entry = {
  column: PlaygroundClientColumn;
  config: string;
  version: number;
};
function configKey(
  config: PlaygroundClientColumn["hostConfig"],
): string | null {
  try {
    return stableStringifyJson(config);
  } catch {
    // An invalid saved configuration must lose its old owner, not crash the grid.
    return null;
  }
}

/** Keep presentation owners through query gaps. Every new operation remains gated. */
export function useRetainedCompareClients(input: {
  scope: string | null;
  resolutions: PlaygroundClientResolution[];
  slots: readonly HostSlot[];
  paused: boolean;
  running: ReadonlySet<string>;
  canConfirmMissing: boolean;
}): Array<Ready | Exclude<PlaygroundClientResolution, { status: "ready" }>> {
  const committed = useRef<{
    scope: string | null;
    entries: Map<string, Entry>;
  }>({ scope: null, entries: new Map() });
  const prior =
    input.scope && committed.current.scope === input.scope
      ? committed.current.entries
      : new Map<string, Entry>();
  const next = new Map<string, Entry>();
  const results = input.resolutions.map((resolution, index) => {
    const { compareId: id, hostId } =
      resolution.status === "ready" ? resolution.column : resolution;
    // A pane that now runs another client never keeps the old client's owner.
    const entryKey = JSON.stringify([id, hostId]);
    const old = prior.get(entryKey);
    const host = input.slots[index]?.host;
    const config =
      resolution.status === "invalid"
        ? null
        : host
          ? configKey(host.config)
          : undefined;
    let entry: Entry;
    let pausedReason: string | undefined;
    if (resolution.status === "ready") {
      const key = configKey(resolution.column.hostConfig);
      if (key === null)
        return {
          status: "invalid" as const,
          compareId: id,
          hostId,
          compareLabel: resolution.column.compareLabel,
          reason:
            "The saved client configuration is invalid. Edit this client in Connect.",
        };
      entry = {
        column: resolution.column,
        config: key,
        version: old ? old.version + Number(old.config !== key) : 0,
      };
      if (input.paused)
        pausedReason = "Checking this client's access. New actions are paused.";
    } else if (
      old &&
      resolution.status !== "invalid" &&
      (resolution.status === "loading" ||
        input.paused ||
        input.running.has(id)) &&
      (config === undefined || config === old.config) &&
      !(
        host === null &&
        !input.slots[index]?.isLoading &&
        input.canConfirmMissing
      )
    ) {
      entry = old;
      pausedReason = resolution.reason;
    } else {
      return resolution;
    }
    if (input.scope) next.set(entryKey, entry);
    return {
      status: "ready" as const,
      column: entry.column,
      ownerKey: JSON.stringify([input.scope, id, hostId, entry.version]),
      ...(pausedReason ? { pausedReason } : {}),
    };
  });
  useLayoutEffect(() => {
    committed.current = { scope: input.scope, entries: next };
  });
  return results;
}
