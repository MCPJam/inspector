/**
 * Plugin-bundle validation issues — stable codes and severities.
 *
 * Codes are part of the SDK's public contract: the backend persists them in
 * `pluginImports.failure` / validation summaries and the inspector renders
 * them in the import preview, so they must stay stable once released. Add new
 * codes; never repurpose existing ones.
 */

export const PLUGIN_ISSUE_CODES = [
  // Bundle / archive level
  "BUNDLE_EMPTY",
  "BUNDLE_TOO_MANY_ENTRIES",
  "BUNDLE_TOO_LARGE",
  "FILE_TOO_LARGE",
  "FILE_SIZE_MISMATCH",
  "FILE_INVALID_UTF8",
  "FILE_UNREADABLE",
  "VALUE_TOO_DEEP",
  // Path safety
  "PATH_EMPTY",
  "PATH_ABSOLUTE",
  "PATH_TRAVERSAL",
  "PATH_NUL_BYTE",
  "PATH_INVALID_CHARACTER",
  "PATH_DUPLICATE",
  "PATH_CASE_COLLISION",
  "PATH_LINK_ENTRY",
  "PATH_TOO_LONG",
  "PATH_TOO_DEEP",
  "PATH_ESCAPES_ROOT",
  // Manifest
  "MANIFEST_MISSING",
  "MANIFEST_DUPLICATE",
  "MANIFEST_INVALID_JSON",
  "MANIFEST_INVALID_NAME",
  "MANIFEST_INVALID_VERSION",
  "MANIFEST_INVALID_FIELD",
  "MANIFEST_INSECURE_URL",
  "MANIFEST_MISSING_FILE",
  "MANIFEST_PLACEHOLDER",
  "MANIFEST_UNKNOWN_FIELD",
  "MANIFEST_AMBIGUOUS_FIELD",
  "MANIFEST_SECRET_FIELD_OMITTED",
  // Skills
  "SKILL_TOO_MANY",
  "SKILL_FRONTMATTER_MISSING",
  "SKILL_FRONTMATTER_UNPARSED",
  "SKILL_MISSING_NAME",
  "SKILL_MISSING_DESCRIPTION",
  "SKILL_INVALID_NAME",
  "SKILL_DESCRIPTION_TOO_LONG",
  "SKILL_NAME_MISMATCH",
  "SKILL_DUPLICATE_NAME",
  "SKILL_INVALID_METADATA",
  // MCP configuration
  "MCP_TOO_MANY_SERVERS",
  "MCP_INVALID_CONFIG",
  "MCP_DUPLICATE_WRAPPER",
  "MCP_INVALID_SERVER",
  "MCP_INVALID_SERVER_NAME",
  "MCP_AMBIGUOUS_TRANSPORT",
  "MCP_UNKNOWN_TRANSPORT",
  "MCP_MISSING_COMMAND",
  "MCP_MISSING_URL",
  "MCP_INSECURE_URL",
  "MCP_INSECURE_URL_LOCALHOST",
  "MCP_INVALID_ENV",
  "MCP_INVALID_HEADERS",
  "MCP_ENV_VALUE_OMITTED",
  "MCP_HEADER_VALUE_OMITTED",
  "MCP_SECRET_FIELD_OMITTED",
  "MCP_UNKNOWN_FIELD",
  "MCP_ABSOLUTE_WORKING_DIRECTORY",
  "MCP_CONFIG_IGNORED",
  // App configuration
  "APP_INVALID_CONFIG",
  "APP_MISSING_ID",
  "APP_UNKNOWN_SERVER",
  "APP_SECRET_FIELD_OMITTED",
  // Assets
  "ASSET_CONTENT_MISMATCH",
  "ASSET_UNSUPPORTED_TYPE",
  // Preserved-but-unsupported components
  "UNSUPPORTED_COMPONENT",
] as const;

export type PluginIssueCode = (typeof PLUGIN_ISSUE_CODES)[number];

export type PluginIssueSeverity = "error" | "warning";

export interface PluginValidationIssue {
  code: PluginIssueCode;
  severity: PluginIssueSeverity;
  message: string;
  /** Bundle path the issue refers to, when applicable. */
  path?: string;
  /** Component key (`skill:<dir>`, `server:<key>`, `app:<path>`) when applicable. */
  componentKey?: string;
}

/**
 * Thrown by `parsePluginBundle` when any error-severity issue is found.
 * `issues` carries every issue collected up to the failure (errors and
 * warnings), so import previews can render the full list from one throw.
 */
export class PluginBundleError extends Error {
  readonly code: PluginIssueCode;
  readonly issues: PluginValidationIssue[];

  constructor(issues: PluginValidationIssue[]) {
    const firstError = issues.find((issue) => issue.severity === "error");
    const code = firstError?.code ?? "MANIFEST_INVALID_FIELD";
    super(
      firstError
        ? `plugin bundle validation failed: ${firstError.code}: ${firstError.message}`
        : "plugin bundle validation failed"
    );
    this.name = "PluginBundleError";
    this.code = code;
    this.issues = issues;
  }
}

