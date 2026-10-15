/**
 * App metadata (`*.app.json`) parsing.
 *
 * V1 executes an app mapping only when it can be associated with an MCP
 * server already present in the bundle (declared binding, or inferred when the
 * bundle ships exactly one server). Everything else is preserved as
 * `needs_server_binding` so the import preview can ask the user for an
 * explicit MCPJam server binding.
 *
 * OpenAI's keyed form (`{ "apps": { "<server>": { "id": "plugin_asdk_app_…" } } }`)
 * maps a server name to an app registered in ChatGPT's directory, which
 * MCPJam cannot resolve. Such an entry is metadata: it runs through the
 * bundle server of the same name when there is one, and is `unresolved`,
 * never runnable, when there is not.
 */

import {
  sanitizeUnknownRecord,
  type PluginIssueCollector,
} from "./validation.js";

export type PluginAppBinding =
  | "declared"
  | "inferred"
  | "unbound"
  | "registered";

export interface ParsedPluginApp {
  /** `app:<source-path>`, or `app:<source-path>#<key>` for a keyed entry. */
  componentKey: string;
  appId: string;
  /** Canonical bundle path of the `.app.json` file. */
  sourcePath: string;
  /** The entry's key in a keyed `.app.json`. */
  appKey?: string;
  /** Bundle MCP server key this app maps to, when bound. */
  serverKey?: string;
  binding: PluginAppBinding;
  status: "bound" | "needs_server_binding" | "unresolved";
  /** SHA-256 of the raw `.app.json` bytes; filled in by the parser. */
  contentHash: string;
  /** Source fields other than the id/server binding, preserved verbatim. */
  extensions: Record<string, unknown>;
}

const APP_ID_KEYS = ["app_id", "appId", "id"] as const;
const SERVER_KEYS = ["server", "mcp_server", "mcpServer", "serverKey"] as const;

interface AppConfigArgs {
  sourcePath: string;
  raw: unknown;
  /** Declared MCP server keys present in the bundle. */
  serverKeys: string[];
  contentHash: string;
  issues: PluginIssueCollector;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAppId(
  record: Record<string, unknown>
): { appId: string; appIdKey: string } | undefined {
  for (const key of APP_ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return { appId: value, appIdKey: key };
    }
  }
  return undefined;
}

/** OpenAI's keyed form: one registered app per server name. */
function parseKeyedApps(
  apps: unknown,
  { sourcePath, serverKeys, contentHash, issues }: AppConfigArgs
): ParsedPluginApp[] | null {
  if (!isPlainRecord(apps)) {
    issues.error("APP_INVALID_CONFIG", `"apps" must be an object`, {
      path: sourcePath,
    });
    return null;
  }
  const parsed: ParsedPluginApp[] = [];
  for (const [appKey, entry] of Object.entries(apps)) {
    const componentKey = `app:${sourcePath}#${appKey}`;
    const id = isPlainRecord(entry) ? readAppId(entry) : undefined;
    if (!isPlainRecord(entry) || id === undefined) {
      issues.warn("APP_MISSING_ID", `app "${appKey}" has no app id; ignored`, {
        path: sourcePath,
        componentKey,
      });
      continue;
    }
    const { [id.appIdKey]: _id, ...rest } = entry;
    const bound = serverKeys.includes(appKey);
    parsed.push({
      componentKey,
      appId: id.appId,
      sourcePath,
      appKey,
      ...(bound ? { serverKey: appKey } : {}),
      binding: "registered",
      status: bound ? "bound" : "unresolved",
      contentHash,
      extensions: sanitizeUnknownRecord(rest, {
        issues,
        secretCode: "APP_SECRET_FIELD_OMITTED",
        label: `app "${appKey}"`,
        context: { path: sourcePath, componentKey },
      }),
    });
  }
  return parsed;
}

/** Parse one `.app.json` document. Returns `null` on fatal issues. */
export function parsePluginAppConfig(
  args: AppConfigArgs
): ParsedPluginApp[] | null {
  const { sourcePath, raw, issues } = args;
  const componentKey = `app:${sourcePath}`;
  const context = { path: sourcePath, componentKey };

  if (!isPlainRecord(raw)) {
    issues.error(
      "APP_INVALID_CONFIG",
      "app configuration must be a JSON object",
      context
    );
    return null;
  }
  if (raw.apps !== undefined && readAppId(raw) === undefined) {
    return parseKeyedApps(raw.apps, args);
  }
  const app = parseSingleApp(raw, args);
  return app === null ? null : [app];
}

function parseSingleApp(
  record: Record<string, unknown>,
  { sourcePath, serverKeys, contentHash, issues }: AppConfigArgs
): ParsedPluginApp | null {
  const componentKey = `app:${sourcePath}`;
  const context = { path: sourcePath, componentKey };
  const { appId, appIdKey } = readAppId(record) ?? {};
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
