/**
 * Which file is the manifest, and which dialect reads it.
 *
 * `strict` is Agent Plugins 1.0 exactly: the manifest is the root
 * `plugin.json`. `openai-compatible` adds the layouts OpenAI documents for
 * Codex plugins, as an adapter in front of the same normalizer:
 *
 * - A root `plugin.json` stays authoritative; a legacy manifest never rescues
 *   an invalid root.
 * - Beside it, `.codex-plugin/plugin.json` supplies `extensions["com.openai"]`
 *   unless the root declares that namespace as an object, which replaces the
 *   overlay (OpenAI's rule: replace, never merge). An overlay cannot move
 *   portable components out of `skills/` and `mcp.json`.
 * - Without a root manifest, the first of `.codex-plugin/`, `.agent-plugin/`
 *   and `.claude-plugin/` is the manifest, read by the root rules.
 *
 * Legacy features MCPJam does not run (hooks, commands) are reported, never run.
 */

import {
  OPENAI_EXTENSION_NAMESPACE,
  PLUGIN_MANIFEST_PATH,
  PLUGIN_MANIFEST_SCHEMAS,
} from "./manifest.js";
import { resolveContainedPath } from "./paths.js";
import { PluginIssueCollector } from "./validation.js";
import type {
  PluginBundleInterpretation,
  PluginBundleLayout,
  PluginParserProfile,
} from "./types.js";

export const CODEX_MANIFEST_PATH = ".codex-plugin/plugin.json";
export const AGENT_LEGACY_MANIFEST_PATH = ".agent-plugin/plugin.json";
export const CLAUDE_MANIFEST_PATH = ".claude-plugin/plugin.json";

/** Legacy manifest locations, in the order a rootless bundle tries them. */
export const LEGACY_MANIFEST_LOCATIONS: ReadonlyArray<{
  path: string;
  layout: Exclude<PluginBundleLayout, "agent-plugins">;
}> = [
  { path: CODEX_MANIFEST_PATH, layout: "codex" },
  { path: AGENT_LEGACY_MANIFEST_PATH, layout: "agent-legacy" },
  { path: CLAUDE_MANIFEST_PATH, layout: "claude" },
];

export interface ResolvedManifestSource {
  interpretation: PluginBundleInterpretation;
  /** Portable-shaped input for `normalizePluginManifest`. */
  record: unknown;
}

export interface ResolveManifestSourceInput {
  profile: PluginParserProfile;
  filePaths: ReadonlySet<string>;
  /** Parse one bundle file as JSON, reporting failures on `issues`. */
  readJson(path: string, issues: PluginIssueCollector): unknown | null;
  issues: PluginIssueCollector;
}

/** Legacy fields read here; they never reach the portable normalizer. */
const LEGACY_FIELDS = new Set([
  "skills",
  "apps",
  "interface",
  "onboardingSkill",
  "extensions",
]);

