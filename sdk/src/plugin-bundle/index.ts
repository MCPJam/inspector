/**
 * `@mcpjam/sdk/plugin-bundle` — shared OpenAI plugin bundle contract.
 *
 * Pure, browser- and Node-safe parser for OpenAI plugin bundles (PR SDK-1 of
 * docs/plans/openai-plugin-import-cross-repo.md). No filesystem access, no
 * archive libraries: consumers provide a `PluginFileSource` adapter over
 * their own extraction path and get identical normalization, validation, and
 * deterministic hashing on every runtime.
 *
 * The public surface is deliberately lean: `parsePluginBundle`, the DTO
 * types, the issue contract, and the constants adapters need. Internal
 * helpers (path normalization, hashing primitives, the YAML subset, the
 * per-component normalizers) stay module-private to this entry; tests import
 * them via direct file paths.
 */

export { parsePluginBundle, MCP_CONFIG_PATH } from "./parse.js";

export {
  DEFAULT_PLUGIN_BUNDLE_LIMITS,
  type ParsedPluginAsset,
  type ParsedPluginBundle,
  type ParsedUnsupportedComponent,
  type ParsePluginBundleOptions,
  type PluginAssetKind,
  type PluginBundleLimits,
  type PluginFileEntry,
  type PluginFileSource,
  type PluginSetupRequirement,
  type PluginUnsupportedComponentKind,
} from "./types.js";

export {
  PLUGIN_ISSUE_CODES,
  PluginBundleError,
  type PluginIssueCode,
  type PluginIssueSeverity,
  type PluginValidationIssue,
} from "./validation.js";

export {
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_PATH,
  type NormalizedPluginManifest,
  type PluginManifestAuthor,
} from "./manifest.js";

export {
  containsRootPlaceholder,
  PLUGIN_ROOT_PLACEHOLDERS,
  type NormalizedPluginMcpServer,
  type NormalizedPluginOAuthHint,
  type ParsedPluginServer,
  type PluginEnvRequirement,
  type PluginHeaderRequirement,
} from "./mcp-config.js";

export {
  type ParsedPluginSkill,
  type ParsedPluginSkillFile,
  type ParsedPluginSkillOpenAiMetadata,
} from "./skill.js";

export { type ParsedPluginApp, type PluginAppBinding } from "./app-config.js";
