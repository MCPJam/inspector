import type {
  AppInstance,
  AppToolAlias,
  AppToolsRegistryState,
} from "./app-tools-registry";

export const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_INPUT_SCHEMA_BYTES = 8 * 1024;

export type AppToolDropReason =
  "entry_cap" | "schema_too_large" | "schema_unserializable";
export interface AppToolCatalogEntry extends AppToolAlias {
  instance: AppInstance;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface AppToolCatalog {
  offered: AppToolCatalogEntry[];
  dropped: (AppToolCatalogEntry & { reason: AppToolDropReason })[];
}
export type AppToolCatalogState = Pick<
  AppToolsRegistryState,
  "aliases" | "instancesByBridgeId" | "activeBridgeByParent" | "enabled"
>;

/** Alias order is the wire order, including when an app re-registers. */
export function listAppToolCatalog(
  state: AppToolCatalogState,
  chatSessionId?: string | null,
): AppToolCatalog {
  const offered: AppToolCatalogEntry[] = [];
  const dropped: AppToolCatalog["dropped"] = [];
  if (!state.enabled || !chatSessionId) return { offered, dropped };
  for (const [alias, reference] of state.aliases) {
    if (!/^app_[a-z0-9]{8}$/i.test(alias)) continue;
    const instance = state.instancesByBridgeId.get(reference.bridgeId);
    if (!instance || instance.chatSessionId !== chatSessionId) continue;
    if (
      state.activeBridgeByParent.get(
        `${chatSessionId}\0${instance.parentToolCallId}`,
      ) !== instance.bridgeId
    )
      continue;
    const tool = instance.tools.find((tool) => tool.name === reference.rawName);
    if (!tool) continue;
    const entry: AppToolCatalogEntry = {
      ...reference,
      alias,
      instance,
      description: tool.description
        ? tool.description.slice(0, MAX_DESCRIPTION_CHARS)
        : undefined,
      inputSchema: tool.inputSchema,
    };
    let reason: AppToolDropReason | undefined;
    if (offered.length >= MAX_SNAPSHOT_ENTRIES) reason = "entry_cap";
    else if (tool.inputSchema) {
      try {
        if (
          new TextEncoder().encode(JSON.stringify(tool.inputSchema)).length >
          MAX_INPUT_SCHEMA_BYTES
        )
          reason = "schema_too_large";
      } catch {
        reason = "schema_unserializable";
      }
    }
    if (reason) dropped.push({ ...entry, reason });
    else offered.push(entry);
  }
  // Only offered entries participate in model-facing disambiguation.
  const counts = new Map<string, number>();
  const indices = new Map<string, number>();
  for (const entry of offered) {
    const key = `${entry.instance.appName}\0${entry.rawName}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const entry of offered) {
    const key = `${entry.instance.appName}\0${entry.rawName}`;
    const total = counts.get(key) ?? 1;
    if (total <= 1) continue;
    const index = (indices.get(key) ?? 0) + 1;
    indices.set(key, index);
    const hint = ` (from tool call ${entry.instance.parentToolCallId}; instance ${index} of ${total})`;
    entry.description = ((entry.description ?? "") + hint).slice(
      0,
      MAX_DESCRIPTION_CHARS,
    );
  }
  return { offered, dropped };
}
