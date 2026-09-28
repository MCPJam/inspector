import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MCPServerConfig, SuiteFileServerBinding } from "@mcpjam/sdk";
import {
  detectPluginMcpTransport,
  selectPluginMcpServerMap,
} from "@mcpjam/sdk/plugin-bundle";
import { resolveCredentialsFileAuth } from "./credentials-file.js";
import { cliError, usageError } from "./output.js";
import {
  parseServerConfig,
  type SharedServerTargetOptions,
} from "./server-config.js";

/**
 * Bind a suite file's target servers to local MCP configurations.
 *
 * Per target NAME, the first source that has an entry wins, whole:
 *
 *   1. a named `--server <name=url>` override (or, for a suite with exactly
 *      one target, the shared `--url` / `--command` flags);
 *   2. the explicit `--mcp-config <path>` map;
 *   3. `./.mcp.json`;
 *   4. `./.mcpjam/mcp.json`.
 *
 * Entries are merged by name and never field-merged: credentials and
 * transport always come from ONE source. A lower-precedence file is read only
 * while names remain unresolved, so an unrelated malformed file cannot break
 * a run that never needed it — but a file that IS needed and is malformed
 * fails setup. Only the winning entries are interpolated, and entries for
 * servers the suite does not target are ignored (their processes are never
 * started).
 *
 * Paths are relative to the invocation's working directory, never to the
 * suite file's. A winning entry's relative `cwd` and `credentialsFile` are
 * resolved against the directory of the config file that declared them; a
 * stdio entry without `cwd` runs in the invocation directory.
 */

/** Setup failures exit 4 (see `local-test-exit-code.ts`). */
const SETUP_EXIT_CODE = 4;

export type LocalServerBindingInput = {
  /** The suite's target server names, in authored order. */
  targetNames: readonly string[];
  /** Raw `--server name=url` values. */
  serverOverrides?: readonly string[];
  /** `--mcp-config <path>`. */
  mcpConfigPath?: string;
  /** The shared single-server flags (`--url`, `--command`, auth, …). */
  singleServer?: SharedServerTargetOptions;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Per-request MCP timeout stamped on every resolved config. */
  requestTimeoutMs: number;
};

type ServerOverride = { name: string; url: string };

/**
 * Parse one `--server name=url`. Split on the FIRST `=` only: a URL's query
 * string legitimately contains more of them.
 */
export function parseServerOverride(raw: string): ServerOverride {
  const index = raw.indexOf("=");
  if (index < 1) {
    throw usageError(
      `--server must be "name=url" (received ${JSON.stringify(raw)}).`
    );
  }
  const name = raw.slice(0, index).trim();
  const url = raw.slice(index + 1).trim();
  if (!name) {
    throw usageError(`--server ${JSON.stringify(raw)} has no server name.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw usageError(`--server ${name}: ${JSON.stringify(url)} is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(
      `--server ${name}: only http(s) URLs can be overridden on the command line; bind stdio servers with an MCP config.`
    );
  }
  return { name, url };
}

const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}` — nothing else. No `$VAR`, no `~`, no
 * command substitution, and no shell ever sees the value. An unset `${VAR}`
 * is recorded as missing (by NAME; its value is never printed).
 */
function interpolate(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: Set<string>
): string {
  return value.replace(
    INTERPOLATION,
    (
      _match,
      name: string,
      hasDefault: string | undefined,
      fallback: string | undefined
    ) => {
      const current = env[name];
      if (hasDefault !== undefined) {
        return current !== undefined && current !== ""
          ? current
          : fallback ?? "";
      }
      if (current === undefined) {
        missing.add(name);
        return "";
      }
      return current;
    }
  );
}

type ConfigSource = {
  label: string;
  filePath: string;
  required: boolean;
};

type ConfigMap = Map<string, unknown>;

function readConfigMap(source: ConfigSource): ConfigMap | undefined {
  if (!existsSync(source.filePath)) {
    if (!source.required) return undefined;
    throw cliError(
      "MCP_CONFIG_UNREADABLE",
      `MCP config ${source.filePath} does not exist.`,
      SETUP_EXIT_CODE
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(source.filePath, "utf8"));
  } catch (error) {
    throw cliError(
      "MCP_CONFIG_INVALID",
      `MCP config ${source.filePath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      SETUP_EXIT_CODE
    );
  }
  const selection = selectPluginMcpServerMap(raw);
  if (!selection.ok) {
    throw cliError(
      "MCP_CONFIG_INVALID",
      `MCP config ${source.filePath}: ${selection.message}.`,
      SETUP_EXIT_CODE
    );
  }
  return new Map(selection.servers.map((entry) => [entry.key, entry.config]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(
  value: unknown,
  what: string,
  where: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw cliError(
      "MCP_CONFIG_INVALID",
      `${where}: ${what} must be an object of strings.`,
      SETUP_EXIT_CODE
    );
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw cliError(
        "MCP_CONFIG_INVALID",
        `${where}: ${what}.${key} must be a string.`,
        SETUP_EXIT_CODE
      );
    }
    out[key] = entry;
  }
  return out;
}

