/**
 * MCP configuration normalization (`.mcp.json`).
 *
 * Accepts the three compatible source shapes — a direct server map, an
 * `mcp_servers` wrapper (current OpenAI plugin docs), and an `mcpServers`
 * wrapper (MCPJam/Claude-style) — and normalizes them into one MCPJam-owned
 * discriminated union. Resolved environment/header VALUES are never stored:
 * the normalized shape carries requirement names only. `${PLUGIN_ROOT}` /
 * `${CODEX_PLUGIN_ROOT}` are recognized as runtime placeholders and preserved
 * verbatim, never substituted at parse time.
 */

import {
  SECRET_FIELD_NAME,
  sanitizeUnknownRecord,
  type PluginIssueCollector,
} from "./validation.js";

export const PLUGIN_ROOT_PLACEHOLDERS = [
  "${PLUGIN_ROOT}",
  "${CODEX_PLUGIN_ROOT}",
] as const;

export function containsRootPlaceholder(value: string): boolean {
  return PLUGIN_ROOT_PLACEHOLDERS.some((placeholder) =>
    value.includes(placeholder)
  );
}

/** `${SOME_VAR}`-style reference that must be resolved by the user at setup. */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Every `${VAR}` reference inside a composite value. */
const ENV_REFERENCE_GLOBAL = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A PURE plugin-root path template: the placeholder itself, optionally
 * followed by a path-y remainder. Anything else — including a secret with a
 * placeholder smuggled onto the end ("sk-live-...${PLUGIN_ROOT}") — takes
 * the normal literal-value path and is never stored.
 */
const PURE_ROOT_TEMPLATE =
  /^\$\{(?:PLUGIN_ROOT|CODEX_PLUGIN_ROOT)\}[A-Za-z0-9._/-]*$/;

const ROOT_PLACEHOLDER_VARS = new Set(["PLUGIN_ROOT", "CODEX_PLUGIN_ROOT"]);

/**
 * Characters allowed in the non-reference remainder of a composite template
 * ("postgres://${DB_HOST}:${DB_PORT}/x"). A remainder outside this set, or
 * one containing a long opaque token run, looks like an embedded credential:
 * the template is then dropped instead of stored.
 */
const TEMPLATE_SAFE_REMAINDER = /^[A-Za-z0-9.:/@,+_-]*$/;
const LONG_TOKEN_RUN = /[A-Za-z0-9_-]{16,}/;

/** Header names that carry credentials (drives `secret: true`). */
const SECRET_HEADER_NAME =
  /(authorization|token|secret|api[-_]?key|cookie|password|credential)/i;

const SERVER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export interface PluginEnvRequirement {
  name: string;
  required: boolean;
  /**
   * Preserved only when the declared value is a PURE plugin-root path
   * template (`${PLUGIN_ROOT}/...`) or a composite reference template whose
   * literal remainder passed the secret screen
   * (`postgres://${DB_HOST}:${DB_PORT}/x`). Placeholders are substituted by
   * the runtime at process launch; the parser never does, and any value that
   * fails the screen is dropped entirely.
   */
  valueTemplate?: string;
}

export interface PluginHeaderRequirement {
  name: string;
  secret: boolean;
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
      url: string;
      headerRequirements: PluginHeaderRequirement[];
      oauth?: NormalizedPluginOAuthHint;
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
  /** Unknown, non-secret source fields preserved for round-tripping. */
  extensions: Record<string, unknown>;
}

const STDIO_KNOWN_FIELDS = new Set([
  "type",
  "transport",
  "command",
  "args",
  "env",
  "cwd",
  "working_directory",
  "workingDirectory",
]);

const HTTP_KNOWN_FIELDS = new Set([
  "type",
  "transport",
  "url",
  "headers",
  "oauth",
  "authentication",
]);

