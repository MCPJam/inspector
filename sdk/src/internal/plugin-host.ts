/**
 * `@mcpjam/sdk/internal/plugin-host` — FIRST-PARTY, NOT PUBLIC API.
 *
 * @experimental The OpenAI plugin extension host's capability registry and
 * instance session reducer, shared by the MCPJam Inspector server. Not
 * semver-guaranteed: names and shapes change with the plugin extensions
 * spec. External SDK consumers should not import this subpath.
 *
 * Exposes only what first-party code consumes: capability advertisement and
 * admission (`capabilities`) and the instance session reducer (`session`).
 * The checkpoint/replay and runner helpers stay internal to the SDK.
 */
export * from "../plugin-host/capabilities.js";
export * from "../plugin-host/session.js";
export type { PluginInstanceIdentity } from "../plugin-host/instance-key.js";
export { pluginInstanceKey } from "../plugin-host/instance-key.js";
