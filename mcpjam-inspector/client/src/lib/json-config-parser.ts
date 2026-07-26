/**
 * MCP JSON config import/export.
 *
 * The three compatible document shapes — a direct server map, an
 * `mcp_servers` wrapper (OpenAI plugin `.mcp.json`), and an `mcpServers`
 * wrapper (MCPJam/Claude-style) — and the stdio-vs-http decision come from
 * `@mcpjam/sdk/plugin-bundle`'s pure shape primitives. The same functions
 * back the backend's plugin importer, so a config cannot be read one way here
 * and another way there.
 *
 * POLICY stays here, and is deliberately more permissive than the plugin
 * path's: the inspector is a debugger, so plain-HTTP URLs, free-form server
 * names, and real env/header VALUES are all first-class. The SDK's strict
 * `normalizePluginMcpConfig` rejects or strips all three, which is why this
 * consumes the shape primitives and reads values off the source config itself.
 */

import {
  detectPluginMcpTransport,
  selectPluginMcpServerMap,
} from "@mcpjam/sdk/plugin-bundle";
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/state/app-types";

export interface JsonServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "sse";
  url?: string;
}

export interface JsonConfig {
  mcpServers: Record<string, JsonServerConfig>;
}

/** The wrapper shape a pasted/uploaded config used. */
export type JsonConfigShape = "direct" | "mcp_servers" | "mcpServers";