function normalizeEnv(
  serverKey: string,
  componentKey: string,
  env: unknown,
  issues: PluginIssueCollector
): PluginEnvRequirement[] | null {
  if (env === undefined) return [];
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    issues.error(
      "MCP_INVALID_ENV",
      `server "${serverKey}": "env" must be an object`,
      { componentKey }
    );
    return null;
  }
  const byNameMap = new Map<string, PluginEnvRequirement>();
  const referencedVars = new Set<string>();
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== "string") {
      issues.error(
        "MCP_INVALID_ENV",
        `server "${serverKey}": env "${name}" must be a string`,
        { componentKey }
      );
      continue;
    }
    if (PURE_ROOT_TEMPLATE.test(value)) {
      // Pure path template resolved by the runtime at launch — not a secret.
      byNameMap.set(name, { name, required: false, valueTemplate: value });
      continue;
    }
    if (value === "" || ENV_REFERENCE.test(value)) {
      byNameMap.set(name, { name, required: true });
      continue;
    }
    const refs = [...value.matchAll(ENV_REFERENCE_GLOBAL)]
      .map((match) => match[1])
      .filter((variable) => !ROOT_PLACEHOLDER_VARS.has(variable));
    if (refs.length > 0) {
      // Composite template ("postgres://${DB_HOST}:${DB_PORT}/x"): store it
      // with placeholders preserved only when the literal remainder cannot
      // plausibly be a credential; always register the referenced variables
      // as required setup.
      const remainder = value.replace(ENV_REFERENCE_GLOBAL, "");
      const safeRemainder =
        TEMPLATE_SAFE_REMAINDER.test(remainder) &&
        !LONG_TOKEN_RUN.test(remainder) &&
        !SECRET_FIELD_NAME.test(name);
      if (safeRemainder) {
        byNameMap.set(name, { name, required: false, valueTemplate: value });
        for (const variable of refs) referencedVars.add(variable);
        continue;
      }
    }
    // A resolved literal value (or a value with a placeholder smuggled into
    // a secret-looking string). Never persist it — it may be a credential.
    byNameMap.set(name, { name, required: false });
    issues.warn(
      "MCP_ENV_VALUE_OMITTED",
      `server "${serverKey}": literal value of env "${name}" is not stored; configure it during setup`,
      { componentKey }
    );
  }
  for (const variable of referencedVars) {
    if (!byNameMap.has(variable)) {
      byNameMap.set(variable, { name: variable, required: true });
    }
  }
  // Sorted so the configHash is insensitive to source key order.
  return [...byNameMap.values()].sort(byName);
}

function normalizeHeaders(
  serverKey: string,
  componentKey: string,
  headers: unknown,
  issues: PluginIssueCollector
): PluginHeaderRequirement[] | null {
  if (headers === undefined) return [];
  if (
    headers === null ||
    typeof headers !== "object" ||
    Array.isArray(headers)
  ) {
    issues.error(
      "MCP_INVALID_HEADERS",
      `server "${serverKey}": "headers" must be an object`,
      { componentKey }
    );
    return null;
  }
  const requirements: PluginHeaderRequirement[] = [];
  for (const [name, value] of Object.entries(
    headers as Record<string, unknown>
  )) {
    if (typeof value !== "string") {
      issues.error(
        "MCP_INVALID_HEADERS",
        `server "${serverKey}": header "${name}" must be a string`,
        { componentKey }
      );
      continue;
    }
    if (value !== "" && !ENV_REFERENCE.test(value)) {
      issues.warn(
        "MCP_HEADER_VALUE_OMITTED",
        `server "${serverKey}": literal value of header "${name}" is not stored; configure it during setup`,
        { componentKey }
      );
    }
    requirements.push({ name, secret: SECRET_HEADER_NAME.test(name) });
  }
  // Sorted so the configHash is insensitive to source key order.
  return requirements.sort(byName);
}

