import { readFileSync } from "node:fs";
import type {
  MCPAppsConformanceSuiteConfig,
  MCPConformanceSuiteConfig,
  OAuthConformanceSuiteConfig,
} from "@mcpjam/sdk";
import {
  isKnownProtocolVersion,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSIONS,
} from "@mcpjam/sdk";
import { usageError } from "./output.js";
import {
  VALID_PROTOCOL_VERSIONS,
  VALID_REGISTRATION_STRATEGIES,
  VALID_AUTH_MODES,
} from "./oauth-enums.js";

type JsonObject = Record<string, unknown>;

function readConfigFile(filePath: string): JsonObject {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw usageError(
      `Cannot read config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw usageError(`Config file "${filePath}" is not valid JSON`);
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw usageError("Config file must be a JSON object");
  }

  return config as JsonObject;
}

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw usageError(`${label} must be a JSON object`);
  }
}

function assertValidUrl(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw usageError(`${label} is required and must be a non-empty string`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}

function assertEnum(
  value: unknown,
  allowed: Set<string>,
  label: string,
): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw usageError(
      `Invalid ${label} "${String(value)}". Allowed: ${[...allowed].join(", ")}`,
    );
  }
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw usageError(`${label} must be a string`);
  }
}

function validateEnumArray(
  value: unknown,
  allowedValues: readonly string[],
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw usageError(`${label} must be an array`);
  }

  for (let index = 0; index < value.length; index += 1) {
    assertEnum(value[index], new Set(allowedValues), `${label}[${index}]`);
  }
}

function validateOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw usageError(`${label} must be an array`);
  }

  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      throw usageError(`${label}[${index}] must be a string`);
    }
  }
}

function validateOptionalStringRecord(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  assertObject(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw usageError(`${label}.${key} must be a string`);
    }
  }
}

/** The only two keys a fixtures block may carry, and the name each entry needs. */
const FIXTURE_COLLECTIONS = [
  ["toolCalls", "toolName"],
  ["promptGets", "promptName"],
] as const;

/**
 * Fixtures name primitives the operator says are SAFE TO EXECUTE, so the
 * validation is deliberately strict about the KEYS and the NAMES, and
 * permissive about the arguments (arbitrary JSON by definition).
 *
 * UNKNOWN KEYS ARE REJECTED, and that is the point rather than tidiness. A
 * misspelled `toolCall` would otherwise be silently ignored, leaving an empty
 * fixture set — and an empty fixture set makes the fixture-gated checks SKIP,
 * which an operator reads as "my server does not support this" rather than "my
 * config has a typo". A config error that presents as a server finding is worse
 * than a loud rejection.
 *
 * Shared with the `--fixtures-file` reader so the two paths cannot drift into
 * disagreeing about what a valid fixtures block is.
 */
export function validateFixtures(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  assertObject(value, label);
  const fixtures = value as JsonObject;

  const known = new Set<string>(FIXTURE_COLLECTIONS.map(([key]) => key));
  const unknown = Object.keys(fixtures).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw usageError(
      `${label} has unknown key${unknown.length === 1 ? "" : "s"} ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}; expected ${[...known].join(" and/or ")}`,
    );
  }

  for (const [key, nameField] of FIXTURE_COLLECTIONS) {
    const entries = fixtures[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      throw usageError(`${label}.${key} must be an array`);
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      assertObject(entry, `${label}.${key}[${index}]`);
      const name = (entry as JsonObject)[nameField];
      if (typeof name !== "string" || name.trim() === "") {
        throw usageError(
          `${label}.${key}[${index}].${nameField} must be a non-empty string`,
        );
      }
    }
  }
}

function validateProtocolRun(run: JsonObject, label: string): void {
  validateOptionalString(run.label, `${label}.label`);
  validateEnumArray(run.categories, MCP_CHECK_CATEGORIES, `${label}.categories`);
  validateEnumArray(run.checkIds, MCP_CHECK_IDS, `${label}.checkIds`);
  validateFixtures(run.fixtures, `${label}.fixtures`);
  if (run.protocolVersion !== undefined) {
    if (
      typeof run.protocolVersion !== "string" ||
      !isKnownProtocolVersion(run.protocolVersion)
    ) {
      throw usageError(
        `Invalid ${label}.protocolVersion "${String(run.protocolVersion)}". Known: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
      );
    }
  }
}

