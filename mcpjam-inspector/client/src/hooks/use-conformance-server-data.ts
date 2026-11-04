/** Project/server scoped defaults, loaded only for servers the operator opens. */
import { useCallback, useMemo, useState } from "react";
import { useConvex, useMutation, useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  runnableSelection,
  type ConformanceSelection,
} from "@/hooks/use-conformance-run";
import {
  PROBE_KEYS,
  type ConformanceProbe,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { isRecord } from "@/lib/host-capabilities";
import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";

export type ConformanceDefaults = {
  selection: ConformanceSelection;
  inputs: ConformanceProbes;
};
type StoredProbe = Omit<ConformanceProbe, "arguments" | "inputResponses"> & {
  arguments?: string;
  inputResponses?: string;
};
type StoredProbes = Partial<Record<keyof ConformanceProbes, StoredProbe>>;

// JSON strings preserve tool-defined keys that Convex object fields cannot hold.
function encodeInputs(inputs: ConformanceProbes): StoredProbes {
  const stored: StoredProbes = {};
  for (const key of PROBE_KEYS) {
    const probe = inputs[key];
    if (!probe) continue;
    const { arguments: args, inputResponses, ...fields } = probe;
    stored[key] = {
      ...fields,
      ...(args !== undefined ? { arguments: JSON.stringify(args) } : {}),
      ...(inputResponses !== undefined
        ? { inputResponses: JSON.stringify(inputResponses) }
        : {}),
    };
  }
  return stored;
}
function decodeInputs(stored: StoredProbes = {}): ConformanceProbes | Error {
  const inputs: ConformanceProbes = {};
  const parseObject = (text: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error("Expected a JSON object");
    return value;
  };
  try {
    for (const key of PROBE_KEYS) {
      const probe = stored[key];
      if (!probe) continue;
      const { arguments: args, inputResponses, ...fields } = probe;
      inputs[key] = {
        ...fields,
        ...(args !== undefined ? { arguments: parseObject(args) } : {}),
        ...(inputResponses !== undefined
          ? { inputResponses: parseObject(inputResponses) }
          : {}),
      };
    }
    return inputs;
  } catch {
    // Report a failed read without exposing input contents or using partial inputs.
    return new Error("Could not load your saved inputs. Try again.");
  }
}
type ServerSettingsRow = {
  serverId: string;
  defaultChecks: ConformanceSelection;
  defaultAdvice?: Pick<
    ConformanceSelection,
    "protocolAdvice" | "tasksAdvice" | "oauthAdvice"
  >;
  defaultInputs?: StoredProbes;
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
  for (const [key, args] of requested) {
    if (args.projectId !== projectId) continue;
    const result = results[key];
    let row =
      result === undefined || result instanceof Error
        ? snapshots.get(key)
        : result;
    const name = serversById.get(args.serverId);
    if (!name || row === undefined) continue;
    let decoded = decodeInputs(row?.defaultInputs);
    if (decoded instanceof Error) {
      // Keep confirmed inputs visible; a new read must succeed before Run.
      row = snapshots.get(key);
      if (row === undefined) continue;
      decoded = decodeInputs(row?.defaultInputs);
      if (decoded instanceof Error) continue;
    }
    defaults.set(
      name,
      runnableSelection(
        { ...row?.defaultChecks, ...row?.defaultAdvice },
        "auto",
      ) ?? {},
    );
    inputs.set(name, decoded);
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
      const inputs = decodeInputs(row?.defaultInputs);
      if (inputs instanceof Error) throw inputs;
      setSnapshots((prev) => new Map(prev).set(key, row));
      return {
        selection:
          runnableSelection(
            { ...row?.defaultChecks, ...row?.defaultAdvice },
            "auto",
          ) ?? {},
        inputs,
      };
    },
    [client, projectId, serversByName, serversLoading],
  );
  const saveDefaults = useCallback(
    async (
      serverName: string,
      selection: ConformanceSelection,
      inputs?: ConformanceProbes,
    ) => {
      const serverId = serversByName.get(serverName);
      if (!projectId || !serverId)
        throw new Error(`No saved server named "${serverName}" to save to.`);
      await saveSettings({
        projectId,
        serverId,
        defaultChecks: definedOnly(selection, false),
        defaultAdvice: definedOnly(selection, true),
        ...(inputs !== undefined
          ? { defaultInputs: encodeInputs(inputs) }
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
    inputsByServer: Object.fromEntries(inputs),
    loadDefaults,
    lastRunByServer,
    saveDefaults: projectId ? saveDefaults : undefined,
  };
}