/** One winning config-file entry → an `MCPServerConfig`, interpolated. */
function configFromEntry(args: {
  name: string;
  entry: unknown;
  source: ConfigSource;
  env: NodeJS.ProcessEnv;
  invocationCwd: string;
  requestTimeoutMs: number;
}): MCPServerConfig {
  const where = `server "${args.name}" in ${args.source.filePath}`;
  const detected = detectPluginMcpTransport(args.entry, args.name);
  if (!detected.ok) {
    throw cliError(
      "MCP_CONFIG_INVALID",
      `${args.source.filePath}: ${detected.message}.`,
      SETUP_EXIT_CODE
    );
  }
  const entry = args.entry as Record<string, unknown>;
  const configDir = path.dirname(args.source.filePath);
  const missing = new Set<string>();
  const expand = (value: string) => interpolate(value, args.env, missing);

  let config: MCPServerConfig;
  if (detected.transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      throw cliError(
        "MCP_CONFIG_INVALID",
        `${where}: "command" must be a non-empty string.`,
        SETUP_EXIT_CODE
      );
    }
    if (
      entry.args !== undefined &&
      (!Array.isArray(entry.args) ||
        entry.args.some((arg) => typeof arg !== "string"))
    ) {
      throw cliError(
        "MCP_CONFIG_INVALID",
        `${where}: "args" must be an array of strings.`,
        SETUP_EXIT_CODE
      );
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      throw cliError(
        "MCP_CONFIG_INVALID",
        `${where}: "cwd" must be a string.`,
        SETUP_EXIT_CODE
      );
    }
    const envEntries = stringRecord(entry.env, "env", where);
    const cwd = typeof entry.cwd === "string" ? expand(entry.cwd) : undefined;
    config = {
      command: expand(entry.command),
      ...(Array.isArray(entry.args)
        ? { args: (entry.args as string[]).map(expand) }
        : {}),
      ...(envEntries
        ? {
            env: Object.fromEntries(
              Object.entries(envEntries).map(([key, value]) => [
                key,
                expand(value),
              ])
            ),
          }
        : {}),
      // A relative `cwd` belongs to the file that declared it; an absent one
      // is where the command was invoked.
      cwd:
        cwd !== undefined ? path.resolve(configDir, cwd) : args.invocationCwd,
      stderr: "pipe",
      timeout: args.requestTimeoutMs,
    };
  } else {
    if (typeof entry.url !== "string" || entry.url.trim() === "") {
      throw cliError(
        "MCP_CONFIG_INVALID",
        `${where}: "url" must be a non-empty string.`,
        SETUP_EXIT_CODE
      );
    }
    if (
      entry.credentialsFile !== undefined &&
      typeof entry.credentialsFile !== "string"
    ) {
      throw cliError(
        "MCP_CONFIG_INVALID",
        `${where}: "credentialsFile" must be a string.`,
        SETUP_EXIT_CODE
      );
    }
    const url = expand(entry.url);
    const headers = stringRecord(entry.headers, "headers", where);
    const expandedHeaders = headers
      ? Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, expand(value)])
        )
      : undefined;
    const declaredType = String(
      entry.type ?? entry.transport ?? ""
    ).toLowerCase();
    const credentials =
      typeof entry.credentialsFile === "string" && missing.size === 0
        ? resolveCredentialsFileAuth(
            path.resolve(configDir, expand(entry.credentialsFile)),
            url
          )
        : undefined;
    config = {
      url,
      ...(expandedHeaders ? { requestInit: { headers: expandedHeaders } } : {}),
      ...(declaredType === "sse" ? { preferSSE: true } : {}),
      ...(credentials?.accessToken
        ? { accessToken: credentials.accessToken }
        : {}),
      ...(credentials?.refreshToken
        ? { refreshToken: credentials.refreshToken }
        : {}),
      ...(credentials?.clientId ? { clientId: credentials.clientId } : {}),
      ...(credentials?.clientSecret
        ? { clientSecret: credentials.clientSecret }
        : {}),
      timeout: args.requestTimeoutMs,
    } as MCPServerConfig;
    if (missing.size === 0) {
      try {
        new URL(url);
      } catch {
        throw cliError(
          "MCP_CONFIG_INVALID",
          `${where}: "url" is not a URL after interpolation.`,
          SETUP_EXIT_CODE
        );
      }
    }
  }
  if (missing.size > 0) {
    throw cliError(
      "MCP_CONFIG_INTERPOLATION",
      `${where} references unset environment variable(s): ${[...missing].join(
        ", "
      )}. ` + "Set them, or give a default with ${VAR:-default}.",
      SETUP_EXIT_CODE,
      { server: args.name, variables: [...missing] }
    );
  }
  return config;
}

