import {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  type MCPConformanceConfig,
  MCPConformanceSuite,
  MCPConformanceTest,
} from "@mcpjam/sdk";
import { Command } from "commander";
import { loadProtocolSuiteConfig } from "../lib/config-file.js";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { parseReporterFormat } from "../lib/reporting.js";
import {
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAccessToken,
} from "../lib/credentials-file.js";
import {
  setProcessExitCode,
  usageError,
} from "../lib/output.js";

export interface ProtocolConformanceOptions {
  url: string;
  accessToken?: string;
  credentialsFile?: string;
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
      "--credentials-file <path>",
      "Load OAuth access token from a file created by oauth login or oauth conformance --credentials-out",
    )
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
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const format = getFormat(command, reporter);
      const config = buildConfig(options as ProtocolConformanceOptions);
      const result = await new MCPConformanceTest(config).run();

      writeConformanceOutput(renderConformanceForCli(result, reporter, format));
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });

  protocol
    .command("conformance-suite")
    .description(
      "Run a matrix of MCP protocol conformance checks from a JSON config file",
    )
    .requiredOption("--config <path>", "Path to JSON config file")
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const format = getFormat(command, reporter);
      const config = loadProtocolSuiteConfig(options.config as string);
      const result = await new MCPConformanceSuite(config).run();

      writeConformanceOutput(renderConformanceForCli(result, reporter, format));
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });
}

function getFormat(
  command: Command,
  reporter: ReturnType<typeof parseReporterFormat>,
): ConformanceOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return resolveConformanceOutputFormatForCli(
    opts.format,
    process.stdout.isTTY,
    reporter,
  );
}

function writeConformanceOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
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
  assertNoCredentialsFileAuthConflicts(options);
  const accessToken = options.credentialsFile
    ? resolveCredentialsFileAccessToken(options.credentialsFile, serverUrl)
    : options.accessToken;
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
    accessToken,
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