function normalizeOAuthHint(
  serverKey: string,
  componentKey: string,
  raw: Record<string, unknown>,
  issues: PluginIssueCollector
): NormalizedPluginOAuthHint {
  const hint: NormalizedPluginOAuthHint = {};

  const authentication = raw.authentication;
  if (typeof authentication === "string") {
    const timing = authentication.toLowerCase();
    if (timing === "on_install") hint.timing = "on_install";
    else if (timing === "on_use") hint.timing = "on_use";
  }

  const oauth =
    raw.oauth ??
    (typeof authentication === "object" ? authentication : undefined);
  if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
    const oauthRecord = oauth as Record<string, unknown>;
    const scopes = oauthRecord.scopes;
    if (
      Array.isArray(scopes) &&
      scopes.every((scope) => typeof scope === "string")
    ) {
      hint.scopes = scopes as string[];
    }
    const candidates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(oauthRecord)) {
      if (key === "scopes") continue;
      candidates[key] = value;
    }
    // Recursive sanitation: this metadata lands in the hashed config DTO, so
    // no secret-looking key OR value at any depth may survive.
    const metadata = sanitizeUnknownRecord(candidates, {
      issues,
      secretCode: "MCP_SECRET_FIELD_OMITTED",
      label: `server "${serverKey}": oauth`,
      context: { componentKey },
    });
    if (Object.keys(metadata).length > 0) hint.metadata = metadata;
  }

  return hint;
}

function detectTransport(
  serverKey: string,
  componentKey: string,
  record: Record<string, unknown>,
  issues: PluginIssueCollector
): "stdio" | "http" | null {
  const declared = record.type ?? record.transport;
  if (declared !== undefined) {
    if (typeof declared !== "string") {
      issues.error(
        "MCP_UNKNOWN_TRANSPORT",
        `server "${serverKey}": transport must be a string`,
        { componentKey }
      );
      return null;
    }
    const normalized = declared.toLowerCase().replace(/_/g, "-");
    if (normalized === "stdio") return "stdio";
    if (
      normalized === "http" ||
      normalized === "sse" ||
      normalized === "streamable-http"
    ) {
      return "http";
    }
    issues.error(
      "MCP_UNKNOWN_TRANSPORT",
      `server "${serverKey}": unknown transport "${declared}"`,
      { componentKey }
    );
    return null;
  }
  const hasCommand = record.command !== undefined;
  const hasUrl = record.url !== undefined;
  if (hasCommand && hasUrl) {
    issues.error(
      "MCP_AMBIGUOUS_TRANSPORT",
      `server "${serverKey}": declares both "command" and "url"`,
      { componentKey }
    );
    return null;
  }
  if (hasCommand) return "stdio";
  if (hasUrl) return "http";
  issues.error(
    "MCP_UNKNOWN_TRANSPORT",
    `server "${serverKey}": declares neither "command" nor "url"`,
    { componentKey }
  );
  return null;
}

