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
