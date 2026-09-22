import {
  conformanceExitCode,
  conformanceSuiteExitCode,
  reportIncomplete,
  reportProfile,
  reportReadiness,
  reportScore,
} from "../lib/conformance-exit-code.js";
import {
  isKnownProtocolVersion,
  scoreFromProtocolResult,
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSIONS,
  type MCPConformanceConfig,
  MCPConformanceSuite,
  MCPConformanceTest,
} from "@mcpjam/sdk";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  loadProtocolSuiteConfig,
  validateFixtures,
} from "../lib/config-file.js";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { maybeUploadSingleSuite } from "../lib/conformance-upload.js";
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
  protocolVersion?: string;
  fixturesFile?: string;
  fixtureTool?: string[];
  fixturePrompt?: string[];
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
      "--protocol-version <version>",
      "Pin the MCP protocol version to conform against. Default: legacy (2025-era) behavior.",
    )
    .option(
      "--fixtures-file <path>",
      'JSON file naming primitives that are SAFE TO EXECUTE, so checks that need a real result can run: {"toolCalls":[{"toolName":"echo","arguments":{}}],"promptGets":[{"promptName":"welcome"}]}. Nothing is ever called without this.',
    )
    .option(
      "--fixture-tool <name>",
      "Name of a tool that is safe to call with no arguments. Repeat for multiple. For tools that need arguments, use --fixtures-file.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--fixture-prompt <name>",
      "Name of a prompt that is safe to render with no arguments. Repeat for multiple. For prompts that need arguments, use --fixtures-file.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .option("--upload", "Upload this suite's result into MCPJam run history")
    .option(
      "--require-upload",
      "Fail if reporting is configured but the UI record cannot be written",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const format = getFormat(command, reporter);
      const config = buildConfig(options as ProtocolConformanceOptions);
      const result = await new MCPConformanceTest(config).run();

      writeConformanceOutput(renderConformanceForCli(result, reporter, format));
      // The JSON payload carries all three too, but a human running this in a
      // terminal must not have to dig for the number, the reason a check
      // never ran, or the advice the run produced.
      reportScore(scoreFromProtocolResult(result), command);
      reportProfile(result, command);
      reportReadiness(result, command);
      reportIncomplete(result, command);
      await maybeUploadSingleSuite({
        suiteKind: "protocol",
        result,
        serverUrl: config.serverUrl,
        upload: Boolean((options as { upload?: boolean }).upload),
        requireUpload: Boolean((options as { requireUpload?: boolean }).requireUpload),
        command,
      });
      const exitCode = conformanceExitCode(result);
      if (exitCode !== 0) {
        setProcessExitCode(exitCode);
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
      // Each run carries its own score and reasons — a suite's runs usually
      // pin different revisions, so per-run lines are the actionable ones.
      for (const run of result.results) {
        reportScore(scoreFromProtocolResult(run), command, run.label);
        reportReadiness(run, command);
        reportIncomplete(run, command);
      }
      const exitCode = conformanceSuiteExitCode(result.results);
      if (exitCode !== 0) {
        setProcessExitCode(exitCode);
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

/**
 * Merge the two ways an operator declares safe-to-execute primitives.
 *
 * `--fixture-tool NAME` covers the common case (a read-only tool taking no
 * arguments) without making anyone write JSON on a command line;
 * `--fixtures-file` covers everything else, because arguments are arbitrary
 * JSON and a flag syntax for them would be a parser nobody asked for.
 *
 * Returns `undefined` when neither was supplied, so the SDK sees no `fixtures`
 * key at all and the default run keeps behaving exactly as it did: nothing on
 * the server is ever executed.
 */
function resolveFixtures(
  options: ProtocolConformanceOptions,
): MCPConformanceConfig["fixtures"] | undefined {
  const fromFile = options.fixturesFile
    ? readFixturesFile(options.fixturesFile)
    : undefined;

  const toolCalls = [
    ...(fromFile?.toolCalls ?? []),
    ...(options.fixtureTool ?? [])
      .filter(Boolean)
      .map((toolName) => ({ toolName })),
  ];
  const promptGets = [
    ...(fromFile?.promptGets ?? []),
    ...(options.fixturePrompt ?? [])
      .filter(Boolean)
      .map((promptName) => ({ promptName })),
  ];

  if (toolCalls.length === 0 && promptGets.length === 0) {
    return undefined;
  }
  return { toolCalls, promptGets };
}

function readFixturesFile(
  path: string,
): NonNullable<MCPConformanceConfig["fixtures"]> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw usageError(
      `Could not read fixtures file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw usageError(
      `Fixtures file ${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(
      `Fixtures file ${path} must contain a JSON object with toolCalls and/or promptGets`,
    );
  }

  // Validated with the SAME rule the suite-config path uses, rather than a
  // second hand-rolled one here: an unknown key is REJECTED (a typo'd
  // `toolCall` would otherwise yield an empty fixture set, and an empty set
  // makes the fixture-gated checks skip — which reads as "my server does not
  // support this" rather than "my config has a typo"), and every entry must be
  // an object naming a non-empty primitive.
  validateFixtures(parsed, `Fixtures file ${path}`);

  const document = parsed as {
    toolCalls?: unknown;
    promptGets?: unknown;
  };

  return {
    toolCalls: (document.toolCalls ?? []) as NonNullable<
      MCPConformanceConfig["fixtures"]
    >["toolCalls"],
    promptGets: (document.promptGets ?? []) as NonNullable<
      MCPConformanceConfig["fixtures"]
    >["promptGets"],
  };
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

  const fixtures = resolveFixtures(options);

  const protocolVersion = options.protocolVersion?.trim();
  if (
    options.protocolVersion !== undefined &&
    (!protocolVersion || !isKnownProtocolVersion(protocolVersion))
  ) {
    throw usageError(
      `Unknown protocol version: ${protocolVersion ?? ""}. Known: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
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
    ...(protocolVersion
      ? { protocolVersion: protocolVersion as MCPConformanceConfig["protocolVersion"] }
      : {}),
    ...(fixtures ? { fixtures } : {}),
  };
}
