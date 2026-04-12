import { readFileSync } from "node:fs";
import type { MCPClientManagerConfig } from "@mcpjam/sdk";
import type { MCPJamReportingConfig } from "@mcpjam/sdk";
import { parseLLMString } from "@mcpjam/sdk";
import { usageError } from "./output";

export interface EvalsTestCase {
  name: string;
  prompt: string;
  expectedToolCalls: string[];
  matchMode?: "exact" | "subset";
}

export interface EvalsAgentConfig {
  model: string;
  apiKey: string;
  systemPrompt?: string;
  maxSteps?: number;
  temperature?: number;
}

export interface EvalsRunOptions {
  iterations: number;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
}

export interface EvalsConfig {
  servers: MCPClientManagerConfig;
  agent: EvalsAgentConfig;
  tests: EvalsTestCase[];
  options?: EvalsRunOptions;
  mcpjam?: MCPJamReportingConfig;
}

/**
 * Recursively walk all string values and replace ${VAR} with process.env.VAR.
 * Throws if a referenced variable is not set.
 */
export function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw usageError(
          `Environment variable "${varName}" is not set (referenced as \${${varName}}).`,
        );
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
}

/**
 * Validate the raw parsed JSON and return a typed EvalsConfig.
 */
export function validateEvalsConfig(raw: unknown): EvalsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw usageError("Evals config must be a JSON object.");
  }

  const config = raw as Record<string, unknown>;

  // servers
  if (
    !config.servers ||
    typeof config.servers !== "object" ||
    Array.isArray(config.servers) ||
    Object.keys(config.servers).length === 0
  ) {
    throw usageError(
      'Evals config must have a non-empty "servers" object.',
    );
  }

  // agent
  if (
    !config.agent ||
    typeof config.agent !== "object" ||
    Array.isArray(config.agent)
  ) {
    throw usageError('Evals config must have an "agent" object.');
  }

  const agent = config.agent as Record<string, unknown>;

  if (typeof agent.model !== "string" || !agent.model) {
    throw usageError('"agent.model" is required and must be a non-empty string.');
  }

  if (typeof agent.apiKey !== "string" || !agent.apiKey) {
    throw usageError('"agent.apiKey" is required and must be a non-empty string.');
  }

  // Validate model string is parseable
  try {
    parseLLMString(agent.model);
  } catch (error) {
    throw usageError(
      `Invalid agent.model: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    agent.systemPrompt !== undefined &&
    typeof agent.systemPrompt !== "string"
  ) {
    throw usageError('"agent.systemPrompt" must be a string.');
  }

  if (agent.maxSteps !== undefined && (typeof agent.maxSteps !== "number" || agent.maxSteps <= 0)) {
    throw usageError('"agent.maxSteps" must be a positive number.');
  }

  if (
    agent.temperature !== undefined &&
    (typeof agent.temperature !== "number" || agent.temperature < 0 || agent.temperature > 2)
  ) {
    throw usageError('"agent.temperature" must be a number between 0 and 2.');
  }

  // tests
  if (!Array.isArray(config.tests) || config.tests.length === 0) {
    throw usageError(
      'Evals config must have a non-empty "tests" array.',
    );
  }

  for (let i = 0; i < config.tests.length; i++) {
    const test = config.tests[i] as Record<string, unknown>;
    const prefix = `tests[${i}]`;

    if (typeof test.name !== "string" || !test.name) {
      throw usageError(`${prefix}.name is required and must be a non-empty string.`);
    }

    if (typeof test.prompt !== "string" || !test.prompt) {
      throw usageError(`${prefix}.prompt is required and must be a non-empty string.`);
    }

    if (!Array.isArray(test.expectedToolCalls) || test.expectedToolCalls.length === 0) {
      throw usageError(`${prefix}.expectedToolCalls is required and must be a non-empty array of strings.`);
    }

    for (const tc of test.expectedToolCalls) {
      if (typeof tc !== "string") {
        throw usageError(`${prefix}.expectedToolCalls must contain only strings.`);
      }
    }

    if (
      test.matchMode !== undefined &&
      test.matchMode !== "exact" &&
      test.matchMode !== "subset"
    ) {
      throw usageError(
        `${prefix}.matchMode must be "exact" or "subset".`,
      );
    }
  }

  // options (optional)
  if (config.options !== undefined) {
    if (typeof config.options !== "object" || Array.isArray(config.options)) {
      throw usageError('"options" must be an object.');
    }
  }

  return config as unknown as EvalsConfig;
}

/**
 * Load, interpolate, and validate an evals config from a JSON file.
 */
export function loadEvalsConfig(filePath: string): EvalsConfig {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw usageError(
      `Cannot read config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw usageError(
      `Invalid JSON in config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const interpolated = interpolateEnvVars(parsed);
  return validateEvalsConfig(interpolated);
}