function validateOAuthFlow(
  flow: JsonObject,
  defaults: JsonObject | undefined,
  index: number,
): void {
  validateOptionalString(flow.label, `flows[${index}].label`);

  const protocolVersion = flow.protocolVersion ?? defaults?.protocolVersion;
  if (!protocolVersion) {
    throw usageError(
      `flows[${index}]: protocolVersion is required (not set in flow or defaults)`,
    );
  }
  assertEnum(
    protocolVersion,
    VALID_PROTOCOL_VERSIONS,
    `flows[${index}].protocolVersion`,
  );

  const registrationStrategy =
    flow.registrationStrategy ?? defaults?.registrationStrategy;
  if (!registrationStrategy) {
    throw usageError(
      `flows[${index}]: registrationStrategy is required (not set in flow or defaults)`,
    );
  }
  assertEnum(
    registrationStrategy,
    VALID_REGISTRATION_STRATEGIES,
    `flows[${index}].registrationStrategy`,
  );

  const auth = (flow.auth ?? defaults?.auth) as JsonObject | undefined;
  if (auth?.mode) {
    assertEnum(auth.mode, VALID_AUTH_MODES, `flows[${index}].auth.mode`);
  }
}

function validateAppsTarget(value: unknown, label: string): void {
  assertObject(value, label);

  const hasUrl = typeof value.url === "string" && value.url.trim().length > 0;
  const hasCommand =
    typeof value.command === "string" && value.command.trim().length > 0;

  if (hasUrl === hasCommand) {
    throw usageError(
      `${label} must provide exactly one of "url" or "command"`,
    );
  }

  if (hasUrl) {
    assertValidUrl(value.url, `${label}.url`);
  }

  if (hasCommand) {
    validateOptionalString(value.command, `${label}.command`);
  }

  validateOptionalStringArray(value.args, `${label}.args`);
  validateOptionalStringRecord(value.env, `${label}.env`);
  validateOptionalString(value.cwd, `${label}.cwd`);
}

function validateAppsRun(run: JsonObject, label: string): void {
  validateOptionalString(run.label, `${label}.label`);
  validateEnumArray(run.checkIds, MCP_APPS_CHECK_IDS, `${label}.checkIds`);
}

export function loadOAuthSuiteConfig(
  filePath: string,
): OAuthConformanceSuiteConfig {
  const config = readConfigFile(filePath);

  assertValidUrl(config.serverUrl, "serverUrl");

  const flows = config.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    throw usageError('Config file must have a non-empty "flows" array');
  }

  const defaults = config.defaults;
  if (defaults !== undefined) {
    assertObject(defaults, "defaults");
  }

  for (let index = 0; index < flows.length; index += 1) {
    const flow = flows[index];
    assertObject(flow, `flows[${index}]`);
    validateOAuthFlow(flow, defaults as JsonObject | undefined, index);
  }

  return config as unknown as OAuthConformanceSuiteConfig;
}

export function loadProtocolSuiteConfig(
  filePath: string,
): MCPConformanceSuiteConfig {
  const config = readConfigFile(filePath);

  assertValidUrl(config.serverUrl, "serverUrl");

  const runs = config.runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    throw usageError('Config file must have a non-empty "runs" array');
  }

  if (config.defaults !== undefined) {
    assertObject(config.defaults, "defaults");
    validateProtocolRun(config.defaults as JsonObject, "defaults");
  }

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    assertObject(run, `runs[${index}]`);
    validateProtocolRun(run, `runs[${index}]`);
  }

  return config as unknown as MCPConformanceSuiteConfig;
}

export function loadAppsSuiteConfig(
  filePath: string,
): MCPAppsConformanceSuiteConfig {
  const config = readConfigFile(filePath);

  if (config.name !== undefined) {
    validateOptionalString(config.name, "name");
  }

  if (config.target === undefined) {
    throw usageError('Config file must include a "target" object');
  }
  validateAppsTarget(config.target, "target");

  const runs = config.runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    throw usageError('Config file must have a non-empty "runs" array');
  }

  if (config.defaults !== undefined) {
    assertObject(config.defaults, "defaults");
    validateAppsRun(config.defaults as JsonObject, "defaults");
  }

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    assertObject(run, `runs[${index}]`);
    validateAppsRun(run, `runs[${index}]`);
  }

  return config as unknown as MCPAppsConformanceSuiteConfig;
}

export function loadSuiteConfig(filePath: string): OAuthConformanceSuiteConfig {
  return loadOAuthSuiteConfig(filePath);
}