const UNSUPPORTED_FEATURES: Record<string, string> = {
  hooks: "lifecycle hooks",
  commands: "slash commands",
  agents: "agents",
  outputStyles: "output styles",
  lspServers: "language servers",
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Does a declared location resolve to `fixed` (`./skills/` → `skills`)? */
function namesLocation(value: unknown, fixed: string): boolean {
  if (typeof value !== "string") return false;
  const resolved = resolveContainedPath("", value);
  return resolved.ok && resolved.path === fixed;
}

/**
 * A legacy manifest's OpenAI data in the shape `extensions["com.openai"]`
 * has in a portable manifest. Namespaced values win over their top-level
 * spellings; two different onboarding skills are refused, not guessed.
 */
function openAiDataFromLegacy(
  manifest: Record<string, unknown>,
  path: string,
  issues: PluginIssueCollector
): Record<string, unknown> {
  const extensions = manifest.extensions;
  const namespaced = isPlainRecord(extensions)
    ? extensions[OPENAI_EXTENSION_NAMESPACE]
    : undefined;
  const openai = isPlainRecord(namespaced) ? { ...namespaced } : {};
  for (const key of ["interface", "apps"] as const) {
    if (manifest[key] !== undefined && openai[key] === undefined) {
      openai[key] = manifest[key];
    }
  }
  const direct = manifest.onboardingSkill;
  if (direct !== undefined && openai.onboardingSkill === undefined) {
    openai.onboardingSkill = direct;
  } else if (direct !== undefined && openai.onboardingSkill !== direct) {
    issues.warn(
      "MANIFEST_INVALID_FIELD",
      `${path} declares two different onboarding skills; neither is used`,
      { path }
    );
    delete openai.onboardingSkill;
  }
  return openai;
}

/** `extensions` with the OpenAI namespace replaced by `openai`, or removed. */
function withOpenAiData(
  extensions: Record<string, unknown> | undefined,
  openai: Record<string, unknown>
): Record<string, unknown> {
  const { [OPENAI_EXTENSION_NAMESPACE]: _replaced, ...others } =
    extensions ?? {};
  return Object.keys(openai).length > 0
    ? { ...others, [OPENAI_EXTENSION_NAMESPACE]: openai }
    : others;
}

function reportUnsupportedFeatures(
  manifest: Record<string, unknown>,
  path: string,
  issues: PluginIssueCollector
): void {
  for (const [field, label] of Object.entries(UNSUPPORTED_FEATURES)) {
    if (manifest[field] === undefined) continue;
    issues.warn(
      "UNSUPPORTED_COMPONENT",
      `"${field}" in ${path} declares ${label}, which MCPJam does not run; ignored`,
      { path }
    );
  }
}

function adaptLegacyManifest(
  raw: Record<string, unknown>,
  interpretation: PluginBundleInterpretation,
  input: ResolveManifestSourceInput
): ResolvedManifestSource {
  const { issues } = input;
  const path = interpretation.manifestPath;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LEGACY_FIELDS.has(key) && !(key in UNSUPPORTED_FEATURES)) {
      record[key] = value;
    }
  }
  // Legacy manifests predate `$schema` or carry an editor schema; both read
  // as 1.0.0. An Agent Plugins identifier still selects or rejects its version.
  const schema = record.$schema;
  if (!String(schema).startsWith("https://agent-plugins.org/schemas/")) {
    record.$schema = PLUGIN_MANIFEST_SCHEMAS["1.0.0"];
  }
  const extensions = raw.extensions;
  if (extensions !== undefined && !isPlainRecord(extensions)) {
    record.extensions = extensions; // reported by the normalizer
  } else {
    const merged = withOpenAiData(
      extensions,
      openAiDataFromLegacy(raw, path, issues)
    );
    if (Object.keys(merged).length > 0) record.extensions = merged;
  }
  if (raw.skills !== undefined && !namesLocation(raw.skills, "skills")) {
    const named =
      typeof raw.skills === "string" ? `"${raw.skills}"` : "a non-path value";
    issues.warn(
      "UNSUPPORTED_COMPONENT",
      `"skills" in ${path} names ${named}; skills are read only from "skills/"`,
      { path }
    );
  }
  reportUnsupportedFeatures(raw, path, issues);
  return { interpretation, record };
}

