/**
 * `@mcpjam/sdk/host-config` — public host configuration API.
 *
 * Build a host with the `Host` class:
 *
 * ```ts
 * import { Host } from "@mcpjam/sdk/host-config"; // or from "@mcpjam/sdk"
 * const host = new Host({ style: "mcpjam", model: "anthropic/claude-sonnet-4-6" })
 *   .requireServer("srv_abc");
 * host.mcp.protocolVersion = "2025-11-25";
 * const json = host.toJSON();
 * ```
 *
 * The internal canonicalizer/hash (and the storage-row vocabulary they use)
 * are deliberately not exported — `Host.toJSON()` is the public seam.
 * Content-addressed storage is a first-party SDK↔backend concern handled via
 * `@mcpjam/sdk/host-config/internal`; see `./types.ts`.
 */

export { cancellationLeafForVersion } from "./types.js";
export {
  Host,
  isHostJson,
  snapshotHostSource,
  assertHostServersKnown,
  resolveKnownServerIds,
} from "./host.js";
export type { HostServerRegistry, HostSource } from "./host.js";
export { HostRuntime } from "./host-runtime.js";
export type {
  HostRuntimeDefaults,
  HostRuntimeManager,
} from "./host-runtime.js";
export type {
  HostInit,
  HostJson,
  HostMcp,
  HostComputer,
  HostServerOverride,
  HostSkillSelection,
  HostConnectionDefaults,
  HostStyleId,
  Harness,
  McpProtocolVersion,
  McpToolResultImageRendering,
  McpToolResultImageRenderingPolicy,
  McpToolResultImageRenderPlacement,
  ModelVisibleMcpToolResults,
  ServerId,
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
  ToolParamHeaderMirroring,
  PaginationTraversalMode,
  MrtrSupport,
} from "./public-types.js";

// Tasks PRODUCT policy (`com.mcpjam/tasks`). Kept apart from the wire
// extension on purpose: nothing here produces a capability value, and
// `com.mcpjam/tasks` is never advertised to a server. The wire declaration is
// always `io.modelcontextprotocol/tasks: {}`, and it lives in `tasks-ext.ts`.
export {
  MCPJAM_TASKS_POLICY_EXTENSION_ID,
  readTasksPolicy,
  describeInvalidTasksPolicy,
  setTasksPolicy,
  clearTasksPolicy,
  taskModeForSurface,
  surfaceMayDeclareTasks,
} from "./tasks-policy.js";
export type {
  TasksPolicy,
  TaskMode,
  TaskSurface,
} from "./tasks-policy.js";
