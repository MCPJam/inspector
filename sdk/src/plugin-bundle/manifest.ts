/**
 * Agent Plugins 1.0 manifest (`plugin.json` at the bundle root) validation
 * and normalization — https://agent-plugins.org/schemas/1.0.0/plugin.schema.json.
 *
 * The manifest is a CLOSED object per the spec: `$schema` and `name` are
 * required; unknown top-level fields are reported and ignored (never
 * preserved, never executed); a non-object `extensions` is reported and
 * ignored. `$schema` selects the validation contract from a compiled-in
 * list — schemas are never retrieved at load time (spec MUST).
 *
 * MCPJam-specific presentation metadata (display name, icon, logo) lives in
 * the `com.mcpjam` reverse-domain extension namespace, per the spec's
 * client-extension model — never as top-level fields.
 */

import { resolveContainedPath } from "./paths.js";
import {
  MAX_VALUE_DEPTH,
  sanitizeUnknownRecord,
  type PluginIssueCollector,
} from "./validation.js";

export const PLUGIN_MANIFEST_PATH = "plugin.json";

/**
 * Canonical schema identifiers per supported Agent Plugins version. Frozen:
 * this map IS the compiled-in allowlist, so a caller mutating it at runtime
 * would defeat the local-schema-selection contract.
 */
export const PLUGIN_MANIFEST_SCHEMAS: Readonly<Record<string, string>> =
  Object.freeze({
    "1.0.0": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  });

/** Reverse-domain namespace MCPJam reads its own extension data from. */
export const MCPJAM_EXTENSION_NAMESPACE = "com.mcpjam";

export interface PluginManifestAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface NormalizedPluginManifest {
  /**
   * Agent Plugins version the bundle targets, resolved locally from
   * `$schema` (e.g. `"1.0.0"`). Never fetched.
   */
  schemaVersion: string;
  /** Validated plugin name — the stable logical identity. Dots are legal. */
  name: string;
  /** Declared version string, when present. Metadata only, format-free. */
  version?: string;
  description?: string;
  /** From the `com.mcpjam` extension namespace, when present. */
  displayName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  author?: PluginManifestAuthor;
  keywords?: string[];
  /** Bundle-relative icon path from the `com.mcpjam` namespace. */
  icon?: string;
  /** Bundle-relative logo path from the `com.mcpjam` namespace. */
  logo?: string;
  /**
   * Client-extension data keyed by reverse-domain namespace, sanitized
   * (secret-looking keys/values dropped, depth-capped). MCPJam applies only
   * the `com.mcpjam` namespace and ignores the rest, per spec.
   */
  extensions: Record<string, unknown>;
}

/**
 * Agent Plugins name rule: lowercase alphanumerics with single `-`/`.`
 * separators; no leading/trailing separator, no `--`, no `..`; 1–64 chars.
 */
const AP_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;

const PLACEHOLDER = /\[TODO:/i;

/** Simple string metadata fields copied through after a type check. */
const STRING_FIELDS = ["description", "license"] as const;

/** URL metadata fields; MCPJam requires HTTPS when present. */
const URL_FIELDS = ["homepage", "repository"] as const;

/**
 * Unknown fields that would change execution semantics if silently ignored.
 * The spec says unknown fields are reported and ignored; these are rejected
 * outright because "ignored" is exactly what an attacker shipping an
 * `install_script` field would want.
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
  "$schema",
  "name",
  "version",
  "author",
  "keywords",
  "extensions",
  ...STRING_FIELDS,
  ...URL_FIELDS,
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
 * Read MCPJam presentation metadata out of the `com.mcpjam` namespace.
 *
 * Reads from the RAW extensions record, not the sanitized copy: the shared
 * secret-value screen drops long opaque runs, and a legitimate icon path
 * (`assets/brand-name-banner-icon-desktop-retina-display.png`) can trip it.
 * These three fields have their own validation — a string type check plus,
 * for icon/logo, containment and existence in the bundle — so nothing
 * unvetted is stored.
 */
function applyMcpjamExtension(
  manifest: NormalizedPluginManifest,
  rawExtensions: Record<string, unknown>,
  filePaths: ReadonlySet<string>,
  issues: PluginIssueCollector
): void {
  const raw = rawExtensions[MCPJAM_EXTENSION_NAMESPACE];
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.warn(
      "MANIFEST_INVALID_FIELD",
      `extension namespace "${MCPJAM_EXTENSION_NAMESPACE}" must be an object; ignored`
    );
    return;
  }
  const record = raw as Record<string, unknown>;

  const displayName = record.displayName ?? record.display_name;
  if (displayName !== undefined) {
    if (typeof displayName !== "string") {
      issues.warn(
        "MANIFEST_INVALID_FIELD",
        `"${MCPJAM_EXTENSION_NAMESPACE}.displayName" must be a string; ignored`
      );
    } else {
      manifest.displayName = displayName;
    }
  }

  for (const key of ["icon", "logo"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      issues.warn(
        "MANIFEST_INVALID_FIELD",
        `"${MCPJAM_EXTENSION_NAMESPACE}.${key}" must be a bundle-relative path; ignored`
      );
      continue;
    }
    const resolved = resolveContainedPath("", value);
    if (!resolved.ok) {
      issues.warn(resolved.code, `"${MCPJAM_EXTENSION_NAMESPACE}.${key}": ${resolved.message}`);
      continue;
    }
    if (!filePaths.has(resolved.path)) {
      issues.warn(
        "MANIFEST_MISSING_FILE",
        `"${MCPJAM_EXTENSION_NAMESPACE}.${key}" references a file that is not in the bundle: "${resolved.path}"`,
        { path: resolved.path }
      );
      continue;
    }
    manifest[key] = resolved.path;
  }
}