/** Only OpenAI's namespace crosses from an overlay; the rest is the root's. */
function applyCodexOverlay(
  root: Record<string, unknown>,
  interpretation: PluginBundleInterpretation,
  { readJson, issues }: ResolveManifestSourceInput
): ResolvedManifestSource {
  const ignore = (why: string): ResolvedManifestSource => {
    issues.warn(
      "MANIFEST_OVERLAY_IGNORED",
      `"${CODEX_MANIFEST_PATH}" is ignored: ${why}`,
      { path: CODEX_MANIFEST_PATH }
    );
    return { interpretation, record: root };
  };
  const extensions = root.extensions;
  if (extensions !== undefined && !isPlainRecord(extensions)) {
    return ignore(`"${PLUGIN_MANIFEST_PATH}" has no usable "extensions"`);
  }
  if (isPlainRecord(extensions?.[OPENAI_EXTENSION_NAMESPACE])) {
    return ignore(
      `"${PLUGIN_MANIFEST_PATH}" declares extensions["${OPENAI_EXTENSION_NAMESPACE}"], which replaces it`
    );
  }
  const scoped = new PluginIssueCollector();
  const overlay = readJson(CODEX_MANIFEST_PATH, scoped);
  if (!isPlainRecord(overlay)) {
    return ignore(scoped.firstErrorMessage() ?? "it must be a JSON object");
  }
  for (const [field, fixed] of [
    ["skills", "skills"],
    ["mcpServers", "mcp.json"],
  ] as const) {
    if (overlay[field] === undefined || namesLocation(overlay[field], fixed))
      continue;
    issues.warn(
      "MANIFEST_OVERLAY_IGNORED",
      `"${field}" in ${CODEX_MANIFEST_PATH} is ignored: with a root plugin.json it is always "${fixed}"`,
      { path: CODEX_MANIFEST_PATH }
    );
  }
  reportUnsupportedFeatures(overlay, CODEX_MANIFEST_PATH, issues);
  const openai = openAiDataFromLegacy(overlay, CODEX_MANIFEST_PATH, issues);
  return {
    interpretation: { ...interpretation, overlayPath: CODEX_MANIFEST_PATH },
    record: { ...root, extensions: withOpenAiData(extensions, openai) },
  };
}

/** Legacy manifests other than the one in use (the Codex overlay aside). */
function reportIgnoredManifests(
  manifestPath: string,
  { filePaths, issues }: ResolveManifestSourceInput
): void {
  for (const { path } of LEGACY_MANIFEST_LOCATIONS) {
    const overlay =
      manifestPath === PLUGIN_MANIFEST_PATH && path === CODEX_MANIFEST_PATH;
    if (path === manifestPath || overlay || !filePaths.has(path)) continue;
    issues.warn(
      "MANIFEST_OVERLAY_IGNORED",
      `"${path}" is ignored: "${manifestPath}" is the manifest`,
      { path }
    );
  }
}

function resolveRootManifest(
  input: ResolveManifestSourceInput
): ResolvedManifestSource {
  const { profile, filePaths, readJson, issues } = input;
  const interpretation: PluginBundleInterpretation = {
    profile,
    layout: "agent-plugins",
    manifestPath: PLUGIN_MANIFEST_PATH,
  };
  const raw = readJson(PLUGIN_MANIFEST_PATH, issues);
  if (profile === "strict" || !isPlainRecord(raw)) {
    return { interpretation, record: raw };
  }
  reportIgnoredManifests(PLUGIN_MANIFEST_PATH, input);
  return filePaths.has(CODEX_MANIFEST_PATH)
    ? applyCodexOverlay(raw, interpretation, input)
    : { interpretation, record: raw };
}

/**
 * Resolve the manifest for `parsePluginBundle`, or report `MANIFEST_MISSING`
 * and return `null` when the profile finds none.
 */
export function resolveManifestSource(
  input: ResolveManifestSourceInput
): ResolvedManifestSource | null {
  const { profile, filePaths, readJson, issues } = input;
  if (filePaths.has(PLUGIN_MANIFEST_PATH)) return resolveRootManifest(input);

  const legacy =
    profile === "openai-compatible"
      ? LEGACY_MANIFEST_LOCATIONS.find(({ path }) => filePaths.has(path))
      : undefined;
  if (legacy === undefined) {
    const legacyPaths = LEGACY_MANIFEST_LOCATIONS.map(({ path }) => path);
    issues.error(
      "MANIFEST_MISSING",
      `bundle is missing "${PLUGIN_MANIFEST_PATH}" at its root${
        profile === "strict" ? "" : ` (or ${legacyPaths.join(", ")})`
      }`
    );
    return null;
  }
  reportIgnoredManifests(legacy.path, input);
  const interpretation: PluginBundleInterpretation = {
    profile,
    layout: legacy.layout,
    manifestPath: legacy.path,
  };
  const raw = readJson(legacy.path, issues);
  return isPlainRecord(raw)
    ? adaptLegacyManifest(raw, interpretation, input)
    : { interpretation, record: raw };
}
