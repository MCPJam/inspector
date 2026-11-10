/** Project/server scoped defaults, loaded only for servers the operator opens. */
import { useCallback, useMemo, useState } from "react";
import { useConvex, useMutation, useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ConformanceSelection } from "@/hooks/use-conformance-run";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import { useSoftQuery } from "@/hooks/use-soft-query";
import {
  decodeStoredProbes,
  encodeStoredProbes,
  storedSelection,
  type StoredConformanceProbes,
} from "@/shared/conformance-settings";
import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";

export type ConformanceDefaults = {
  selection: ConformanceSelection;
  inputs: ConformanceProbes;
};
type ServerSettingsRow = {
  serverId: string;
  defaultChecks: ConformanceSelection;
  runTimeoutSeconds?: number;
  defaultAdvice?: Pick<
    ConformanceSelection,
    "protocolAdvice" | "tasksAdvice" | "oauthAdvice"
  >;
  defaultInputs?: StoredConformanceProbes;
};
const settingsQuery = makeFunctionReference<
  "query",
  { projectId: string; serverId: string },
  ServerSettingsRow | null
>("conformanceSettings:getServerSettings");
const ADVICE_KEYS = new Set(["protocolAdvice", "tasksAdvice", "oauthAdvice"]);
function definedOnly(selection: ConformanceSelection, advice: boolean) {
  return Object.fromEntries(
    Object.entries(selection).filter(
      ([key, value]) => value !== undefined && ADVICE_KEYS.has(key) === advice,
    ),
  );
}
export function useConformanceServerData({
  projectId,
  serversById,
  serversByName,
  serversLoading = false,
}: {
  projectId: string | null;
  serversById: ReadonlyMap<string, string>;
  serversByName: ReadonlyMap<string, string>;
  serversLoading?: boolean;
}) {
  const client = useConvex();
  const [requested, setRequested] = useState<
    ReadonlyMap<string, { projectId: string; serverId: string }>
  >(() => new Map());
  const [snapshots, setSnapshots] = useState<
    ReadonlyMap<string, ServerSettingsRow | null>
  >(() => new Map());
  const queries = useMemo(
    () =>
      Object.fromEntries(
        [...requested]
          .filter(([, args]) => args.projectId === projectId)
          .map(([key, args]) => [key, { query: settingsQuery, args }]),
      ),
    [requested, projectId],
  );
  const results = useQueries(queries) as Record<
    string,
    ServerSettingsRow | null | Error | undefined
  >;
  const { data: latestRuns } = useSoftQuery<ConformanceRunListItem[]>(
    "conformanceRuns:latestRunPerServer",
    projectId ? { projectId } : "skip",
  );
  const saveSettings = useMutation(
    makeFunctionReference<"mutation">("conformanceSettings:setServerSettings"),
  );
  const defaults = new Map<string, ConformanceSelection>();
  const inputs = new Map<string, ConformanceProbes>();
  const timeouts = new Map<string, number>();
  for (const [key, args] of requested) {
    if (args.projectId !== projectId) continue;
    const result = results[key];
    let row =
      result === undefined || result instanceof Error
        ? snapshots.get(key)
        : result;
    const name = serversById.get(args.serverId);
    if (!name || row === undefined) continue;
    let decoded = decodeStoredProbes(row?.defaultInputs);
    if (decoded instanceof Error) {
      // Keep confirmed inputs visible; a new read must succeed before Run.
      row = snapshots.get(key);
      if (row === undefined) continue;
      decoded = decodeStoredProbes(row?.defaultInputs);
      if (decoded instanceof Error) continue;
    }
    defaults.set(name, storedSelection(row));
    inputs.set(name, decoded);
    if (row?.runTimeoutSeconds !== undefined) timeouts.set(name, row.runTimeoutSeconds);
  }
  const loadDefaults = useCallback(
    async (serverName: string): Promise<ConformanceDefaults> => {
      if (projectId && serversLoading)
        throw new Error("The server list is still loading. Try again.");
      const serverId = serversByName.get(serverName);
      if (!projectId || !serverId) return { selection: {}, inputs: {} };
      const key = `${projectId}:${serverId}`;
      const args = { projectId, serverId };
      setRequested((prev) => new Map(prev).set(key, args));
      const row = await client.query(settingsQuery, args);
      const inputs = decodeStoredProbes(row?.defaultInputs);
      if (inputs instanceof Error) throw inputs;
      setSnapshots((prev) => new Map(prev).set(key, row));
      return {
        selection: storedSelection(row),
        inputs,
      };
    },
    [client, projectId, serversByName, serversLoading],
  );
  const saveTimeout = useCallback(async (serverName: string, seconds: number | null) => {
    const serverId = serversByName.get(serverName);
    if (!projectId || !serverId) throw new Error(`No saved server named "${serverName}" exists. Add the server first, then try again.`);
    await saveSettings({ projectId, serverId, runTimeoutSeconds: seconds });
  }, [projectId, saveSettings, serversByName]);
  const saveDefaults = useCallback(
    async (
      serverName: string,
      selection: ConformanceSelection,
      inputs?: ConformanceProbes,
    ) => {
      const serverId = serversByName.get(serverName);
      if (!projectId || !serverId)
        throw new Error(`No saved server named "${serverName}" exists. Add the server first, then try again.`);
      await saveSettings({
        projectId,
        serverId,
        defaultChecks: definedOnly(selection, false),
        defaultAdvice: definedOnly(selection, true),
        ...(inputs !== undefined
          ? { defaultInputs: encodeStoredProbes(inputs) }
          : {}),
      });
    },
    [projectId, serversByName, saveSettings],
  );
  const lastRunByServer = useMemo(
    () =>
      Object.fromEntries(
        (latestRuns ?? []).flatMap((run) => {
          const name = run.serverId ? serversById.get(run.serverId) : undefined;
          return name ? [[name, run]] : [];
        }),
      ),
    [latestRuns, serversById],
  );
  return {
    defaultsByServer: Object.fromEntries(defaults),
    timeoutsByServer: Object.fromEntries(timeouts),
    saveTimeout: projectId ? saveTimeout : undefined,
    inputsByServer: Object.fromEntries(inputs),
    loadDefaults,
    lastRunByServer,
    saveDefaults: projectId ? saveDefaults : undefined,
  };
}
