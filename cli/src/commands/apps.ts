import { buildAppsConformanceConfig, type AppsConformanceOptions } from "../lib/apps-conformance-config.js";
import { declareMcpjamUse } from "../lib/deployment-preflight.js";
import { resolveInspectorProjectTarget } from "../lib/inspector-project-target.js";
import { platformOptionsOf } from "../lib/platform-command.js";
import {
  conformanceExitCode,
  conformanceSuiteExitCode,
  reportIncomplete,
  reportReadiness,
  reportScore,
} from "../lib/conformance-exit-code.js";
import { Command } from "commander";
import {
  MCPAppsConformanceSuite,
  MCPAppsConformanceTest,
  type MCPAppsConformanceConfig,
  scoreFromAppsResult,
} from "@mcpjam/sdk";
import { loadAppsSuiteConfig } from "../lib/config-file.js";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { maybeUploadSingleSuite } from "../lib/conformance-upload.js";
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
  runWidgetSessionSnapshot,
  runWidgetSessionScriptedStep,
  parseScriptedStepInput,
  parsePriorWidgetToolCalls,
} from "../lib/widget-session.js";

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
  project?: string;
  serverId?: string;
  apiKey?: string;
  apiUrl?: string;
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
  project?: string;
  serverId?: string;
  apiKey?: string;
  apiUrl?: string;
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

function addRenderServerOptions(command: Command): Command {
  return declareMcpjamUse(
    addSharedServerOptions(command)
      .option("--project <id-or-name>", "Project containing the saved server")
      .option("--server-id <id>", "Saved project server to render")
      .option("--api-key <key>", "MCPJam API key (or use cloud login)")
      .option("--api-url <url>", "MCPJam API base URL"),
    {
      when: (options) => typeof options.serverId === "string",
    },
  );
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
      )
      .option(
        "--protocol-version <version>",
        "Pin the MCP protocol version for the conformance connection (e.g. 2026-07-28). HTTP targets only.",
      )
      .option("--upload", "Upload this suite's result into MCPJam run history")
      .option(
        "--require-upload",
        "Fail if reporting is configured but the UI record cannot be written",
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
    // The JSON payload carries both too, but a human running this in a
    // terminal must not have to dig for the number or the reason a check
    // never ran.
    reportScore(scoreFromAppsResult(result), command);
    reportReadiness(result, command);
    reportIncomplete(result, command);
    await maybeUploadSingleSuite({
      suiteKind: "apps",
      result,
      serverUrl:
        "url" in config && typeof config.url === "string" ? config.url : undefined,
      upload: Boolean((options as { upload?: boolean }).upload),
      requireUpload: Boolean((options as { requireUpload?: boolean }).requireUpload),
      command,
    });
    const exitCode = conformanceExitCode(result);
    if (exitCode !== 0) {
      setProcessExitCode(exitCode);
    }
  });

  addRenderServerOptions(
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
    const target = await resolveInspectorProjectTarget(platformOptionsOf<AppsRenderOptions>(command));
    const config = target ? undefined : parseServerConfig({
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
      ...(target ? { target } : {}),
      serverName: target?.serverName ?? serverName,
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
      "Interactive headless widget sessions via the local Inspector. `action` drives by pixel coordinate; `snapshot` + `step` drive by role/name/testId, which is what a caller that cannot see the screenshot needs.",
    );

  addRenderServerOptions(
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
    const target = await resolveInspectorProjectTarget(platformOptionsOf<AppsSessionStartOptions>(command));
    const config = target ? undefined : parseServerConfig({
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
      ...(target ? { target } : {}),
      serverName: target?.serverName ?? serverName,
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
    .command("snapshot")
    .description(
      "Read the mounted widget as an accessibility tree plus addressable controls. A read: it refreshes the session TTL but does not spend the widget's interaction budget.",
    )
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
        const response = await runWidgetSessionSnapshot({
          baseUrl: options.inspectorUrl,
          sessionId,
          timeoutMs: globalOptions.timeout,
        });
        writeResult(response, globalOptions.format);
      },
    );

  session
    .command("step")
    .description(
      'Drive one semantic step, addressed by role/name/testId rather than by coordinate. Pass the step as JSON, e.g. --step \'{"kind":"click","target":{"role":{"role":"button","name":"Submit"}}}\'. Use `apps session snapshot` to find the targets.',
    )
    .requiredOption("--session <id>", "Session id from `apps session start`")
    .requiredOption("--step <json>", "The step, as a JSON object")
    .option(
      "--prior-tool-calls <json>",
      "The `widgetToolCalls` earlier steps returned, as a JSON array. Required for a `widgetToolCalled` assertion: the server drains its buffer after every step, so history is the caller's to carry.",
    )
    .option(
      "--screenshot-out <path>",
      "Write the post-step screenshot to a file",
    )
    .option(
      "--screenshot-base64",
      "Include the screenshot inline as base64 in the JSON output",
    )
    .option("--inspector-url <url>", "Local Inspector base URL")
    .action(
      async (
        options: {
          session?: string;
          step?: string;
          priorToolCalls?: string;
          screenshotOut?: string;
          screenshotBase64?: boolean;
          inspectorUrl?: string;
        },
        command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        const sessionId = options.session?.trim();
        if (!sessionId) {
          throw usageError("--session is required.");
        }
        const step = parseScriptedStepInput(options.step);
        const priorWidgetToolCalls = parsePriorWidgetToolCalls(
          options.priorToolCalls,
        );

        const response = await runWidgetSessionScriptedStep({
          baseUrl: options.inspectorUrl,
          sessionId,
          step,
          ...(priorWidgetToolCalls ? { priorWidgetToolCalls } : {}),
          timeoutMs: globalOptions.timeout,
        });

        const screenshotPath = await writeScreenshotIfRequested(
          response.screenshotBase64,
          options.screenshotOut,
        );

        const { screenshotBase64, ...rest } = response;
        writeResult(
          {
            ...rest,
            ...(screenshotPath ? { screenshotPath } : {}),
            // Base64 only on request: a frame per step is the largest thing
            // this command emits, and the caller driving by role does not
            // need it.
            ...(options.screenshotBase64 === true && screenshotBase64
              ? { screenshotBase64 }
              : {}),
          },
          globalOptions.format,
        );
      },
    );

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
      // Each run carries its own score and reason.
      for (const run of result.results) {
        reportScore(scoreFromAppsResult(run), command, run.label);
        reportReadiness(run, command);
        reportIncomplete(run, command);
      }
      const exitCode = conformanceSuiteExitCode(result.results);
      if (exitCode !== 0) {
        setProcessExitCode(exitCode);
      }
    });
}
