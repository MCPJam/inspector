import { readFileSync } from "node:fs";
import type { OAuthConformanceSuiteConfig } from "@mcpjam/sdk";
import { usageError } from "./output";
import {
  VALID_PROTOCOL_VERSIONS,
  VALID_REGISTRATION_STRATEGIES,
  VALID_AUTH_MODES,
} from "./oauth-enums";

function assertValidUrl(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw usageError(`${label} is required and must be a non-empty string`);
  }
  try {
    new URL(value);
  } catch {
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

function validateFlow(
  flow: Record<string, unknown>,
  defaults: Record<string, unknown> | undefined,
  index: number,
): void {
  const protocolVersion = flow.protocolVersion ?? defaults?.protocolVersion;
  if (!protocolVersion) {
    throw usageError(
      `flows[${index}]: protocolVersion is required (not set in flow or defaults)`,
    );
  }
  assertEnum(protocolVersion, VALID_PROTOCOL_VERSIONS, `flows[${index}].protocolVersion`);

  const registrationStrategy = flow.registrationStrategy ?? defaults?.registrationStrategy;
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

  const auth = (flow.auth ?? defaults?.auth) as Record<string, unknown> | undefined;
  if (auth?.mode) {
    assertEnum(auth.mode, VALID_AUTH_MODES, `flows[${index}].auth.mode`);
  }
}

export function loadSuiteConfig(filePath: string): OAuthConformanceSuiteConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw usageError(
      `Cannot read config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch {
    throw usageError(`Config file "${filePath}" is not valid JSON`);
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw usageError("Config file must be a JSON object");
  }

  assertValidUrl(config.serverUrl, "serverUrl");

  const flows = config.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    throw usageError("Config file must have a non-empty \"flows\" array");
  }

  const defaults = config.defaults as Record<string, unknown> | undefined;

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    if (typeof flow !== "object" || flow === null || Array.isArray(flow)) {
      throw usageError(`flows[${i}] must be an object`);
    }
    validateFlow(flow as Record<string, unknown>, defaults, i);
  }

  return config as unknown as OAuthConformanceSuiteConfig;
}
