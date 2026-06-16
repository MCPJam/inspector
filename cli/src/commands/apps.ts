import { Command } from "commander";
import {
  MCP_APPS_CHECK_CATEGORIES,
  MCP_APPS_CHECK_IDS,
  MCPAppsConformanceSuite,
  MCPAppsConformanceTest,
  type MCPAppsCheckCategory,
  type MCPAppsCheckId,
  type MCPAppsConformanceConfig,
} from "@mcpjam/sdk";
import { loadAppsSuiteConfig } from "../lib/config-file.js";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { parseReporterFormat, type ReporterFormat } from "../lib/reporting.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parseServerConfig,
  resolveAliasedStringOption,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";
import { buildInspectorServerName } from "../lib/inspector-render.js";
import { writeBinaryArtifact } from "../lib/debug-artifact.js";
import {
  buildWidgetRenderOutput,
  parseWidgetRenderViewport,
  resolveWidgetRenderInjectOpenAiCompat,
  runWidgetRender,
} from "../lib/widget-render.js";
import {
  buildWidgetSessionActionOutput,
  buildWidgetSessionStartOutput,
  parseBrowserActionSpec,
  runWidgetSessionAction,
  runWidgetSessionClose,
  runWidgetSessionStart,
} from "../lib/widget-session.js";

const APPS_CHECK_IDS_BY_CATEGORY: Record<
  MCPAppsCheckCategory,
  readonly MCPAppsCheckId[]
> = {
  tools: [
    "ui-tools-present",
    "ui-tool-metadata-valid",
    "ui-tool-input-schema-valid",
  ],
  resources: [
    "ui-listed-resources-valid",
    "ui-resources-readable",
    "ui-resource-contents-valid",
    "ui-resource-meta-valid",
  ],
};

export interface AppsConformanceOptions extends SharedServerTargetOptions {
  category?: string[];
  checkId?: string[];
}

export interface AppsRenderOptions extends SharedServerTargetOptions {
  toolName?: string;
  name?: string;
  toolArgs?: string;
  params?: string;
  toolArgsStdin?: boolean;
  screenshotOut?: string;
  screenshotBase64?: boolean;
  viewport?: string;
  protocol?: string;
  serverName?: string;
  inspectorUrl?: string;
  requireRender?: boolean;
}

export interface AppsSessionStartOptions extends SharedServerTargetOptions {
  toolName?: string;
  name?: string;
  toolArgs?: string;
  params?: string;
  toolArgsStdin?: boolean;
  screenshotOut?: string;
  screenshotBase64?: boolean;
  viewport?: string;
  protocol?: string;
  serverName?: string;
  inspectorUrl?: string;
  requireRender?: boolean;
}

export interface AppsSessionActionOptions {
  session?: string;
  action?: string;
  coordinate?: string;
  text?: string;
  scrollDirection?: string;
  scrollAmount?: string;
  duration?: string;
  screenshotOut?: string;
  screenshotBase64?: boolean;
  inspectorUrl?: string;
}

/** Write base64 image bytes to `--screenshot-out`, returning the path written
 *  (or undefined when there's nothing/nowhere to write). */
async function writeScreenshotIfRequested(
  base64: string | undefined,
  screenshotOut: string | undefined,
): Promise<string | undefined> {
  if (!screenshotOut || !base64) {
    return undefined;
  }
  return writeBinaryArtifact(screenshotOut, Buffer.from(base64, "base64"));
}

function getConformanceGlobals(command: Command, reporter?: ReporterFormat): {
  format: ConformanceOutputFormat;
  timeout: number;
  rpc: boolean;
  quiet: boolean;
} {
  const globalOptions = command.optsWithGlobals() as {
    format?: string;
    timeout?: number;
    rpc?: boolean;
    quiet?: boolean;
  };

  return {
    format: resolveConformanceOutputFormatForCli(
      globalOptions.format,
      process.stdout.isTTY,
      reporter,
    ),
    timeout: globalOptions.timeout ?? 30_000,
    rpc: globalOptions.rpc ?? false,
    quiet: globalOptions.quiet ?? false,
  };
}

function writeConformanceOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function registerAppsCommands(program: Command): void {
  const apps = program
    .command("apps")
    .description("Validate MCP Apps metadata and resource wiring");

  addSharedServerOptions(
    apps
      .command("conformance")
      .description("Run MCP Apps server conformance checks")
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
      ),
  ).action(async (options, command) => {
    const reporter = parseReporterFormat(options.reporter as string | undefined);
    const globalOptions = getConformanceGlobals(command, reporter);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config: MCPAppsConformanceConfig = {
      ...buildAppsConformanceConfig({
        ...(options as AppsConformanceOptions),
        timeout: globalOptions.timeout,
      }),
      ...(collector ? { rpcLogger: collector.rpcLogger } : {}),
    };
    const result = await new MCPAppsConformanceTest(config).run();

    const outputResult = reporter
      ? result
      : (withRpcLogsIfRequested(
          result,
          collector,
          globalOptions,
        ) as typeof result);
    writeConformanceOutput(
      renderConformanceForCli(outputResult, reporter, globalOptions.format),
    );
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });

  addSharedServerOptions(
    apps
      .command("render")
      .description(
        "Render an MCP App tool result headlessly via the local Inspector (screenshot + verdict)",
      )
      .option("--tool-name <tool>", "Tool name")
      .option("--name <tool>", "Alias for --tool-name")
      .option(
        "--tool-args <json>",
        "Tool parameter object as JSON, @path, or - for stdin",
      )
      .option("--params <json>", "Alias for --tool-args")
      .option("--tool-args-stdin", "Read tool parameter JSON from stdin")
      .option(
        "--screenshot-out <path>",
        "Write the render screenshot to a file (PNG)",
      )
      .option(
        "--screenshot-base64",
        "Include the screenshot inline as base64 in the JSON output",
      )
      .option("--viewport <WxH>", "Headless viewport size, e.g. 1280x800")
      .option(
        "--protocol <protocol>",
        'Render protocol: "mcp-apps" (default) or "openai-sdk"',
      )
      .option("--server-name <name>", "Server name inside Inspector")
      .option("--inspector-url <url>", "Local Inspector base URL")
      .option(
        "--require-render",
        "Exit non-zero unless the widget renders (status !== rendered)",
      ),
  ).action(async (options: AppsRenderOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const toolName = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolName", flag: "--tool-name" },
        { key: "name", flag: "--name" },
      ],
      "Tool name",
      { required: true },
    ) as string;
    const resolvedParamsInput = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolArgs", flag: "--tool-args" },
        { key: "params", flag: "--params" },
      ],
      "Tool parameters",
    );
    if (options.toolArgsStdin && resolvedParamsInput !== undefined) {
      throw usageError(
        "--tool-args-stdin cannot be used together with --tool-args or --params.",
      );
    }
    const paramsInput = options.toolArgsStdin ? "-" : resolvedParamsInput;
    const parameters = parseJsonRecord(paramsInput, "Tool parameters") ?? {};
    const viewport = parseWidgetRenderViewport(options.viewport);
    const injectOpenAiCompat = resolveWidgetRenderInjectOpenAiCompat(
      options.protocol,
    );
    const serverName =
      typeof options.serverName === "string" && options.serverName.trim()
        ? options.serverName.trim()
        : buildInspectorServerName(options);

    const response = await runWidgetRender({
      baseUrl: options.inspectorUrl,
      config,
      serverName,
      toolName,
      parameters,
      injectOpenAiCompat,
      viewport,
      startIfNeeded: true,
      timeoutMs: globalOptions.timeout,
    });

    // Screenshot delivery: file by default (--screenshot-out), inline base64
    // only when explicitly requested, so normal stdout stays clean. A frame is
    // written whenever the harness produced one — including a blank/timeout
    // frame, which is useful diagnostic output.
    let screenshotPath: string | undefined;
    if (options.screenshotOut && response.screenshotBase64) {
      screenshotPath = await writeBinaryArtifact(
        options.screenshotOut,
        Buffer.from(response.screenshotBase64, "base64"),
      );
    }

    writeResult(
      buildWidgetRenderOutput(response, {
        screenshotPath,
        includeBase64: options.screenshotBase64 === true,
        toolName,
        serverName,
      }),
      globalOptions.format,
    );

    if (response.status !== "rendered" && options.requireRender) {
      setProcessExitCode(1);
    }
  });

  const session = apps
    .command("session")
    .description(
      "Interactive headless widget sessions (start, action, close) via the local Inspector",
    );

  addSharedServerOptions(
    session
      .command("start")
      .description("Render a widget and keep it mounted for stepping")
      .option("--tool-name <tool>", "Tool name")
      .option("--name <tool>", "Alias for --tool-name")
      .option(
        "--tool-args <json>",
        "Tool parameter object as JSON, @path, or - for stdin",
      )
      .option("--params <json>", "Alias for --tool-args")
      .option("--tool-args-stdin", "Read tool parameter JSON from stdin")
      .option(
        "--screenshot-out <path>",
        "Write the first-frame screenshot to a file (PNG)",
      )
      .option(
        "--screenshot-base64",
        "Include the screenshot inline as base64 in the JSON output",
      )
      .option("--viewport <WxH>", "Headless viewport size, e.g. 1280x800")
      .option(
        "--protocol <protocol>",
        'Render protocol: "mcp-apps" (default) or "openai-sdk"',
      )
      .option("--server-name <name>", "Server name inside Inspector")
      .option("--inspector-url <url>", "Local Inspector base URL")
      .option(
        "--require-render",
        "Exit non-zero unless the widget renders (status !== rendered)",
      ),
  ).action(async (options: AppsSessionStartOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const toolName = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolName", flag: "--tool-name" },
        { key: "name", flag: "--name" },
      ],
      "Tool name",
      { required: true },
    ) as string;
    const resolvedParamsInput = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolArgs", flag: "--tool-args" },
        { key: "params", flag: "--params" },
      ],
      "Tool parameters",
    );
    if (options.toolArgsStdin && resolvedParamsInput !== undefined) {
      throw usageError(
        "--tool-args-stdin cannot be used together with --tool-args or --params.",
      );
    }
    const paramsInput = options.toolArgsStdin ? "-" : resolvedParamsInput;
    const parameters = parseJsonRecord(paramsInput, "Tool parameters") ?? {};
    const viewport = parseWidgetRenderViewport(options.viewport);
    const injectOpenAiCompat = resolveWidgetRenderInjectOpenAiCompat(
      options.protocol,
    );
    const serverName =
      typeof options.serverName === "string" && options.serverName.trim()
        ? options.serverName.trim()
        : buildInspectorServerName(options);

    const response = await runWidgetSessionStart({
      baseUrl: options.inspectorUrl,
      config,
      serverName,
      toolName,
      parameters,
      injectOpenAiCompat,
      viewport,
      startIfNeeded: true,
      timeoutMs: globalOptions.timeout,
    });

    const screenshotPath = await writeScreenshotIfRequested(
      response.screenshotBase64,
      options.screenshotOut,
    );

    writeResult(
      buildWidgetSessionStartOutput(response, {
        screenshotPath,
        includeBase64: options.screenshotBase64 === true,
        toolName,
        serverName,
      }),
      globalOptions.format,
    );

    if (response.status !== "rendered" && options.requireRender) {
      setProcessExitCode(1);
    }
  });

  session
    .command("action")
    .description("Drive a Computer-Use action on a session's mounted widget")
    .requiredOption("--session <id>", "Session id from `apps session start`")
    .requiredOption(
      "--action <type>",
      "Action: left_click, double_click, right_click, mouse_move, type, key, scroll, wait, screenshot",
    )
    .option("--coordinate <x,y>", 'Click/move target, e.g. "640,400"')
    .option("--text <text>", "Text for type / key for press")
    .option(
      "--scroll-direction <dir>",
      "Scroll direction: up, down, left, or right",
    )
    .option("--scroll-amount <n>", "Scroll amount (wheel notches)")
    .option("--duration <ms>", "Wait duration in milliseconds")
    .option(
      "--screenshot-out <path>",
      "Write the post-action screenshot to a file (PNG)",
    )
    .option(
      "--screenshot-base64",
      "Include the screenshot inline as base64 in the JSON output",
    )
    .option("--inspector-url <url>", "Local Inspector base URL")
    .action(async (options: AppsSessionActionOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const sessionId = options.session?.trim();
      if (!sessionId) {
        throw usageError("--session is required.");
      }
      const action = parseBrowserActionSpec(options);

      const response = await runWidgetSessionAction({
        baseUrl: options.inspectorUrl,
        sessionId,
        action,
        timeoutMs: globalOptions.timeout,
      });

      const screenshotPath = await writeScreenshotIfRequested(
        response.screenshotBase64,
        options.screenshotOut,
      );

      writeResult(
        buildWidgetSessionActionOutput(response, {
          screenshotPath,
          includeBase64: options.screenshotBase64 === true,
        }),
        globalOptions.format,
      );
    });

  session
    .command("close")
    .description("Close a widget session and dispose its browser")
    .requiredOption("--session <id>", "Session id from `apps session start`")
    .option("--inspector-url <url>", "Local Inspector base URL")
    .action(
      async (
        options: { session?: string; inspectorUrl?: string },
        command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        const sessionId = options.session?.trim();
        if (!sessionId) {
          throw usageError("--session is required.");
        }
        const response = await runWidgetSessionClose({
          baseUrl: options.inspectorUrl,
          sessionId,
          timeoutMs: globalOptions.timeout,
        });
        writeResult({ closed: response.closed }, globalOptions.format);
      },
    );

  apps
    .command("conformance-suite")
    .description("Run MCP Apps conformance runs from a JSON config file")
    .requiredOption("--config <path>", "Path to JSON config file")
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const globalOptions = getConformanceGlobals(command, reporter);
      const config = loadAppsSuiteConfig(options.config as string);
      const target = config.target.command ?? config.target.url ?? "apps-suite";
      const collector = globalOptions.rpc
        ? createCliRpcLogCollector({ __cli__: target })
        : undefined;
      const suite = new MCPAppsConformanceSuite({
        ...config,
        target: {
          ...config.target,
          ...(collector ? { rpcLogger: collector.rpcLogger } : {}),
        },
      });
      const result = await suite.run();

      const outputResult = reporter
        ? result
        : (withRpcLogsIfRequested(
            result,
            collector,
            globalOptions,
          ) as typeof result);
      writeConformanceOutput(
        renderConformanceForCli(outputResult, reporter, globalOptions.format),
      );
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });
}