export type ResolvedJsonServerMap =
  | { ok: true; shape: JsonConfigShape; servers: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Resolve a parsed JSON document to its server map. Single source of truth for
 * the three compatible source shapes — `parseJsonConfig` and
 * `validateJsonConfig` both go through here, so they can never disagree about
 * which shapes are accepted.
 *
 * The detection itself is `selectPluginMcpServerMap` from the SDK — the very
 * function the backend's plugin importer uses — so the two paths agree by
 * CONSTRUCTION rather than by two implementations being kept in step. This
 * wrapper only adapts the result to the shape/message contract the inspector's
 * import UI already renders.
 */
export function resolveJsonServerMap(config: unknown): ResolvedJsonServerMap {
  const selection = selectPluginMcpServerMap(config);
  if (!selection.ok) {
    return { ok: false, error: messageForSelectionFailure(selection) };
  }
  return {
    ok: true,
    shape: selection.wrapperKey ?? "direct",
    servers: Object.fromEntries(
      selection.servers.map((entry) => [entry.key, entry.config]),
    ),
  };
}

/**
 * Render an SDK selection failure using the wording this import UI has always
 * shown. Branches on the typed `reason` — the SDK's `message` is written for a
 * plugin bundle author and is not a contract, and `code` alone cannot separate
 * the three `MCP_INVALID_CONFIG` cases.
 */
function messageForSelectionFailure(
  selection: Extract<
    ReturnType<typeof selectPluginMcpServerMap>,
    { ok: false }
  >,
): string {
  switch (selection.reason) {
    case "duplicate-wrapper":
      return 'Configuration declares both "mcp_servers" and "mcpServers"; use only one';
    case "bare-server-config":
      return 'Configuration looks like a single server config; wrap it in "mcpServers": { "server-name": { ... } }';
    case "server-map-not-an-object":
      // Preserves the long-standing message for a malformed `mcpServers` value.
      return 'missing or invalid "mcpServers" property';
    case "document-not-an-object":
      return "Configuration must be a JSON object";
  }
}

/**
 * Shared per-entry guard: a server config must be a plain object (not null,
 * not an array). Used by both `parseJsonConfig` and `validateJsonConfig` so
 * the two paths cannot silently diverge.
 */
function isServerConfigRecord(value: unknown): value is JsonServerConfig {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keep only string-valued entries — env/header values are always strings. */
function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * Imported secret values must ride BOTH channels.
 *
 * `env`/`headers` on the form data feed the in-memory connection, but the
 * cloud persist path (`syncServerToConvex`) only writes them when the caller
 * passes an explicit `secretPatch`: the connect path always hands it a
 * `secretOptions` object, and without the patch key `headersForPayload` /
 * `envForPayload` resolve to `undefined` and the fields are dropped from the
 * payload. An import that set only `env`/`headers` would therefore connect
 * once and then 401 after a reload — exactly the failure header preservation
 * was meant to remove. The server FORM sets both for the same reason.
 *
 * Only non-empty values get a patch: an explicit empty patch is a command to
 * CLEAR the stored values, and re-importing a config must never wipe
 * credentials already attached to an existing server of the same name.
 */
function secretPatchFor(
  key: "env" | "headers",
  values: Record<string, string>,
): Pick<ServerFormData, "secretPatch"> {
  return Object.keys(values).length > 0
    ? { secretPatch: { [key]: values } }
    : {};
}

/**
 * Convert one source server config to form data, or explain why it can't be.
 *
 * stdio-vs-http comes from `detectPluginMcpTransport`, so an explicit
 * `type`/`transport` discriminator wins over guessing from `command`/`url` and
 * every spelling of Streamable HTTP classifies the same way the backend's
 * importer classifies it. Env and header VALUES are carried through verbatim:
 * this is the user's own config being loaded into a debugger, not a bundle
 * being persisted.
 */
function toServerFormData(
  name: string,
  config: unknown,
): { ok: true; server: ServerFormData } | { ok: false; error: string } {
  if (!isServerConfigRecord(config)) {
    return { ok: false, error: `Invalid server config for "${name}"` };
  }
  const record = config as unknown as Record<string, unknown>;

  const detected = detectPluginMcpTransport(record, name);
  if (!detected.ok) {
    if (detected.code === "MCP_AMBIGUOUS_TRANSPORT") {
      return {
        ok: false,
        error: `Server "${name}" cannot have both "command" and "url" properties`,
      };
    }
    if (record.type === undefined && record.transport === undefined) {
      return {
        ok: false,
        error: `Server "${name}" must have either "command" or "url" property`,
      };
    }
    return { ok: false, error: `Server "${name}": ${detected.message}` };
  }

  if (detected.transport === "stdio") {
    const command = record.command;
    if (typeof command !== "string" || command.length === 0) {
      return {
        ok: false,
        error: `Server "${name}" must have either "command" or "url" property`,
      };
    }
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const env = stringRecord(record.env);
    return {
      ok: true,
      server: {
        name,
        type: "stdio",
        command,
        args,
        env,
        ...secretPatchFor("env", env),
      },
    };
  }

  const url = record.url;
  if (typeof url !== "string" || url.length === 0) {
    return {
      ok: false,
      error: `Server "${name}" must have either "command" or "url" property`,
    };
  }
  // Headers survive the import, on both the in-memory and the persisted
  // channel. Silently dropping an Authorization header turns an otherwise
  // valid import into a confusing 401 at connect time.
  const headers = stringRecord(record.headers);
  return {
    ok: true,
    server: {
      name,
      type: "http",
      url,
      headers,
      env: {},
      useOAuth: false,
      ...secretPatchFor("headers", headers),
    },
  };
}

/**
 * Formats ServerWithName objects to JSON config format
 * @param serversObj - Record of server names to ServerWithName objects
 * @returns JsonConfig object ready for export
 */
export function formatJsonConfig(
  serversObj: Record<string, ServerWithName>,
): JsonConfig {
  const mcpServers: Record<string, JsonServerConfig> = {};

  for (const [key, server] of Object.entries(serversObj)) {
    const { config } = server;

    // Check if it's an SSE type (has URL) or stdio type (has command)
    if ("url" in config && config.url) {
      mcpServers[key] = {
        type: "sse",
        url: config.url.toString(),
      };
    } else if ("command" in config && config.command) {
      const serverConfig: JsonServerConfig = {
        command: config.command,
        args: config.args || [],
      };

      // Only add env if it exists and has properties
      if (config.env && Object.keys(config.env).length > 0) {
        serverConfig.env = config.env;
      }

      mcpServers[key] = serverConfig;
    } else {
      console.warn(`Skipping server "${key}": missing required url or command`);
    }
  }

  return { mcpServers };
}

/**
 * Parses a JSON config file and converts it to ServerFormData array.
 * Accepts a direct server map, an `mcp_servers` wrapper, or an `mcpServers`
 * wrapper — all three resolve through `resolveJsonServerMap` and then share
 * the same per-server mapping, so identical server configs import identically
 * regardless of wrapper shape.
 * @param jsonContent - The JSON string content
 * @returns Array of ServerFormData objects
 */
export function parseJsonConfig(jsonContent: string): ServerFormData[] {
  try {
    const config: unknown = JSON.parse(jsonContent);

    const resolved = resolveJsonServerMap(config);
    if (!resolved.ok) {
      throw new Error(`Invalid JSON config: ${resolved.error}`);
    }

    const servers: ServerFormData[] = [];

    for (const [serverName, rawServerConfig] of Object.entries(
      resolved.servers,
    )) {
      const mapped = toServerFormData(serverName, rawServerConfig);
      if (!mapped.ok) {
        console.warn(`Skipping server "${serverName}": ${mapped.error}`);
        continue;
      }
      servers.push(mapped.server);
    }

    return servers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid JSON format: " + error.message);
    }
    throw error;
  }
}

/**
 * Validates a JSON config file without parsing it. Accepts the same three
 * shapes as `parseJsonConfig` (shared `resolveJsonServerMap` code path).
 * @param jsonContent - The JSON string content
 * @returns Validation result with success status and error message
 */
export function validateJsonConfig(jsonContent: string): {
  success: boolean;
  error?: string;
} {
  try {
    const config: unknown = JSON.parse(jsonContent);

    const resolved = resolveJsonServerMap(config);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    const serverNames = Object.keys(resolved.servers);
    if (serverNames.length === 0) {
      return {
        success: false,
        error: "No servers found in the configuration",
      };
    }

    // Validate each server config through the SAME mapping `parseJsonConfig`
    // uses, so validation can never accept something the import then skips.
    for (const [serverName, serverConfig] of Object.entries(resolved.servers)) {
      const mapped = toServerFormData(serverName, serverConfig);
      if (!mapped.ok) return { success: false, error: mapped.error };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { success: false, error: "Invalid JSON format: " + error.message };
    }
    return {
      success: false,
      error: "Unknown error: " + (error as Error).message,
    };
  }
}

/**
 * Downloads an object as a formatted JSON file.
 * @param filename - Output filename
 * @param data - Serializable JSON data
 */
export function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
