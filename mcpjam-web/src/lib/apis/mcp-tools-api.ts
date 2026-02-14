import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

export type ListToolsResultWithMetadata = ListToolsResult & {
  toolsMetadata?: Record<string, Record<string, unknown>>;
};