/** Accumulates issues during a parse; errors are fatal, warnings survive. */
export class PluginIssueCollector {
  private readonly all: PluginValidationIssue[] = [];

  error(
    code: PluginIssueCode,
    message: string,
    context?: { path?: string; componentKey?: string }
  ): void {
    this.all.push({ code, severity: "error", message, ...context });
  }

  warn(
    code: PluginIssueCode,
    message: string,
    context?: { path?: string; componentKey?: string }
  ): void {
    this.all.push({ code, severity: "warning", message, ...context });
  }

  hasErrors(): boolean {
    return this.all.some((issue) => issue.severity === "error");
  }

  issues(): PluginValidationIssue[] {
    return [...this.all];
  }

  warnings(): PluginValidationIssue[] {
    return this.all.filter((issue) => issue.severity === "warning");
  }

  /** Throws a `PluginBundleError` carrying every collected issue. */
  throwIfErrors(): void {
    if (this.hasErrors()) {
      throw new PluginBundleError(this.issues());
    }
  }
}

/**
 * Maximum nesting depth for any parsed value tree (manifest fields, unknown
 * extensions, oauth metadata, YAML flow sequences). Exceeding it emits
 * `VALUE_TOO_DEEP` through the normal error path instead of letting hostile
 * input blow the stack with a raw RangeError.
 */
export const MAX_VALUE_DEPTH = 32;

/**
 * Config/extension field NAMES that carry credential values. Shared by the
 * MCP config normalizer and the recursive extension sanitizer. Deliberately
 * excludes bare "auth"/"authorization" so URL-ish fields like
 * `authorization_server` survive; secret-looking VALUES under any key are
 * caught by `SECRET_LIKE_VALUE` instead.
 */
export const SECRET_FIELD_NAME =
  /(secret|token|password|passwd|api[-_]?key|private[-_]?key|credential)/i;

/**
 * String VALUES that look like credentials regardless of their key name:
 * bearer tokens, PEM blocks, common key-prefix formats, or long opaque
 * token runs. Closes the `{"auth": "Bearer sk-live-..."}` alias hole that a
 * key-name denylist alone cannot.
 */
const SECRET_LIKE_VALUE =
  /(bearer\s+\S|-----BEGIN|\b(?:sk|pk|rk|xox[a-z])-[A-Za-z0-9]|[A-Za-z0-9+/_-]{40,})/i;

const DROP: unique symbol = Symbol("drop");

interface SanitizeArgs {
  issues: PluginIssueCollector;
  /** Warning code for dropped secret-looking keys/values. */
  secretCode: PluginIssueCode;
  /** Message prefix, e.g. `server "crm"` or `manifest`. */
  label: string;
  context?: { path?: string; componentKey?: string };
}

interface SanitizeState {
  reportedTooDeep: boolean;
}

function sanitizeValue(
  value: unknown,
  keyPath: string,
  depth: number,
  args: SanitizeArgs,
  state: SanitizeState
): unknown | typeof DROP {
  if (depth > MAX_VALUE_DEPTH) {
    if (!state.reportedTooDeep) {
      state.reportedTooDeep = true;
      args.issues.error(
        "VALUE_TOO_DEEP",
        `${args.label}: field "${keyPath}" nests deeper than ${MAX_VALUE_DEPTH} levels`,
        args.context
      );
    }
    return DROP;
  }
  if (typeof value === "string") {
    if (SECRET_LIKE_VALUE.test(value)) {
      args.issues.warn(
        args.secretCode,
        `${args.label}: value of "${keyPath}" looks secret-bearing and is not stored`,
        args.context
      );
      return DROP;
    }
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = sanitizeValue(
        value[i],
        `${keyPath}[${i}]`,
        depth + 1,
        args,
        state
      );
      if (item !== DROP) sanitized.push(item);
    }
    return sanitized;
  }
  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      const nestedPath = keyPath === "" ? key : `${keyPath}.${key}`;
      if (SECRET_FIELD_NAME.test(key)) {
        args.issues.warn(
          args.secretCode,
          `${args.label}: field "${nestedPath}" looks secret-bearing and is not stored`,
          args.context
        );
        continue;
      }
      const item = sanitizeValue(nested, nestedPath, depth + 1, args, state);
      if (item !== DROP) sanitized[key] = item;
    }
    return sanitized;
  }
  // Non-JSON value (undefined, function, ...) — never store it.
  return DROP;
}

/**
 * Recursively sanitize an unknown/extension record before it reaches a stored
 * DTO or a hash input: secret-looking KEYS are dropped at every depth,
 * secret-looking string VALUES are dropped regardless of key, and nesting is
 * depth-capped. Every drop emits an issue; nothing is silently discarded.
 */
export function sanitizeUnknownRecord(
  record: Record<string, unknown>,
  args: SanitizeArgs
): Record<string, unknown> {
  const state: SanitizeState = { reportedTooDeep: false };
  return sanitizeValue(record, "", 0, args, state) as Record<string, unknown>;
}
