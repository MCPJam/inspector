/**
 * Agent Plugins 1.0 MCP configuration (`mcp.json` at the bundle root) —
 * https://agent-plugins.org/schemas/1.0.0/mcp.schema.json.
 *
 * The plugin path is spec-strict: the document requires `$schema` +
 * `mcpServers` (closed object); every entry requires an explicit `type`
 * (`stdio` | `streamable-http` | `sse`) — the declared transport is
 * authoritative, never inferred. One invalid entry is skipped (failure
 * isolation), never the whole document; an invalid document disables the
 * MCP component type, never the whole bundle.
 *
 * Secret hygiene: env/header VALUES that look like credentials are never
 * stored (a documented deviation from verbatim pass-through). Screened
 * non-secret literals ARE stored, so `{"MODE": "production"}` works.
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are preserved verbatim for the
 * runtime to expand — only in args, env values, and cwd, per spec.
 *
 * The two policy-free shape primitives (`selectPluginMcpServerMap`,
 * `detectPluginMcpTransport`) keep their lenient behavior: the inspector's
 * generic MCP-JSON import shares them and must keep accepting wrapper
 * variants, spelling variants, and command/url inference.
 */

import {
  isLoopbackHost,
  normalizeEnv,
  normalizeHeaders,
  normalizeOAuthHint,
} from "./mcp-entry-values.js";
import {
  readOpenAiServerAuth,
  withApiKeyHeader,
  type PluginServerAuth,
} from "./openai-auth.js";
import { PluginIssueCollector, type PluginIssueCode } from "./validation.js";
import { resolveContainedPath } from "./paths.js";

/**
 * Canonical MCP-config schema identifiers per Agent Plugins version.
 * Frozen: this map IS the compiled-in allowlist.
 */
export const PLUGIN_MCP_SCHEMAS: Readonly<Record<string, string>> =
  Object.freeze({
    "1.0.0": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  });

export const PLUGIN_ROOT_PLACEHOLDER = "${PLUGIN_ROOT}";
export const PLUGIN_DATA_PLACEHOLDER = "${PLUGIN_DATA}";

/**
 * Placeholders substituted with the materialized bundle root at spawn.
 * `${PLUGIN_DATA}` is deliberately NOT in this list — it resolves to the
 * writable per-plugin data directory, never the bundle root.
 */
export const PLUGIN_ROOT_PLACEHOLDERS = [PLUGIN_ROOT_PLACEHOLDER] as const;

/** Both runtime placeholders, for detection (not substitution). */
export const PLUGIN_PLACEHOLDERS = [
  PLUGIN_ROOT_PLACEHOLDER,
  PLUGIN_DATA_PLACEHOLDER,
] as const;

export function containsRootPlaceholder(value: string): boolean {
  return PLUGIN_ROOT_PLACEHOLDERS.some((placeholder) =>
    value.includes(placeholder)
  );
}

/** Does the value reference either runtime placeholder? */
export function containsPluginPlaceholder(value: string): boolean {
  return PLUGIN_PLACEHOLDERS.some((placeholder) =>
    value.includes(placeholder)
  );
}

const SERVER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Agent Plugins cwd rule: `./…`, `${PLUGIN_ROOT}…`, or `${PLUGIN_DATA}…`. */
const AP_CWD =
  /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

export interface PluginEnvRequirement {
  name: string;
  required: boolean;
  /**
   * Preserved only when the declared value is a PURE placeholder path
   * template (`${PLUGIN_ROOT}/...`, `${PLUGIN_DATA}/...`) or a composite
   * reference template whose literal remainder passed the secret screen.
   * Placeholders are substituted by the runtime at process launch; the
   * parser never does.
   */
  valueTemplate?: string;
  /**
   * A declared literal value that passed the secret screen (non-secret name,
   * non-secret-looking value). Secret-looking literals are never stored —
   * they become name-only setup requirements instead.
   */
  value?: string;
}

export interface PluginHeaderRequirement {
  name: string;
  secret: boolean;
  /** Screened non-secret literal header value, when declared. */
  value?: string;
  /** Set on an API key's header: how the supplied credential is sent. */
  scheme?: "bearer" | "basic" | "custom_header";
}

export interface NormalizedPluginOAuthHint {
  timing?: "on_install" | "on_use";
  scopes?: string[];
  /** Sanitized non-secret extra metadata from the source config. */
  metadata?: Record<string, unknown>;
}

