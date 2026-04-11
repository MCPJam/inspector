import {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  type MCPConformanceConfig,
  MCPConformanceTest,
} from "@mcpjam/sdk";
import { Command } from "commander";
import {
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config";
import {
  setProcessExitCode,
  usageError,
  writeResult,
  type OutputFormat,
} from "../lib/output";

export interface ProtocolConformanceOptions {
  url: string;
  accessToken?: string;
  header?: string[];
  checkTimeout?: number;
  category?: string[];
  checkId?: string[];
}

export function registerProtocolCommands(program: Command): void {
  const protocol = program
    .command("protocol")
    .description("MCP protocol inspection and conformance checks");

  protocol
    .command("conformance")
    .description("Run MCP protocol conformance checks against an HTTP server")
    .requiredOption("--url <url>", "MCP server URL")
    .option("--access-token <token>", "Bearer access token for HTTP servers")
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--check-timeout <ms>",
      "Per-check timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Check timeout"),
      15_000,
    )
    .option(
      "--category <category>",
      "Check category to run. Repeat for multiple. Default: all.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--check-id <id>",
      "Specific check ID to run. Repeat for multiple. Default: all.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action(async (options, command) => {
      const format = getFormat(command);
      const config = buildConfig(options as ProtocolConformanceOptions);
      const result = await new MCPConformanceTest(config).run();

      writeResult(result, format);
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });
}

function getFormat(command: Command): OutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  const value = opts.format ?? "json";
  if (value === "json" || value === "human") {
    return value;
  }
  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}

function collectInvalidEntries(
  values: string[] | undefined,
  allowedValues: readonly string[],
): string[] {
  return (values ?? []).filter((value) => !allowedValues.includes(value));
}

export function buildConfig(
  options: ProtocolConformanceOptions,
): MCPConformanceConfig {
  const serverUrl = options.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw usageError(`Invalid URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`Invalid URL scheme: ${serverUrl}`);
  }

  const customHeaders = parseHeadersOption(options.header);
  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    MCP_CHECK_CATEGORIES,
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1
        ? `Unknown category: ${invalidCategories[0]}`
        : `Unknown categories: ${invalidCategories.join(", ")}`,
    );
  }

  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, MCP_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${invalidCheckIds.length === 1 ? "" : "s"}: ${invalidCheckIds.join(", ")}`,
    );
  }

  return {
    serverUrl,
    accessToken: options.accessToken,
    customHeaders,
    checkTimeout: options.checkTimeout ?? 15_000,
    ...(categories && categories.length > 0
      ? { categories: categories as MCPConformanceConfig["categories"] }
      : {}),
    ...(checkIds && checkIds.length > 0
      ? { checkIds: checkIds as MCPConformanceConfig["checkIds"] }
      : {}),
  };
}