function collectInvalidEntries(
  values: string[] | undefined,
  allowedValues: readonly string[],
): string[] {
  return (values ?? []).filter((value) => !allowedValues.includes(value));
}

export function buildAppsConformanceConfig(
  options: AppsConformanceOptions,
): MCPAppsConformanceConfig {
  const serverConfig = parseServerConfig(options);
  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    MCP_APPS_CHECK_CATEGORIES,
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1
        ? `Unknown category: ${invalidCategories[0]}`
        : `Unknown categories: ${invalidCategories.join(", ")}`,
    );
  }

  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, MCP_APPS_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${
        invalidCheckIds.length === 1 ? "" : "s"
      }: ${invalidCheckIds.join(", ")}`,
    );
  }

  const resolvedCheckIds =
    checkIds && checkIds.length > 0
      ? checkIds
      : categories && categories.length > 0
      ? Array.from(
          new Set(
            categories.flatMap(
              (category) =>
                APPS_CHECK_IDS_BY_CATEGORY[category as MCPAppsCheckCategory],
            ),
          ),
        )
      : undefined;

  return {
    ...serverConfig,
    ...(resolvedCheckIds && resolvedCheckIds.length > 0
      ? { checkIds: resolvedCheckIds as MCPAppsConformanceConfig["checkIds"] }
      : {}),
  };
}