export interface PluginManifestNormalization {
  /** `null` when the manifest is unusable (errors were collected). */
  manifest: NormalizedPluginManifest | null;
}

/**
 * Validate and normalize a parsed `plugin.json` value per Agent Plugins 1.0.
 *
 * Fatal (bundle-rejecting) violations: missing/unsupported `$schema`,
 * invalid `name`, wrong-typed known fields, execution-ambiguous fields.
 * Non-fatal: unknown top-level fields (reported, ignored) and a non-object
 * `extensions` (reported, ignored) — per the spec's explicit list.
 *
 * `filePaths` is the set of canonical bundle paths, used to verify files
 * referenced from the `com.mcpjam` namespace (icon/logo) exist in-bundle.
 */
export function normalizePluginManifest(
  raw: unknown,
  context: {
    filePaths: ReadonlySet<string>;
    issues: PluginIssueCollector;
  }
): PluginManifestNormalization {
  const { filePaths, issues } = context;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.error(
      "MANIFEST_INVALID_JSON",
      "plugin.json must contain a JSON object"
    );
    return { manifest: null };
  }
  const record = raw as Record<string, unknown>;

  // $schema — required; selects the locally supported validation contract.
  const schema = record.$schema;
  const schemaVersion =
    typeof schema === "string"
      ? Object.keys(PLUGIN_MANIFEST_SCHEMAS).find(
          (version) => PLUGIN_MANIFEST_SCHEMAS[version] === schema
        )
      : undefined;
  if (schemaVersion === undefined) {
    issues.error(
      "MANIFEST_UNSUPPORTED_SCHEMA",
      schema === undefined
        ? `manifest is missing the required "$schema" field`
        : `manifest "$schema" is not a supported Agent Plugins schema: ${String(
            schema
          )}`
    );
    return { manifest: null };
  }

  // name — required, Agent Plugins charset (dots legal, no "--"/"..").
  const name = record.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !AP_NAME.test(name)
  ) {
    issues.error(
      "MANIFEST_INVALID_NAME",
      `manifest "name" must be 1-${MAX_NAME_LENGTH} lowercase [a-z0-9.-] chars with single separators (no "--" or "..")`
    );
    return { manifest: null };
  }

  const manifest: NormalizedPluginManifest = {
    schemaVersion,
    name,
    extensions: {},
  };

  // version — optional free-form string (the spec imposes no format).
  if (record.version !== undefined) {
    if (typeof record.version !== "string" || record.version.length === 0) {
      issues.error(
        "MANIFEST_INVALID_VERSION",
        `manifest "version" must be a non-empty string when present`
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

  for (const key of URL_FIELDS) {
    if (record[key] === undefined) continue;
    const url = readHttpsUrl(key, record[key], issues);
    if (url !== undefined) manifest[key] = url;
  }

  // author — object per the spec schema (no additional properties).
  const author = record.author;
  if (author !== undefined) {
    if (author && typeof author === "object" && !Array.isArray(author)) {
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
        `manifest field "author" must be an object`
      );
    }
  }

  const keywords = record.keywords;
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

  // extensions — reverse-domain namespace map. Non-object: report + ignore
  // (explicitly non-fatal per spec). Object: sanitize before storing, so no
  // secret-looking key or value at any depth rides into the persisted
  // manifest.
  const extensions = record.extensions;
  if (extensions !== undefined) {
    if (
      extensions === null ||
      typeof extensions !== "object" ||
      Array.isArray(extensions)
    ) {
      issues.warn(
        "MANIFEST_INVALID_FIELD",
        `manifest field "extensions" must be an object; ignored`
      );
    } else {
      manifest.extensions = sanitizeUnknownRecord(
        extensions as Record<string, unknown>,
        {
          issues,
          secretCode: "MANIFEST_SECRET_FIELD_OMITTED",
          label: "manifest extensions",
        }
      );
      applyMcpjamExtension(
        manifest,
        extensions as Record<string, unknown>,
        filePaths,
        issues
      );
    }
  }

  // Unknown top-level fields: reported and IGNORED (closed manifest) —
  // except execution-ambiguous names, which are rejected outright.
  for (const key of Object.keys(record)) {
    if (HANDLED_FIELDS.has(key)) continue;
    if (EXECUTION_AMBIGUOUS_FIELDS.has(key)) {
      issues.error(
        "MANIFEST_AMBIGUOUS_FIELD",
        `manifest field "${key}" is not supported and is execution-ambiguous; remove it`
      );
      continue;
    }
    issues.warn(
      "MANIFEST_UNKNOWN_FIELD",
      `manifest field "${key}" is not part of Agent Plugins ${schemaVersion}; ignored`
    );
  }

  // Placeholder hygiene runs over the NORMALIZED manifest, not the raw
  // record: an unresolved [TODO: ...] in a field we keep is fatal, but one
  // inside an unknown field we already reported and ignored must not be —
  // ignored means ignored.
  scanForPlaceholders(
    manifest as unknown as Record<string, unknown>,
    "",
    issues
  );

  return { manifest };
}
