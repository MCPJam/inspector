/**
 * App metadata (`*.app.json`) parsing.
 *
 * V1 executes an app mapping only when it can be associated with an MCP
 * server already present in the bundle (declared binding, or inferred when the
 * bundle ships exactly one server). Everything else is preserved as
 * `needs_server_binding` so the import preview can ask the user for an
 * explicit MCPJam server binding.
 */

import {
  sanitizeUnknownRecord,
  type PluginIssueCollector,
} from "./validation.js";

export type PluginAppBinding = "declared" | "inferred" | "unbound";

export interface ParsedPluginApp {
  /** `app:<source-path>` — stable component identity. */
  componentKey: string;
  appId: string;
  /** Canonical bundle path of the `.app.json` file. */
  sourcePath: string;
  /** Bundle MCP server key this app maps to, when bound. */
  serverKey?: string;
  binding: PluginAppBinding;
  status: "bound" | "needs_server_binding";
  /** SHA-256 of the raw `.app.json` bytes; filled in by the parser. */
  contentHash: string;
  /** Source fields other than the id/server binding, preserved verbatim. */
  extensions: Record<string, unknown>;
}

const APP_ID_KEYS = ["app_id", "appId", "id"] as const;
const SERVER_KEYS = ["server", "mcp_server", "mcpServer", "serverKey"] as const;

/** Parse one `.app.json` document. Returns `null` on fatal issues. */
export function parsePluginAppConfig(args: {
  sourcePath: string;
  raw: unknown;
  /** Declared MCP server keys present in the bundle. */
  serverKeys: string[];
  contentHash: string;
  issues: PluginIssueCollector;
}): ParsedPluginApp | null {
  const { sourcePath, raw, serverKeys, contentHash, issues } = args;
  const componentKey = `app:${sourcePath}`;
  const context = { path: sourcePath, componentKey };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.error(
      "APP_INVALID_CONFIG",
      "app configuration must be a JSON object",
      context
    );
    return null;
  }
  const record = raw as Record<string, unknown>;

  let appId: string | undefined;
  let appIdKey: string | undefined;
  for (const key of APP_ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      appId = value;
      appIdKey = key;
      break;
    }
  }
  if (appId === undefined) {
    issues.error(
      "APP_MISSING_ID",
      `app configuration is missing an app id (${APP_ID_KEYS.join(", ")})`,
      context
    );
    return null;
  }

  let declaredServer: string | undefined;
  let serverField: string | undefined;
  for (const key of SERVER_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      declaredServer = value;
      serverField = key;
      break;
    }
  }

  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === appIdKey || key === serverField) continue;
    unknownFields[key] = value;
  }
  // Recursive sanitation: secret-looking keys/values never reach the DTO.
  const extensions = sanitizeUnknownRecord(unknownFields, {
    issues,
    secretCode: "APP_SECRET_FIELD_OMITTED",
    label: `app "${appId}"`,
    context,
  });

  if (declaredServer !== undefined) {
    if (serverKeys.includes(declaredServer)) {
      return {
        componentKey,
        appId,
        sourcePath,
        serverKey: declaredServer,
        binding: "declared",
        status: "bound",
        contentHash,
        extensions,
      };
    }
    issues.warn(
      "APP_UNKNOWN_SERVER",
      `app "${appId}" references MCP server "${declaredServer}" which is not in the bundle`,
      context
    );
    return {
      componentKey,
      appId,
      sourcePath,
      binding: "unbound",
      status: "needs_server_binding",
      contentHash,
      extensions,
    };
  }

  if (serverKeys.length === 1) {
    return {
      componentKey,
      appId,
      sourcePath,
      serverKey: serverKeys[0],
      binding: "inferred",
      status: "bound",
      contentHash,
      extensions,
    };
  }

  return {
    componentKey,
    appId,
    sourcePath,
    binding: "unbound",
    status: "needs_server_binding",
    contentHash,
    extensions,
  };
}
