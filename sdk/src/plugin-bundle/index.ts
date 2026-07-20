/**
 * `@mcpjam/sdk/plugin-bundle` — shared OpenAI plugin bundle contract.
 *
 * Pure, browser- and Node-safe parser for OpenAI plugin bundles (PR SDK-1 of
 * docs/plans/openai-plugin-import-cross-repo.md). No filesystem access, no
 * archive libraries: consumers provide a `PluginFileSource` adapter over
 * their own extraction path and get identical normalization, validation, and
 * deterministic hashing on every runtime.
 */

export {
  parsePluginBundle,
  MCP_CONFIG_PATH,
  APP_CONFIG_SUFFIX,
  ASSETS_DIR,
} from "./parse.js";

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
  PluginIssueCollector,
  type PluginIssueCode,
  type PluginIssueSeverity,
  type PluginValidationIssue,
} from "./validation.js";

export {
  normalizePluginManifest,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_PATH,
  type NormalizedPluginManifest,
  type PluginManifestAuthor,
  type PluginManifestNormalization,
} from "./manifest.js";

export {
  containsRootPlaceholder,
  normalizePluginMcpConfig,
  PLUGIN_ROOT_PLACEHOLDERS,
  type NormalizedPluginMcpServer,
  type NormalizedPluginOAuthHint,
  type ParsedPluginServer,
  type PluginEnvRequirement,
  type PluginHeaderRequirement,
} from "./mcp-config.js";

export {
  isValidPluginSkillName,
  parsePluginSkill,
  parseYamlLite,
  splitFrontmatter,
  SKILL_FILE_NAME,
  SKILL_OPENAI_METADATA_PATH,
  SKILLS_DIR,
  type ParsedPluginSkill,
  type ParsedPluginSkillFile,
  type ParsedPluginSkillOpenAiMetadata,
  type ParsePluginSkillArgs,
  type PluginSkillFileInput,
  type SplitFrontmatterResult,
  type YamlLiteResult,
} from "./skill.js";

export {
  parsePluginAppConfig,
  type ParsedPluginApp,
  type PluginAppBinding,
} from "./app-config.js";

export {
  caseFoldPath,
  isPathInside,
  normalizeBundlePath,
  resolveContainedPath,
  utf8ByteLength,
  validateBundleEntries,
  type NormalizedBundleEntry,
  type PathNormalizationResult,
} from "./paths.js";

export {
  computeAggregateHash,
  hashCanonicalJson,
  sha256Hex,
  sha256HexBytes,
  type HashedFileRef,
} from "./hashes.js";
