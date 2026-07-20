/**
 * Plugin manifest (`.codex-plugin/plugin.json`) validation and normalization.
 *
 * Known fields are validated into a closed DTO. Unknown optional fields are
 * preserved verbatim in the namespaced `extensions` map with a warning so
 * forward-compatible OpenAI additions survive a round trip; only fields that
 * would make execution ambiguous (script/command-like keys) are rejected.
 */

import { resolveContainedPath } from "./paths.js";
import {
  MAX_VALUE_DEPTH,
  sanitizeUnknownRecord,
  type PluginIssueCollector,
} from "./validation.js";

export const PLUGIN_MANIFEST_DIR = ".codex-plugin";
export const PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json";

export interface PluginManifestAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface NormalizedPluginManifest {
  /** Normalized kebab-case plugin name — the stable logical identity. */
  name: string;
  /** Declared semver, when present. Metadata only; never the storage identity. */
  version?: string;
  description?: string;
  displayName?: string;
  homepage?: string;
  repository?: string;
  documentation?: string;
  support?: string;
  license?: string;
  author?: PluginManifestAuthor;
  keywords?: string[];
  /** Bundle-relative path to the plugin icon, validated to exist. */
  icon?: string;
  /** Bundle-relative path to the plugin logo, validated to exist. */
  logo?: string;
  /**
   * Unknown optional manifest fields, preserved verbatim under their original
   * keys. Never interpreted by MCPJam runtime code.
   */
  extensions: Record<string, unknown>;
}

export interface PluginManifestNormalization {
  /** `null` when the manifest is unusable (errors were collected). */
  manifest: NormalizedPluginManifest | null;
  /** Manifest fields describing components MCPJam preserves but cannot run. */
  unsupportedFields: string[];
}

const KEBAB_CASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

// Official semver.org regex (2.0.0).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PLACEHOLDER = /\[TODO:/i;

/** Simple string metadata fields copied through after a type check. */
const STRING_FIELDS = ["description", "license"] as const;

/** Install-metadata URL fields; must be HTTPS when present. */
const URL_FIELDS = [
  "homepage",
  "repository",
  "documentation",
  "support",
] as const;

/** Bundle-relative asset references; must exist inside the bundle. */
const ASSET_FIELDS = ["icon", "logo"] as const;

/** Manifest fields describing components V1 preserves but does not execute. */
const UNSUPPORTED_COMPONENT_FIELDS = new Set([
  "hooks",
  "extensions",
  "browser_extensions",
  "scheduled_tasks",
  "tasks",
  "commands",
]);

/**
 * Unknown fields that would change execution semantics if silently ignored.
 * These are rejected rather than preserved (plan: "Reject unknown fields only
 * when they make execution ambiguous or unsafe").
 */
const EXECUTION_AMBIGUOUS_FIELDS = new Set([
  "command",
  "entrypoint",
  "exec",
  "install",
  "install_script",
  "postinstall",
  "preinstall",
  "run",
  "script",
  "scripts",
]);

const HANDLED_FIELDS = new Set<string>([
  "name",
  "version",
  "display_name",
  "displayName",
  "author",
  "keywords",
  "tags",
  ...STRING_FIELDS,
  ...URL_FIELDS,
  ...ASSET_FIELDS,
]);