function normalizeServer(
  serverKey: string,
  sourcePath: string,
  raw: unknown,
  issues: PluginIssueCollector
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

  const transport = detectTransport(serverKey, componentKey, record, issues);
  if (transport === null) return null;

  const knownFields =
    transport === "stdio" ? STDIO_KNOWN_FIELDS : HTTP_KNOWN_FIELDS;
  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (knownFields.has(key)) continue;
    unknownFields[key] = value;
  }
  // Recursive sanitation of unknown fields: secret-looking keys and values
  // are dropped at every depth before anything reaches the stored DTO.
  const extensions = sanitizeUnknownRecord(unknownFields, {
    issues,
    secretCode: "MCP_SECRET_FIELD_OMITTED",
    label: `server "${serverKey}"`,
    context: { componentKey },
  });
  for (const key of Object.keys(extensions)) {
    issues.warn(
      "MCP_UNKNOWN_FIELD",
      `server "${serverKey}": field "${key}" is not recognized; preserved in extensions`,
      { componentKey }
    );
  }

  if (transport === "stdio") {
    const command = record.command;
    if (typeof command !== "string" || command.length === 0) {
      issues.error(
        "MCP_MISSING_COMMAND",
        `server "${serverKey}": stdio servers require a non-empty "command"`,
        { componentKey }
      );
      return null;
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
    const cwd =
      record.cwd ?? record.working_directory ?? record.workingDirectory;
    if (cwd !== undefined) {
      if (typeof cwd !== "string") {
        issues.error(
          "MCP_INVALID_SERVER",
          `server "${serverKey}": working directory must be a string`,
          { componentKey }
        );
        return null;
      }
      if (
        (cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd)) &&
        !containsRootPlaceholder(cwd)
      ) {
        issues.error(
          "MCP_ABSOLUTE_WORKING_DIRECTORY",
          `server "${serverKey}": working directory must be plugin-root-relative or use \${PLUGIN_ROOT}`,
          { componentKey }
        );
        return null;
      }
      workingDirectory = cwd;
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
      extensions,
    };
  }

  // transport === "http"
  const url = record.url;
  if (typeof url !== "string" || url.length === 0) {
    issues.error(
      "MCP_MISSING_URL",
      `server "${serverKey}": http servers require a non-empty "url"`,
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
    const isLoopback =
      parsedUrl.protocol === "http:" &&
      (parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname === "127.0.0.1" ||
        parsedUrl.hostname === "[::1]" ||
        parsedUrl.hostname === "::1");
    if (isLoopback) {
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

  return {
    componentKey,
    key: serverKey,
    sourcePath,
    config: {
      transport: "http",
      url,
      headerRequirements,
      ...(oauth !== undefined ? { oauth } : {}),
    },
    extensions,
  };
}

/**
 * Normalize a parsed `.mcp.json` document. Returns the normalized servers
 * (without `configHash`, which the parser computes) in declaration order.
 */
export function normalizePluginMcpConfig(
  raw: unknown,
  context: { sourcePath: string; issues: PluginIssueCollector }
): Array<Omit<ParsedPluginServer, "configHash">> {
  const { sourcePath, issues } = context;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.error(
      "MCP_INVALID_CONFIG",
      "MCP configuration must be a JSON object",
      { path: sourcePath }
    );
    return [];
  }
  const record = raw as Record<string, unknown>;

  const hasSnake = record.mcp_servers !== undefined;
  const hasCamel = record.mcpServers !== undefined;
  if (hasSnake && hasCamel) {
    issues.error(
      "MCP_DUPLICATE_WRAPPER",
      `configuration declares both "mcp_servers" and "mcpServers"`,
      { path: sourcePath }
    );
    return [];
  }

  let serverMap: unknown = record;
  if (hasSnake) serverMap = record.mcp_servers;
  else if (hasCamel) serverMap = record.mcpServers;
  else if (
    typeof record.command === "string" ||
    typeof record.url === "string"
  ) {
    // A single bare server config is not a server map. Only string
    // command/url values indicate that shape — a direct map may legitimately
    // contain a server NAMED "url" or "command" (whose value is an object).
    issues.error(
      "MCP_INVALID_CONFIG",
      "expected a map of server name to configuration",
      { path: sourcePath }
    );
    return [];
  }

  if (
    serverMap === null ||
    typeof serverMap !== "object" ||
    Array.isArray(serverMap)
  ) {
    issues.error("MCP_INVALID_CONFIG", "server map must be a JSON object", {
      path: sourcePath,
    });
    return [];
  }

  const servers: Array<Omit<ParsedPluginServer, "configHash">> = [];
  for (const [serverKey, config] of Object.entries(
    serverMap as Record<string, unknown>
  )) {
    if (!SERVER_KEY.test(serverKey)) {
      issues.error(
        "MCP_INVALID_SERVER_NAME",
        `server name "${serverKey}" must match ${SERVER_KEY}`,
        { path: sourcePath }
      );
      continue;
    }
    const server = normalizeServer(serverKey, sourcePath, config, issues);
    if (server !== null) servers.push(server);
  }
  return servers;
}
