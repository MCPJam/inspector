/**
 * `@mcpjam/sdk/plugin-bundle` — shared Agent Plugins 1.0 bundle contract
 * (agent-plugins.org).
 *
 * Pure, browser- and Node-safe parser for Agent Plugins bundles. No
 * filesystem access, no archive libraries: consumers provide a
 * `PluginFileSource` adapter over their own extraction path and get
 * identical normalization, validation, and deterministic hashing on every
 * runtime.
 *
 * The public surface is deliberately lean: `parsePluginBundle`, the DTO
 * types, the issue contract, the constants adapters need, and the two pure
 * MCP-config shape primitives (`selectPluginMcpServerMap`,
 * `detectPluginMcpTransport`) that let a consumer with a different POLICY —
 * the inspector's MCP-JSON import, which must keep plain-HTTP URLs,
 * wrapper/spelling variants, and free-form server names working — share this
 * module's shape and transport handling without inheriting the plugin path's
 * spec-strict rules. Internal helpers (path normalization, hashing
 * primitives, the YAML subset, the per-component normalizers) stay
 * module-private to this entry; tests import them via direct file paths.
 */

export { parsePluginBundle, MCP_CONFIG_PATH } from "./parse.js";

export {
  DEFAULT_PLUGIN_BUNDLE_LIMITS,
  type ParsedPluginAsset,
  type ParsedPluginBundle,
  type ParsePluginBundleOptions,
  type PluginAssetKind,
  type PluginBundleLimits,
  type PluginFileEntry,
  type PluginFileSource,
  type PluginSetupRequirement,
} from "./types.js";

export {
  PLUGIN_ISSUE_CODES,
  PluginBundleError,
  type PluginIssueCode,
  type PluginIssueSeverity,
  type PluginValidationIssue,
} from "./validation.js";

export {
  MCPJAM_EXTENSION_NAMESPACE,
  PLUGIN_MANIFEST_PATH,
  PLUGIN_MANIFEST_SCHEMAS,
  type NormalizedPluginManifest,
  type PluginManifestAuthor,
} from "./manifest.js";

export {
  containsPluginPlaceholder,
  containsRootPlaceholder,
  detectPluginMcpTransport,
  selectPluginMcpServerMap,
  PLUGIN_DATA_PLACEHOLDER,
  PLUGIN_MCP_SCHEMAS,
  PLUGIN_PLACEHOLDERS,
  PLUGIN_ROOT_PLACEHOLDER,
  PLUGIN_ROOT_PLACEHOLDERS,
  type NormalizedPluginMcpServer,
  type NormalizedPluginOAuthHint,
  type ParsedPluginServer,
  type PluginEnvRequirement,
  type PluginHeaderRequirement,
  type PluginMcpServerEntry,
  type PluginMcpServerMapSelection,
  type PluginMcpTransportDetection,
  type PluginMcpWrapperKey,
  type PluginSkippedComponent,
} from "./mcp-config.js";

export {
  type ParsedPluginSkill,
  type ParsedPluginSkillFile,
} from "./skill.js";

export { type ParsedPluginApp, type PluginAppBinding } from "./app-config.js";