function scanForPlaceholders(
  value: unknown,
  fieldPath: string,
  issues: PluginIssueCollector,
  depth = 0,
  state = { reportedTooDeep: false }
): void {
  if (typeof value === "string") {
    if (PLACEHOLDER.test(value)) {
      issues.error(
        "MANIFEST_PLACEHOLDER",
        `manifest field "${fieldPath}" contains an unresolved placeholder`
      );
    }
    return;
  }
  // Depth cap: hostile deeply-nested JSON must fail with a stable issue
  // code, not a raw RangeError from unbounded recursion.
  if (depth > MAX_VALUE_DEPTH) {
    if (!state.reportedTooDeep) {
      state.reportedTooDeep = true;
      issues.error(
        "VALUE_TOO_DEEP",
        `manifest field "${fieldPath}" nests deeper than ${MAX_VALUE_DEPTH} levels`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForPlaceholders(
        item,
        `${fieldPath}[${index}]`,
        issues,
        depth + 1,
        state
      )
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      scanForPlaceholders(
        nested,
        fieldPath === "" ? key : `${fieldPath}.${key}`,
        issues,
        depth + 1,
        state
      );
    }
  }
}

function readHttpsUrl(
  key: string,
  value: unknown,
  issues: PluginIssueCollector
): string | undefined {
  if (typeof value !== "string") {
    issues.error(
      "MANIFEST_INVALID_FIELD",
      `manifest field "${key}" must be a string URL`
    );
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.error(
      "MANIFEST_INVALID_FIELD",
      `manifest field "${key}" is not a valid URL`
    );
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    issues.error(
      "MANIFEST_INSECURE_URL",
      `manifest field "${key}" must use HTTPS`
    );
    return undefined;
  }
  return value;
}

/**
 * Validate and normalize a parsed `plugin.json` value.
 *
 * `filePaths` is the set of canonical bundle paths, used to verify referenced
 * files (icon/logo) exist and stay inside the bundle root.
 */
export function normalizePluginManifest(
  raw: unknown,
  context: {
    filePaths: ReadonlySet<string>;
    issues: PluginIssueCollector;
  }
): PluginManifestNormalization {
  const { filePaths, issues } = context;
  const unsupportedFields: string[] = [];
  const unknownFields: Record<string, unknown> = {};

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.error(
      "MANIFEST_INVALID_JSON",
      "plugin.json must contain a JSON object"
    );
    return { manifest: null, unsupportedFields };
  }
  const record = raw as Record<string, unknown>;

  scanForPlaceholders(record, "", issues);

  // name — required, kebab-case, stable.
  const name = record.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !KEBAB_CASE_NAME.test(name)
  ) {
    issues.error(
      "MANIFEST_INVALID_NAME",
      `manifest "name" must be kebab-case ([a-z0-9-], 1-${MAX_NAME_LENGTH} chars)`
    );
    return { manifest: null, unsupportedFields };
  }

  const manifest: NormalizedPluginManifest = { name, extensions: {} };

  // version — optional, semver when present.
  if (record.version !== undefined) {
    if (typeof record.version !== "string" || !SEMVER.test(record.version)) {
      issues.error(
        "MANIFEST_INVALID_VERSION",
        `manifest "version" must be valid semver when present`
      );
    } else {
      manifest.version = record.version;
    }
  }

  for (const key of STRING_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      issues.error(
        "MANIFEST_INVALID_FIELD",
        `manifest field "${key}" must be a string`
      );
      continue;
    }
    manifest[key] = value;
  }

  const displayName = record.display_name ?? record.displayName;
  if (displayName !== undefined) {
    if (typeof displayName !== "string") {
      issues.error(
        "MANIFEST_INVALID_FIELD",
        `manifest field "display_name" must be a string`
      );
    } else {
      manifest.displayName = displayName;
    }
  }

  for (const key of URL_FIELDS) {
    if (record[key] === undefined) continue;
    const url = readHttpsUrl(key, record[key], issues);
    if (url !== undefined) manifest[key] = url;
  }

  const author = record.author;
  if (author !== undefined) {
    if (typeof author === "string") {
      manifest.author = { name: author };
    } else if (author && typeof author === "object" && !Array.isArray(author)) {
      const authorRecord = author as Record<string, unknown>;
      const normalizedAuthor: PluginManifestAuthor = {};
      if (typeof authorRecord.name === "string") {
        normalizedAuthor.name = authorRecord.name;
      }
      if (typeof authorRecord.email === "string") {
        normalizedAuthor.email = authorRecord.email;
      }
      if (authorRecord.url !== undefined) {
        const url = readHttpsUrl("author.url", authorRecord.url, issues);
        if (url !== undefined) normalizedAuthor.url = url;
      }
      manifest.author = normalizedAuthor;
    } else {
      issues.error(
        "MANIFEST_INVALID_FIELD",
        `manifest field "author" must be a string or object`
      );
    }
  }

  const keywords = record.keywords ?? record.tags;
  if (keywords !== undefined) {
    if (
      !Array.isArray(keywords) ||
      keywords.some((keyword) => typeof keyword !== "string")
    ) {
      issues.error(
        "MANIFEST_INVALID_FIELD",
        `manifest field "keywords" must be an array of strings`
      );
    } else {
      manifest.keywords = keywords as string[];
    }
  }

  for (const key of ASSET_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      issues.error(
        "MANIFEST_INVALID_FIELD",
        `manifest field "${key}" must be a bundle-relative path`
      );
      continue;
    }
    const resolved = resolveContainedPath("", value);
    if (!resolved.ok) {
      issues.error(resolved.code, `manifest "${key}": ${resolved.message}`);
      continue;
    }
    if (!filePaths.has(resolved.path)) {
      issues.error(
        "MANIFEST_MISSING_FILE",
        `manifest "${key}" references a file that is not in the bundle: "${resolved.path}"`,
        { path: resolved.path }
      );
      continue;
    }
    manifest[key] = resolved.path;
  }

  for (const [key, value] of Object.entries(record)) {
    if (HANDLED_FIELDS.has(key)) continue;
    if (UNSUPPORTED_COMPONENT_FIELDS.has(key)) {
      unsupportedFields.push(key);
      continue;
    }
    if (EXECUTION_AMBIGUOUS_FIELDS.has(key)) {
      issues.error(
        "MANIFEST_AMBIGUOUS_FIELD",
        `manifest field "${key}" is not supported and is execution-ambiguous; remove it`
      );
      continue;
    }
    unknownFields[key] = value;
  }

  // Recursive sanitation before preservation: secret-looking keys and
  // values are dropped at every depth, and nesting is depth-capped, so no
  // credential can ride into the persisted normalized manifest.
  manifest.extensions = sanitizeUnknownRecord(unknownFields, {
    issues,
    secretCode: "MANIFEST_SECRET_FIELD_OMITTED",
    label: "manifest",
  });
  for (const key of Object.keys(manifest.extensions)) {
    issues.warn(
      "MANIFEST_UNKNOWN_FIELD",
      `manifest field "${key}" is not recognized; preserved in extensions`
    );
  }

  return { manifest, unsupportedFields };
}