export type NormalizedPluginMcpServer =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      envRequirements: PluginEnvRequirement[];
      workingDirectory?: string;
    }
  | {
      transport: "http";
      /** Declared wire transport — authoritative for the initial connection. */
      httpVariant: "streamable-http" | "sse";
      url: string;
      headerRequirements: PluginHeaderRequirement[];
      oauth?: NormalizedPluginOAuthHint;
      /** OpenAI's typed auth declaration, read under openai-compatible only. */
      auth?: PluginServerAuth;
    };

export interface ParsedPluginServer {
  /** `server:<key>` — stable component identity within the plugin version. */
  componentKey: string;
  /** Declared server name (the map key in the source config). */
  key: string;
  /** Bundle path of the config file the server came from. */
  sourcePath: string;
  config: NormalizedPluginMcpServer;
  /** SHA-256 of the canonical JSON of `config`; filled in by the parser. */
  configHash: string;
}

/** One skipped component, per the spec's failure-isolation boundaries. */
export interface PluginSkippedComponent {
  kind: "server" | "skill" | "mcp-config";
  /** Server key, skill directory name, or the config path. */
  key: string;
  reason: string;
}

const STDIO_KNOWN_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);

/**
 * `oauth` / `authentication` are MCPJam-recognized extension fields (auth
 * timing + scopes hints), not part of the published schema — a documented
 * deviation from the closed entry shape.
 */
const HTTP_KNOWN_FIELDS = new Set([
  "type",
  "url",
  "headers",
  "oauth",
  "authentication",
]);

/**
 * Result of {@link detectPluginMcpTransport}. `ok: false` carries the same
 * stable issue code the strict plugin path reports, so a caller with a
 * different policy can decide for itself whether to skip, warn, or fail.
 */
export type PluginMcpTransportDetection =
  | { ok: true; transport: "stdio" | "http" }
  | { ok: false; code: PluginIssueCode; message: string };

/**
 * Decide whether a single server configuration is stdio or http, from an
 * explicit `type`/`transport` discriminator when present and otherwise from
 * the presence of `command` vs `url`.
 *
 * Pure and policy-free: it reports what the shape says and never applies the
 * plugin path's stricter rules (explicit `type` required, HTTPS, server-key
 * format, secret stripping). The inspector's generic MCP-JSON import shares
 * this function so `type: "streamable_http"`, `sse`, and a bare
 * `command`/`url` are classified identically everywhere. `message` is
 * caller-facing text; the `code` is the stable contract.
 */
export function detectPluginMcpTransport(
  config: unknown,
  serverKey = "server"
): PluginMcpTransportDetection {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      code: "MCP_INVALID_SERVER",
      message: `server "${serverKey}": configuration must be an object`,
    };
  }
  const record = config as Record<string, unknown>;
  const declared = record.type ?? record.transport;
  if (declared !== undefined) {
    if (typeof declared !== "string") {
      return {
        ok: false,
        code: "MCP_UNKNOWN_TRANSPORT",
        message: `server "${serverKey}": transport must be a string`,
      };
    }
    // The MCP spec names the transport "Streamable HTTP" but leaves the
    // config spelling to each implementation, so `streamable-http`,
    // `streamable_http`, and `streamableHttp` are all in the wild. Fold
    // separators away entirely rather than only underscores, so every casing
    // resolves the same. Widening only ADDS accepted spellings — nothing that
    // classified before now fails.
    const normalized = declared.toLowerCase().replace(/[\s_-]/g, "");
    if (normalized === "stdio") return { ok: true, transport: "stdio" };
    if (
      normalized === "http" ||
      normalized === "sse" ||
      normalized === "streamablehttp"
    ) {
      return { ok: true, transport: "http" };
    }
    return {
      ok: false,
      code: "MCP_UNKNOWN_TRANSPORT",
      message: `server "${serverKey}": unknown transport "${declared}"`,
    };
  }
  const hasCommand = record.command !== undefined;
  const hasUrl = record.url !== undefined;
  if (hasCommand && hasUrl) {
    return {
      ok: false,
      code: "MCP_AMBIGUOUS_TRANSPORT",
      message: `server "${serverKey}": declares both "command" and "url"`,
    };
  }
  if (hasCommand) return { ok: true, transport: "stdio" };
  if (hasUrl) return { ok: true, transport: "http" };
  return {
    ok: false,
    code: "MCP_UNKNOWN_TRANSPORT",
    message: `server "${serverKey}": declares neither "command" nor "url"`,
  };
}

