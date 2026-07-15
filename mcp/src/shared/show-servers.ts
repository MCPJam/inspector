/**
 * Show-servers wire types now live in `@mcpjam/sdk/platform` so the MCP
 * worker, CLI, and SDK consumers share one contract. This module re-exports
 * them (types only — safe for the Vite-bundled widget) for existing
 * `../shared/show-servers.js` importers.
 */
export type {
  ProjectInfo,
  SelectedProjectInfo,
  ServerEntry,
  ServerInfo,
  ServerPrimitiveCollection,
  ServerPrimitiveListStatus,
  ServerPrimitives,
  ServerPromptArgumentInfo,
  ServerPromptInfo,
  ServerResourceInfo,
  ServerStatus,
  ServerToolInfo,
  ServerTransportType,
  ShowServersPayload,
  ShowServersSummary,
} from "@mcpjam/sdk/platform";
