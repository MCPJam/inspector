/**
 * What the Conformance page knows per saved server, from Convex: each
 * server's default checks (its Conformance Settings) and its latest run, for
 * the page's server list. Keyed by server name, the way the page names them.
 */

import { useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  runnableSelection,
  type ConformanceSelection,
} from "@/hooks/use-conformance-run";
import { useSoftQuery } from "@/hooks/use-soft-query";
import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";

/** How many recent runs the server list reads its "last run" from. */
const RECENT_RUNS = 50;

type ServerSettingsRow = {
  serverId: string;
  defaultChecks: ConformanceSelection;
};

/** Convex drops `undefined` poorly: send only the keys that are set. */
function definedOnly(selection: ConformanceSelection): ConformanceSelection {
  return Object.fromEntries(
    Object.entries(selection).filter(([, value]) => value !== undefined),
  ) as ConformanceSelection;
}

export function useConformanceServerData({
  projectId,
  serversById,
  serversByName,
}: {
  projectId: string | null;
  /** Saved server id → name. */
  serversById: ReadonlyMap<string, string>;
  /** Server name → saved server id. */
  serversByName: ReadonlyMap<string, string>;
}) {
  // Soft reads: the page still runs checks without defaults or the server
  // list, so a failed read (or a backend without these functions yet) must
  // not take the page down.
  const { data: settingsRows, error: settingsError } = useSoftQuery<
    ServerSettingsRow[]
  >(
    "conformanceSettings:listServerSettings",
    projectId ? { projectId } : "skip",
  );
  const { data: recent } = useSoftQuery<{ page: ConformanceRunListItem[] }>(
    "conformanceRuns:listRuns",
    projectId
      ? {
          projectId,
          paginationOpts: { numItems: RECENT_RUNS, cursor: null },
        }
      : "skip",
  );
  const saveSettings = useMutation(
    makeFunctionReference<"mutation">("conformanceSettings:setServerSettings"),
  );

  const defaultsByServer = useMemo(() => {
    const byName: Record<string, ConformanceSelection> = {};
    for (const row of settingsRows ?? []) {
      const name = serversById.get(row.serverId);
      // Stored as plain strings: drop ids this build does not know.
      const defaults = runnableSelection(row.defaultChecks, "auto");
      if (name && defaults) byName[name] = defaults;
    }
    return byName;
  }, [settingsRows, serversById]);

  // Runs come newest first, so the first one seen per server is its latest.
  const lastRunByServer = useMemo(() => {
    const byName: Record<string, ConformanceRunListItem> = {};
    for (const run of recent?.page ?? []) {
      const name = run.serverId ? serversById.get(run.serverId) : undefined;
      if (name && !byName[name]) byName[name] = run;
    }
    return byName;
  }, [recent, serversById]);

  const saveDefaults = useCallback(
    async (serverName: string, selection: ConformanceSelection) => {
      const serverId = serversByName.get(serverName);
      // Throw, not return: the caller's toast must say the change was lost.
      if (!projectId || !serverId) {
        throw new Error(`No saved server named "${serverName}" to save to.`);
      }
      await saveSettings({
        projectId,
        serverId,
        defaultChecks: definedOnly(selection),
      });
    },
    [projectId, saveSettings, serversByName],
  );

  return {
    defaultsByServer,
    /** False until the saved defaults are read, or known to be unreadable. */
    defaultsLoaded:
      !projectId || settingsRows !== undefined || settingsError !== undefined,
    lastRunByServer,
    /** Unset when the page has no project to save to, or can't read the
     *  saved defaults back. */
    saveDefaults: projectId && !settingsError ? saveDefaults : undefined,
  };
}