/**
 * Strict Agent Plugins entry transports. The declared `type` is authoritative
 * for the initial connection attempt — never inferred, never folded.
 */
type ApDeclaredTransport = "stdio" | "streamable-http" | "sse";

function readDeclaredTransport(
  serverKey: string,
  componentKey: string,
  record: Record<string, unknown>,
  issues: PluginIssueCollector
): ApDeclaredTransport | null {
  const declared = record.type;
  if (declared === "stdio" || declared === "streamable-http" || declared === "sse") {
    return declared;
  }
  issues.error(
    "MCP_UNKNOWN_TRANSPORT",
    declared === undefined
      ? `server "${serverKey}": missing required "type" (stdio | streamable-http | sse)`
      : `server "${serverKey}": unknown transport "${String(declared)}"`,
    { componentKey }
  );
  return null;
}

function normalizeServer(
  serverKey: string,
  sourcePath: string,
  raw: unknown,
  issues: PluginIssueCollector,
  entryExtensions: boolean
): Omit<ParsedPluginServer, "configHash"> | null {
  const componentKey = `server:${serverKey}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.error(
      "MCP_INVALID_SERVER",
      `server "${serverKey}": configuration must be an object`,
      { componentKey }
    );
    return null;
  }
  const record = raw as Record<string, unknown>;

  const declared = readDeclaredTransport(
    serverKey,
    componentKey,
    record,
    issues
  );
  if (declared === null) return null;

  // Closed entry schema: an unknown field invalidates only this entry.
  const knownFields =
    declared === "stdio" ? STDIO_KNOWN_FIELDS : HTTP_KNOWN_FIELDS;
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key) && !(entryExtensions && key === "extensions")) {
      issues.error(
        "MCP_UNKNOWN_FIELD",
        `server "${serverKey}": field "${key}" is not part of the Agent Plugins ${declared} entry schema`,
        { componentKey }
      );
      return null;
    }
  }

  if (declared === "stdio") {
    const declaredCommand = record.command;
    if (typeof declaredCommand !== "string" || declaredCommand.length === 0) {
      issues.error(
        "MCP_MISSING_COMMAND",
        `server "${serverKey}": stdio servers require a non-empty "command"`,
        { componentKey }
      );
      return null;
    }
    let command: string = declaredCommand;
    // Spec: plugin variables expand only in args, env values, and cwd —
    // a placeholder in `command` can never be expanded, so reject the entry.
    if (containsPluginPlaceholder(command)) {
      issues.error(
        "MCP_PLACEHOLDER_IN_COMMAND",
        `server "${serverKey}": placeholders are not expanded in "command"; use a "./" path or a bare command`,
        { componentKey }
      );
      return null;
    }
    // `./` commands resolve against the plugin root with containment (spec).
    // The stored config carries the CANONICAL `${PLUGIN_ROOT}/...` form: a
    // bare relative string would look like an ordinary server config to the
    // runtime and spawn against the host process directory, while the
    // placeholder form routes through materialization and substitutes to the
    // verified bundle path — the only correct resolution.
    if (command.startsWith("./")) {
      const resolved = resolveContainedPath("", command);
      if (!resolved.ok) {
        issues.error(resolved.code, `server "${serverKey}": ${resolved.message}`, {
          componentKey,
        });
        return null;
      }
      command = `${PLUGIN_ROOT_PLACEHOLDER}/${resolved.path}`;
    }
    let args: string[] = [];
    if (record.args !== undefined) {
      if (
        !Array.isArray(record.args) ||
        record.args.some((arg) => typeof arg !== "string")
      ) {
        issues.error(
          "MCP_INVALID_SERVER",
          `server "${serverKey}": "args" must be an array of strings`,
          { componentKey }
        );
        return null;
      }
      args = record.args as string[];
    }
    const envRequirements = normalizeEnv(
      serverKey,
      componentKey,
      record.env,
      issues
    );
    if (envRequirements === null) return null;

    let workingDirectory: string | undefined;
    if (record.cwd !== undefined) {
      const cwd = record.cwd;
      if (typeof cwd !== "string") {
        issues.error(
          "MCP_INVALID_SERVER",
          `server "${serverKey}": "cwd" must be a string`,
          { componentKey }
        );
        return null;
      }
      if (!AP_CWD.test(cwd)) {
        issues.error(
          "MCP_INVALID_WORKING_DIRECTORY",
          `server "${serverKey}": "cwd" must start with "./", "\${PLUGIN_ROOT}", or "\${PLUGIN_DATA}"`,
          { componentKey }
        );
        return null;
      }
      // `./` working directories canonicalize to the `${PLUGIN_ROOT}` form,
      // same as commands: the bare relative string carries no placeholder,
      // so nothing downstream would ever resolve it against the bundle.
      if (cwd.startsWith("./")) {
        if (cwd === "./") {
          workingDirectory = PLUGIN_ROOT_PLACEHOLDER;
        } else {
          const resolved = resolveContainedPath("", cwd);
          if (!resolved.ok) {
            issues.error(
              resolved.code,
              `server "${serverKey}": ${resolved.message}`,
              { componentKey }
            );
            return null;
          }
          workingDirectory = `${PLUGIN_ROOT_PLACEHOLDER}/${resolved.path}`;
        }
      } else {
        workingDirectory = cwd;
      }
    }

    return {
      componentKey,
      key: serverKey,
      sourcePath,
      config: {
        transport: "stdio",
        command,
        args,
        envRequirements,
        ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      },
    };
  }

  // declared === "streamable-http" | "sse"
  const url = record.url;
  if (typeof url !== "string" || url.length === 0) {
    issues.error(
      "MCP_MISSING_URL",
      `server "${serverKey}": ${declared} servers require a non-empty "url"`,
      { componentKey }
    );
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    issues.error(
      "MCP_INVALID_SERVER",
      `server "${serverKey}": "url" is not a valid URL`,
      { componentKey }
    );
    return null;
  }
  if (parsedUrl.protocol !== "https:") {
    if (parsedUrl.protocol === "http:" && isLoopbackHost(parsedUrl.hostname)) {
      issues.warn(
        "MCP_INSECURE_URL_LOCALHOST",
        `server "${serverKey}": plain-HTTP loopback URL only works in local development`,
        { componentKey }
      );
    } else {
      issues.error(
        "MCP_INSECURE_URL",
        `server "${serverKey}": remote MCP servers must use HTTPS`,
        { componentKey }
      );
      return null;
    }
  }
  const headerRequirements = normalizeHeaders(
    serverKey,
    componentKey,
    record.headers,
    issues
  );
  if (headerRequirements === null) return null;

  const hasOAuthHint =
    record.oauth !== undefined || record.authentication !== undefined;
  const oauth = hasOAuthHint
    ? normalizeOAuthHint(serverKey, componentKey, record, issues)
    : undefined;
  const declaredAuth = readOpenAiServerAuth(
    entryExtensions ? record.extensions : undefined,
    { serverKey, componentKey, issues }
  );
  if (declaredAuth.error !== undefined) {
    issues.error(
      "MCP_INVALID_SERVER",
      `server "${serverKey}": ${declaredAuth.error}`,
      { componentKey }
    );
    return null;
  }
  const auth = declaredAuth.auth;

  return {
    componentKey,
    key: serverKey,
    sourcePath,
    config: {
      transport: "http",
      httpVariant: declared,
      url,
      headerRequirements:
        auth?.type === "api_key"
          ? withApiKeyHeader(headerRequirements, auth)
          : headerRequirements,
      ...(oauth !== undefined ? { oauth } : {}),
      ...(auth !== undefined ? { auth } : {}),
    },
  };
}

/** Which wrapper held the server map; `null` = the document IS the map. */
export type PluginMcpWrapperKey = "mcp_servers" | "mcpServers" | null;

export interface PluginMcpServerEntry {
  key: string;
  /**
   * The server's configuration exactly as it appeared in the source document
   * — VALUES INTACT. This is the caller's own input handed back in a uniform
   * shape, not a normalized DTO: it may carry env values, header values, and
   * other credentials. Never persist it or fold it into a hash. Use
   * {@link normalizePluginMcpConfig} when you need the screened form.
   */
  config: unknown;
}

/**
 * Why shape selection failed. Distinct from `code` because several of these
 * share one persisted issue code: `code` is the stable contract the backend
 * stores, `reason` is a typed discriminator a caller can branch on to render
 * its own guidance without matching on message text.
 */
export type PluginMcpSelectionFailureReason =
  | "document-not-an-object"
  | "duplicate-wrapper"
  | "bare-server-config"
  | "server-map-not-an-object";

export type PluginMcpServerMapSelection =
  | { ok: true; wrapperKey: PluginMcpWrapperKey; servers: PluginMcpServerEntry[] }
  | {
      ok: false;
      code: PluginIssueCode;
      reason: PluginMcpSelectionFailureReason;
      message: string;
    };

/**
 * Resolve which of the three compatible document shapes an MCP-JSON config
 * uses — a direct server map, an `mcp_servers` wrapper, or an `mcpServers`
 * wrapper — and return its entries in declaration order.
 *
 * Pure and policy-free: entries come back unfiltered and unvalidated. The
 * inspector's generic MCP-JSON import keeps names/URLs the plugin path
 * rejects, while {@link normalizePluginMcpConfig} layers the strict Agent
 * Plugins rules on top.
 */
export function selectPluginMcpServerMap(
  raw: unknown
): PluginMcpServerMapSelection {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      code: "MCP_INVALID_CONFIG",
      reason: "document-not-an-object",
      message: "MCP configuration must be a JSON object",
    };
  }
  const record = raw as Record<string, unknown>;

  const hasSnake = record.mcp_servers !== undefined;
  const hasCamel = record.mcpServers !== undefined;
  if (hasSnake && hasCamel) {
    return {
      ok: false,
      code: "MCP_DUPLICATE_WRAPPER",
      reason: "duplicate-wrapper",
      message: `configuration declares both "mcp_servers" and "mcpServers"`,
    };
  }

  let wrapperKey: PluginMcpWrapperKey = null;
  let serverMap: unknown = record;
  if (hasSnake) {
    wrapperKey = "mcp_servers";
    serverMap = record.mcp_servers;
  } else if (hasCamel) {
    wrapperKey = "mcpServers";
    serverMap = record.mcpServers;
  } else if (
    typeof record.command === "string" ||
    typeof record.url === "string"
  ) {
    // A single bare server config is not a server map. Only string
    // command/url values indicate that shape — a direct map may legitimately
    // contain a server NAMED "url" or "command" (whose value is an object).
    return {
      ok: false,
      code: "MCP_INVALID_CONFIG",
      reason: "bare-server-config",
      message: "expected a map of server name to configuration",
    };
  }

  if (
    serverMap === null ||
    typeof serverMap !== "object" ||
    Array.isArray(serverMap)
  ) {
    return {
      ok: false,
      code: "MCP_INVALID_CONFIG",
      reason: "server-map-not-an-object",
      message: "server map must be a JSON object",
    };
  }

  return {
    ok: true,
    wrapperKey,
    servers: Object.entries(serverMap as Record<string, unknown>).map(
      ([key, config]) => ({ key, config })
    ),
  };
}

export interface PluginMcpConfigNormalization {
  /** Valid servers, in declaration order (without `configHash`). */
  servers: Array<Omit<ParsedPluginServer, "configHash">>;
  /** Per-entry skips (failure isolation) — never bundle-fatal. */
  skipped: PluginSkippedComponent[];
  /**
   * `null` when the DOCUMENT is invalid (missing/unsupported `$schema`,
   * missing `mcpServers`, unknown top-level field, version mismatch): the
   * MCP component type is disabled; `servers` is empty and the document
   * issue was reported on the parent collector as a warning.
   */
  documentVersion: string | null;
}

/**
 * Normalize a parsed root `mcp.json` document, Agent Plugins-strict.
 *
 * `manifestSchemaVersion` is the version resolved from `plugin.json` —
 * the two documents MUST target the same Agent Plugins version (spec).
 * All failure boundaries are narrow: entry problems skip the entry,
 * document problems disable the component type. Nothing here is
 * bundle-fatal.
 */
export function normalizePluginMcpConfig(
  raw: unknown,
  context: {
    sourcePath: string;
    manifestSchemaVersion: string;
    issues: PluginIssueCollector;
    /**
     * Bundle-level cap on DECLARED `mcpServers` entries. Enforced before
     * entry isolation runs, so a flood of malformed entries cannot bypass
     * the limit or bloat the skipped/warning lists. Emitted as an
     * error-severity issue — the caller's throw makes it bundle-fatal.
     */
    maxServers?: number;
    /** Accept entry `extensions` (OpenAI auth); openai-compatible only. */
    entryExtensions?: boolean;
  }
): PluginMcpConfigNormalization {
  const { sourcePath, manifestSchemaVersion, issues, maxServers } = context;
  const disabled = (
    code: PluginIssueCode,
    message: string
  ): PluginMcpConfigNormalization => {
    issues.warn(code, message, { path: sourcePath });
    issues.warn(
      "COMPONENT_SKIPPED",
      `MCP servers are disabled for this bundle: ${message}`,
      { path: sourcePath }
    );
    return {
      servers: [],
      skipped: [{ kind: "mcp-config", key: sourcePath, reason: message }],
      documentVersion: null,
    };
  };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return disabled("MCP_INVALID_CONFIG", "mcp.json must be a JSON object");
  }
  const record = raw as Record<string, unknown>;

  const schema = record.$schema;
  const documentVersion =
    typeof schema === "string"
      ? Object.keys(PLUGIN_MCP_SCHEMAS).find(
          (version) => PLUGIN_MCP_SCHEMAS[version] === schema
        )
      : undefined;
  if (documentVersion === undefined) {
    return disabled(
      "MCP_UNSUPPORTED_SCHEMA",
      schema === undefined
        ? `mcp.json is missing the required "$schema" field`
        : `mcp.json "$schema" is not a supported Agent Plugins schema: ${String(schema)}`
    );
  }
  if (documentVersion !== manifestSchemaVersion) {
    return disabled(
      "MCP_UNSUPPORTED_SCHEMA",
      `mcp.json targets Agent Plugins ${documentVersion} but plugin.json targets ${manifestSchemaVersion}; versions must match`
    );
  }

  for (const key of Object.keys(record)) {
    if (key !== "$schema" && key !== "mcpServers") {
      return disabled(
        "MCP_INVALID_CONFIG",
        `mcp.json field "${key}" is not part of the Agent Plugins schema`
      );
    }
  }

  const serverMap = record.mcpServers;
  if (
    serverMap === null ||
    serverMap === undefined ||
    typeof serverMap !== "object" ||
    Array.isArray(serverMap)
  ) {
    return disabled(
      "MCP_INVALID_CONFIG",
      `mcp.json requires an "mcpServers" object`
    );
  }

  const declaredKeys = Object.keys(serverMap as Record<string, unknown>);
  if (maxServers !== undefined && declaredKeys.length > maxServers) {
    issues.error(
      "MCP_TOO_MANY_SERVERS",
      `mcp.json declares ${declaredKeys.length} MCP servers; the limit is ${maxServers}`,
      { path: sourcePath }
    );
    return { servers: [], skipped: [], documentVersion };
  }

  const servers: Array<Omit<ParsedPluginServer, "configHash">> = [];
  const skipped: PluginSkippedComponent[] = [];
  const skip = (key: string, scoped: PluginIssueCollector): void => {
    const reason = scoped.firstErrorMessage() ?? "invalid server entry";
    issues.absorbDemoted(scoped);
    issues.warn(
      "COMPONENT_SKIPPED",
      `server "${key}" was skipped: ${reason}`,
      { path: sourcePath, componentKey: `server:${key}` }
    );
    skipped.push({ kind: "server", key, reason });
  };

  for (const [serverKey, config] of Object.entries(
    serverMap as Record<string, unknown>
  )) {
    const scoped = new PluginIssueCollector();
    if (!SERVER_KEY.test(serverKey)) {
      scoped.error(
        "MCP_INVALID_SERVER_NAME",
        `server name "${serverKey}" must match ${SERVER_KEY}`,
        { path: sourcePath }
      );
      skip(serverKey, scoped);
      continue;
    }
    const server = normalizeServer(
      serverKey,
      sourcePath,
      config,
      scoped,
      context.entryExtensions === true
    );
    if (server === null || scoped.hasErrors()) {
      skip(serverKey, scoped);
      continue;
    }
    // Entry-level warnings (omitted values, loopback URLs) survive as-is.
    issues.absorbDemoted(scoped);
    servers.push(server);
  }
  return { servers, skipped, documentVersion };
}