export function resolveLocalServerBindings(
  input: LocalServerBindingInput
): Record<string, SuiteFileServerBinding> {
  const targets = [...input.targetNames];
  const bindings: Record<string, SuiteFileServerBinding> = {};

  // ── 1. command-line bindings ───────────────────────────────────────────────
  const overrides = new Map<string, string>();
  for (const raw of input.serverOverrides ?? []) {
    const override = parseServerOverride(raw);
    if (overrides.has(override.name)) {
      throw usageError(`--server names "${override.name}" more than once.`);
    }
    if (!targets.includes(override.name)) {
      throw usageError(
        `--server names "${
          override.name
        }", which the suite does not target (${targets.join(", ")}).`
      );
    }
    overrides.set(override.name, override.url);
  }
  const single = input.singleServer;
  const hasSingle = Boolean(single?.url?.trim() || single?.command?.trim());
  if (hasSingle) {
    if (targets.length !== 1) {
      throw usageError(
        `--url/--command bind exactly one server, and this suite targets ${targets.length}. ` +
          "Bind each with --server <name=url> or an MCP config entry; one credential is never shared across servers."
      );
    }
    if (overrides.has(targets[0]!)) {
      throw usageError(
        `--server ${targets[0]} and --url/--command both bind "${targets[0]}"; pass one.`
      );
    }
    bindings[targets[0]!] = {
      config: parseServerConfig({ ...single, timeout: input.requestTimeoutMs }),
      source: single?.url?.trim() ? "--url" : "--command",
    };
  } else {
    for (const flag of [
      "accessToken",
      "oauthAccessToken",
      "refreshToken",
      "credentialsFile",
    ] as const) {
      if (single?.[flag]) {
        throw usageError(
          `--${flag.replace(
            /[A-Z]/g,
            (letter) => `-${letter.toLowerCase()}`
          )} applies only together with --url.`
        );
      }
    }
  }
  for (const [name, url] of overrides) {
    bindings[name] = {
      config: { url, timeout: input.requestTimeoutMs } as MCPServerConfig,
      source: "--server",
    };
  }

  // ── 2–4. config files, lowest precedence last ──────────────────────────────
  const sources: ConfigSource[] = [
    ...(input.mcpConfigPath
      ? [
          {
            label: "--mcp-config",
            filePath: path.resolve(input.cwd, input.mcpConfigPath),
            required: true,
          },
        ]
      : []),
    {
      label: ".mcp.json",
      filePath: path.resolve(input.cwd, ".mcp.json"),
      required: false,
    },
    {
      label: ".mcpjam/mcp.json",
      filePath: path.resolve(input.cwd, ".mcpjam", "mcp.json"),
      required: false,
    },
  ];
  for (const source of sources) {
    const unresolved = targets.filter((name) => bindings[name] === undefined);
    // An explicit config is always read — a missing or malformed one is a
    // mistake the caller must hear about — while the conventional files are
    // read only when a name still needs them.
    if (unresolved.length === 0 && !source.required) break;
    const map = readConfigMap(source);
    if (!map) continue;
    for (const name of unresolved) {
      if (!map.has(name)) continue;
      bindings[name] = {
        config: configFromEntry({
          name,
          entry: map.get(name),
          source,
          env: input.env,
          invocationCwd: input.cwd,
          requestTimeoutMs: input.requestTimeoutMs,
        }),
        source: source.label,
      };
    }
  }

  const missing = targets.filter((name) => bindings[name] === undefined);
  if (missing.length > 0) {
    throw cliError(
      "SERVER_BINDING_MISSING",
      `No local configuration for target server(s): ${missing.join(", ")}. ` +
        "Bind each with --server <name=url>, --mcp-config <path>, or an entry in ./.mcp.json or ./.mcpjam/mcp.json.",
      SETUP_EXIT_CODE,
      { missing }
    );
  }
  // Authored order, so the report lists servers the way the suite does.
  return Object.fromEntries(targets.map((name) => [name, bindings[name]!]));
}
