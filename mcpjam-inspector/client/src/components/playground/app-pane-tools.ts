import type {
  AppToolCatalog,
  AppToolCatalogEntry,
  AppToolDropReason,
} from "@mcpjam/widget-react";

export interface AppPaneTool extends AppToolCatalogEntry {
  key: string;
  toolSource: AppToolCatalogEntry["instance"]["toolSource"];
  availability: "offered" | AppToolDropReason;
}
export interface AppPaneGroup {
  key: string;
  appName: string;
  serverId: string;
  tools: AppPaneTool[];
}
export function deriveAppPaneTools(catalog: AppToolCatalog): AppPaneGroup[] {
  const groups = new Map<string, AppPaneGroup>();
  const entries: AppPaneTool[] = [
    ...catalog.offered.map((entry) => ({
      ...entry,
      key: "",
      toolSource: entry.instance.toolSource,
      availability: "offered" as const,
    })),
    ...catalog.dropped.map((entry) => ({
      ...entry,
      key: "",
      toolSource: entry.instance.toolSource,
      availability: entry.reason,
    })),
  ];
  for (const entry of entries) {
    const { instance } = entry;
    if (!instance.tools.length) continue;
    const groupKey = `${instance.chatSessionId}\0${instance.parentToolCallId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        appName: instance.appName,
        serverId: instance.serverId,
        tools: [],
      };
      groups.set(groupKey, group);
    }
    if (group.tools.some((tool) => tool.rawName === entry.rawName)) continue;
    group.tools.push({ ...entry, key: `app:${groupKey}\0${entry.rawName}` });
  }
  return [...groups.values()];
}
