import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { config as loadDotenv } from "dotenv";
import { Logger } from "../utils/logger.js";
import { runEvals } from "./runner.js";
import { hogClient } from "../utils/hog.js";
import { getUserId } from "../utils/user-id.js";

// node dist/index.js evals run -t examples/test-servers.json -e examples/mcp-environment.json

export const evalsCommand = new Command("evals");

/**
 * Substitutes {{ENV_VAR}} placeholders in a string with actual environment variable values
 * Throws an error if any required environment variable is not found
 */
function substituteEnvVars(text: string): string {
  const missingVars: string[] = [];

  const result = text.replace(/\{\{([^}]+)\}\}/g, (match, envVarName) => {
    const trimmedName = envVarName.trim();
    const value = process.env[trimmedName];
    if (value === undefined) {
      missingVars.push(trimmedName);
      return match;
    }
    return value;
  });

  if (missingVars.length > 0) {
    const varList = missingVars.map((v) => `  - ${v}`).join("\n");
    throw new Error(
      `Missing required environment variables:\n${varList}\n\nPlease set these variables in your .env file or environment.`,
    );
  }

  return result;
}

/**
 * Recursively substitutes environment variables in an object
 */
function substituteEnvVarsInObject(obj: any): any {
  if (typeof obj === "string") {
    return substituteEnvVars(obj);
  } else if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsInObject);
  } else if (obj !== null && typeof obj === "object") {
    const result: any = {};
    for (const key in obj) {
      result[key] = substituteEnvVarsInObject(obj[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Auto-detects LLM API keys from environment variables
 */
function autoDetectLLMKeys(): Record<string, string> {
  const llms: Record<string, string> = {};

  // Check for common LLM API key environment variables
  if (process.env.ANTHROPIC_API_KEY) {
    llms.anthropic = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    llms.openai = process.env.OPENAI_API_KEY;
  }
  if (process.env.OPENROUTER_API_KEY) {
    llms.openrouter = process.env.OPENROUTER_API_KEY;
  }

  return llms;
}

evalsCommand
  .description("Run MCP evaluations")
  .command("run")
  .description("Run tests against MCP servers")
  .requiredOption("-t, --tests <file>", "Path to tests JSON file")
  .requiredOption("-e, --environment <file>", "Path to environment JSON file")
  .option(
    "-l, --llms <file>",
    "Path to LLMs JSON file (optional, auto-detects from env vars)",
  )
  .option(
    "--env-file <file>",
    "Path to .env file (default: .env in current directory)",
  )
  .option("-a, --api-key <key>", "Personal access key")
  .action(async (options) => {
    try {
      // Load .env file if specified, otherwise try to load from current directory
      const envFilePath = options.envFile
        ? resolve(options.envFile)
        : undefined;
      const dotenvResult = loadDotenv({ path: envFilePath });

      if (dotenvResult.error && options.envFile) {
        // Only warn if user explicitly specified an env file that doesn't exist
        Logger.warn(`Could not load env file: ${options.envFile}`);
      } else if (!dotenvResult.error && dotenvResult.parsed) {
        const loadedKeys = Object.keys(dotenvResult.parsed);
        if (loadedKeys.length > 0) {
          Logger.info(
            `Loaded ${loadedKeys.length} variables from ${envFilePath || ".env"}`,
          );
        }
      }

      hogClient.capture({
        distinctId: getUserId(),
        event: "evals cli ran",
        properties: {
          environment: process.env.ENVIRONMENT,
        },
      });
      const testsContent = await readFile(resolve(options.tests), "utf8");
      const testsData = JSON.parse(testsContent);

      // Read and parse environment file with env var substitution
      const envContent = await readFile(resolve(options.environment), "utf8");
      const envData = substituteEnvVarsInObject(JSON.parse(envContent));

      // Read and parse LLMs file OR auto-detect from environment
      let llmsData: Record<string, string>;
      if (options.llms) {
        const llmsContent = await readFile(resolve(options.llms), "utf8");
        llmsData = JSON.parse(llmsContent);
      } else {
        llmsData = autoDetectLLMKeys();
        if (Object.keys(llmsData).length === 0) {
          Logger.warn(
            "No LLM API keys found in environment. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY",
          );
        } else {
          Logger.info(
            `Auto-detected LLM keys: ${Object.keys(llmsData).join(", ")}`,
          );
        }
      }

      // Read API token (optional)
      const apiKey = options.apiKey;
      runEvals(testsData, envData, llmsData, apiKey);
    } catch (error) {
      Logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
