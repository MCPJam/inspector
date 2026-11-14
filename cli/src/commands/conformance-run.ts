import {
  conformanceExitCode,
  reportIncomplete,
  reportScore,
} from "../lib/conformance-exit-code.js";
import {
  isConformanceReportingConfigured,
  isKnownProtocolVersion,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_OAUTH_READINESS_IDS,
  MCP_PROTOCOL_VERSIONS,
  MCP_READINESS_IDS,
  MCP_TASKS_CHECK_IDS,
  MCP_TASKS_READINESS_IDS,
  RENAMED_MCP_TASKS_CHECK_IDS,
  RETIRED_MCP_CHECK_IDS,
  runConformance,
  type ConformanceSuiteKind,
  type MCPAppsCheckId,
  type MCPOAuthReadinessId,
  type MCPServerConfig,
  type RunConformanceConfig,
  type RunConformanceOAuthConfig,
} from "@mcpjam/sdk";
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import {
  addProtocolToolOptions,
  buildProtocolRunConfig,
  type ProtocolRunOptions,
} from "./conformance.js";
import {
  addOAuthFlowOptions,
  buildOAuthFlowConfig,
  type OAuthCommandOptions,
} from "./oauth.js";
import {
  VALID_AUTH_MODES,
  VALID_PROTOCOL_VERSIONS,
  VALID_REGISTRATION_STRATEGIES,
} from "../lib/oauth-enums.js";
import {
  addTasksToolOptions,
  buildTasksConformanceConfig,
  type TasksConformanceOptions,
} from "./tasks.js";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
} from "../lib/conformance-output.js";
import {
  requestsUpload,
  uploadConformanceReport,
} from "../lib/conformance-upload.js";
import { declareMcpjamUse } from "../lib/deployment-preflight.js";
import { captureConformanceRunEvent } from "../lib/telemetry.js";
import { parseReporterFormat } from "../lib/reporting.js";
import {
  addSharedServerOptions,
  getGlobalOptions,
  parsePositiveInteger,
  parseServerConfig,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError } from "../lib/output.js";

const SUITE_KINDS: ConformanceSuiteKind[] = [
  "protocol",
  "apps",
  "tasks",
  "oauth",
];

/**
 * The same flags as the single-suite commands, so a run of every suite can
 * check what each command checks alone. `--category` is left out: protocol
 * and apps share category names, and the app picks checks, not categories.
 */
export interface CompositeConformanceOptions
  extends TasksConformanceOptions,
    ProtocolRunOptions {
  suite?: string[];
  requireUpload?: boolean;
  upload?: boolean;
  oauthStrategy?: string;
  registration?: string;
  clientMetadataUrl?: string;
  redirectUrl?: string;
  scopes?: string;
  stepTimeout?: number;
  printUrl?: boolean;
}

/**
 * The suite that owns each id. Ids are unique across suites, so one
 * `--check-id` and one `--advice-id` serve every suite. Retired and renamed
 * ids go to their old suite, whose builder says what changed.
 */
const CHECK_ID_SUITES: ReadonlyArray<
  readonly [ConformanceSuiteKind, readonly string[]]
> = [
  ["protocol", [...MCP_CHECK_IDS, ...Object.keys(RETIRED_MCP_CHECK_IDS)]],
  ["apps", MCP_APPS_CHECK_IDS],
  [
    "tasks",
    [...MCP_TASKS_CHECK_IDS, ...Object.keys(RENAMED_MCP_TASKS_CHECK_IDS)],
  ],
];
const ADVICE_ID_SUITES: ReadonlyArray<
  readonly [ConformanceSuiteKind, readonly string[]]
> = [
  ["protocol", MCP_READINESS_IDS],
  ["tasks", MCP_TASKS_READINESS_IDS],
  ["oauth", MCP_OAUTH_READINESS_IDS],
];

function writeConformanceOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function registerConformanceRunCommand(program: Command): void {
  const conformance = program
    .command("conformance")
    .description("Run MCPJam conformance suites and optionally upload results");

  // Configured reporting is consent here, so a set MCPJAM_API_KEY uploads.
  const uploads = (options: Parameters<typeof requestsUpload>[0]) =>
    requestsUpload(options) || isConformanceReportingConfigured();
  const run = conformance.command("run");
  declareMcpjamUse(run, { when: uploads, credential: "api-key" });
  run
    .description(
      "Run Protocol, Apps, and Tasks (default). OAuth is opt-in via --suite oauth.",
    )
    .option(
      "--suite <suite>",
      "Suite to run: protocol, apps, tasks, or oauth. Repeatable. Default: protocol, apps, tasks.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--protocol-version <version>",
      "Pin one MCP protocol version for every suite in the run. Default: the version the server negotiates.",
    )
    .option(
      "--check-id <id>",
      "Specific check ID to run. Repeat for multiple. Each id goes to the suite that owns it; a suite with none runs all its checks.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--advice-id <id>",
      "Specific advice ID to run. Repeat for multiple. Each id goes to the suite that owns it; a suite with none runs all its advice.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--check-timeout <ms>",
      "Per-check timeout in milliseconds for the protocol suite",
      (value: string) => parsePositiveInteger(value, "Check timeout"),
    );
  addProtocolToolOptions(run);
  addTasksToolOptions(run);
  addOAuthFlowOptions(run);
  addSharedServerOptions(
    run
      .option(
        "--upload",
        "Upload results even when MCPJAM_API_KEY is not otherwise implied",
      )
      .option(
        "--require-upload",
        "Fail the process if reporting is configured but the UI record cannot be written",
      )
      .option(
        "--oauth-strategy <strategy>",
        "How the OAuth suite signs in: interactive (default), headless, or client_credentials",
      )
      .option(
        "--registration <strategy>",
        "How the OAuth suite registers its client: auto (default), dcr, cimd, or preregistered. Auto uses --client-id when given, else what the server supports",
      )
      .option("--reporter <reporter>", "json-summary or junit-xml"),
  ).action(async (options: CompositeConformanceOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const reporter = parseReporterFormat(
      (options as { reporter?: string }).reporter,
    );
    if (reporter === "html") {
      // Shared parser, different report shape: `conformance run` reports are
      // a composite of several `ConformanceReport`s, which have no HTML
      // renderer yet — building one is out of this step's scope. Rejected
      // here, before anything runs: this option is invalid regardless of
      // what the suite would find, so it must not cost a real run first.
      throw usageError(
        'The "html" reporter is not available for this command yet. Use "json-summary" or "junit-xml".',
      );
    }
    const format = resolveConformanceOutputFormatForCli(
      globalOptions.format,
      process.stdout.isTTY,
      reporter,
    );
    const suites = normalizeConformanceRunSuites(options.suite);
    const server = parseServerConfig({
      ...serverTargetOptions(options, suites),
      timeout: globalOptions.timeout,
    });
    if (!("url" in server) || typeof server.url !== "string") {
      throw usageError("conformance run requires an HTTP --url target");
    }

    const { oauthReadinessIds, ...suiteConfigs } = buildConformanceRunInput(
      server,
      suites,
      options,
      command,
    );

    let oauth: RunConformanceOAuthConfig | undefined;
    if (suites.includes("oauth")) {
      oauth = {
        ...buildOAuthConfig(server, options),
        ...(oauthReadinessIds ? { readinessIds: oauthReadinessIds } : {}),
      };
    }

    captureConformanceRunEvent();
    const report = await runConformance({
      server,
      suites,
      oauth,
      ...suiteConfigs,
      engineVersion: packageJson.version,
      // A suite that throws is left out of the report, so say why here or the
      // run exits incomplete with nothing to go on.
      onProgress: (event) => {
        if (event.status !== "failed" || command.optsWithGlobals().quiet) {
          return;
        }
        const reason = event.error ? ` ${event.error}` : "";
        process.stderr.write(
          `Run incomplete: the ${event.suiteKind} suite could not run.${reason}\n`,
        );
      },
      // The CLI counts the run itself, under its own opt-outs.
      __suppressTelemetry: true,
    });

    // An explicit reporter wins over the output format, as on every suite
    // command: off a TTY the format defaults to json, and CI is never a TTY.
    if (reporter === "junit-xml") {
      const { renderConformanceRunJUnitXml } = await import("@mcpjam/sdk");
      writeConformanceOutput(renderConformanceRunJUnitXml(report));
    } else if (reporter === "json-summary" || format === "json") {
      writeConformanceOutput(JSON.stringify(report, null, 2));
    } else {
      for (const [kind, suiteReport] of Object.entries(report.reports)) {
        process.stderr.write(`\n== ${kind} ==\n`);
        writeConformanceOutput(
          renderConformanceForCli(suiteReport as never, undefined, format),
        );
      }
    }

    reportScore(report.score, command);
    for (const suiteReport of Object.values(report.reports)) {
      reportIncomplete(suiteReport as { outcome?: string; incompleteReason?: string; checks?: Array<{ skipReason?: string }> }, command);
    }

    if (uploads(options)) {
      await uploadConformanceReport(report, {
        serverUrl: String(server.url),
        requireUpload: options.requireUpload === true,
        command,
      });
    }

    const exitCode = conformanceExitCode({
      passed: report.outcome === "passed",
      outcome: report.outcome,
    });
    if (exitCode !== 0) {
      setProcessExitCode(exitCode);
    }
  });
}

export function normalizeConformanceRunSuites(
  raw: string[] | undefined,
): ConformanceSuiteKind[] {
  if (!raw || raw.length === 0) return ["protocol", "apps", "tasks"];
  const out: ConformanceSuiteKind[] = [];
  for (const value of raw) {
    const suite = value.trim().toLowerCase();
    if (!SUITE_KINDS.includes(suite as ConformanceSuiteKind)) {
      throw usageError(
        `Unknown suite "${value}". Use protocol, apps, tasks, or oauth.`,
      );
    }
    if (!out.includes(suite as ConformanceSuiteKind)) {
      out.push(suite as ConformanceSuiteKind);
    }
  }
  return out;
}

export interface ConformanceRunInput
  extends Pick<
    RunConformanceConfig,
    "protocolVersion" | "protocol" | "apps" | "tasks"
  > {
  /** OAuth advice to run. Absent ⇒ all of it, as for the other suites. */
  oauthReadinessIds?: MCPOAuthReadinessId[];
}

/**
 * The SDK's per-suite configs, built by each single-suite command's own
 * builder, so `conformance run` checks what those commands check alone.
 * `command` is the parsed `conformance run`, which says which flags the user
 * typed instead of getting their defaults.
 *
 * Bad input is a usage error before anything runs: an unknown id, and an id
 * or flag for a suite this run leaves out, which would otherwise be ignored.
 */
export function buildConformanceRunInput(
  server: MCPServerConfig,
  suites: ConformanceSuiteKind[],
  options: CompositeConformanceOptions,
  command: Command,
): ConformanceRunInput {
  // A blank id is a mistake, not an omitted flag: dropping it would run every
  // advice instead of the one asked for.
  if (options.adviceId?.some((id) => !id.trim())) {
    throw usageError("--advice-id needs an advice id.");
  }
  const checkIds = routeIdsToSuites(
    "check",
    options.checkId?.filter(Boolean),
    CHECK_ID_SUITES,
    suites,
  );
  const adviceIds = routeIdsToSuites(
    "advice",
    options.adviceId,
    ADVICE_ID_SUITES,
    suites,
  );
  assertSuiteFlagsRun(suites, command);

  const protocolVersion = options.protocolVersion?.trim();
  if (
    options.protocolVersion !== undefined &&
    (!protocolVersion || !isKnownProtocolVersion(protocolVersion))
  ) {
    throw usageError(
      `Unknown protocol version: ${protocolVersion ?? ""}. Known: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
    );
  }

  // The pin is for the whole run, as in the app: `runConformance` applies it
  // to every suite, so no builder gets its own.
  const suiteOptions = { ...options, protocolVersion: undefined };
  return {
    ...(protocolVersion
      ? {
          protocolVersion:
            protocolVersion as RunConformanceConfig["protocolVersion"],
        }
      : {}),
    ...(suites.includes("protocol")
      ? {
          protocol: buildProtocolRunConfig({
            ...suiteOptions,
            checkId: checkIds.protocol,
            adviceId: adviceIds.protocol,
          }),
        }
      : {}),
    ...(checkIds.apps
      ? { apps: { checkIds: checkIds.apps as MCPAppsCheckId[] } }
      : {}),
    ...(suites.includes("tasks")
      ? {
          tasks: buildTasksConformanceConfig(
            {
              ...suiteOptions,
              checkId: checkIds.tasks,
              adviceId: adviceIds.tasks,
            },
            server,
          ),
        }
      : {}),
    ...(adviceIds.oauth
      ? { oauthReadinessIds: adviceIds.oauth as MCPOAuthReadinessId[] }
      : {}),
  };
}

/** Group ids by the suite that owns them; each suite's builder checks them. */
function routeIdsToSuites(
  kind: "check" | "advice",
  ids: string[] | undefined,
  owners: ReadonlyArray<readonly [ConformanceSuiteKind, readonly string[]]>,
  suites: ConformanceSuiteKind[],
): Partial<Record<ConformanceSuiteKind, string[]>> {
  const routed: Partial<Record<ConformanceSuiteKind, string[]>> = {};
  const unknown: string[] = [];
  for (const id of ids ?? []) {
    const suite = owners.find(([, known]) => known.includes(id))?.[0];
    if (!suite) {
      unknown.push(id);
    } else if (!suites.includes(suite)) {
      throw usageError(
        `--${kind}-id ${id} is for the ${suite} suite, which this run leaves out. Add it with --suite ${suite}.`,
      );
    } else {
      (routed[suite] ??= []).push(id);
    }
  }
  if (unknown.length > 0) {
    const valid =
      kind === "advice"
        ? `. Valid advice ids: ${owners.flatMap(([, known]) => known).join(", ")}`
        : "";
    throw usageError(
      `Unknown ${kind} id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}${valid}`,
    );
  }
  return routed;
}

/**
 * A flag only one suite reads, typed for a run that leaves that suite out, is
 * a usage error instead of a flag that is silently ignored. The flags come
 * from the helpers both commands share, so this list cannot go stale.
 */
function assertSuiteFlagsRun(
  suites: ConformanceSuiteKind[],
  command: Command,
): void {
  const isSet = (key: string) => {
    const source = command.getOptionValueSource(key);
    return source !== undefined && source !== "default";
  };
  const flagsAddedBy = (add: (command: Command) => Command) =>
    add(new Command()).options.map((option) => ({
      key: option.attributeName(),
      flag: option.long ?? option.flags,
    }));
  const suiteOnlyFlags: Array<
    [ConformanceSuiteKind, Array<{ key: string; flag: string }>]
  > = [
    [
      "protocol",
      [
        { key: "checkTimeout", flag: "--check-timeout" },
        ...flagsAddedBy(addProtocolToolOptions),
      ],
    ],
    ["tasks", flagsAddedBy(addTasksToolOptions)],
    [
      "oauth",
      [
        { key: "oauthStrategy", flag: "--oauth-strategy" },
        { key: "registration", flag: "--registration" },
        ...flagsAddedBy(addOAuthFlowOptions),
      ],
    ],
  ];
  for (const [suite, flags] of suiteOnlyFlags) {
    if (suites.includes(suite)) continue;
    const typed = flags.filter(({ key }) => isSet(key)).map(({ flag }) => flag);
    if (typed.length > 0) {
      throw usageError(
        `${typed.join(", ")} ${typed.length === 1 ? "is" : "are"} for the ${suite} suite, which this run leaves out. Add it with --suite ${suite}.`,
      );
    }
  }
}

/**
 * The options `parseServerConfig` should see. With `--suite oauth` and no
 * `--refresh-token`, `--client-id` and `--client-secret` are the OAuth suite's
 * pre-registered client, not a refresh-token login, so they stay out of the
 * server config, which would otherwise reject them.
 */
export function serverTargetOptions(
  options: CompositeConformanceOptions,
  suites: ConformanceSuiteKind[],
): CompositeConformanceOptions {
  if (!suites.includes("oauth") || options.refreshToken) return options;
  return { ...options, clientId: undefined, clientSecret: undefined };
}

/**
 * The OAuth suite's config, built the way `oauth conformance` builds it, so a
 * run of every suite signs in the way that command does alone. Registration
 * defaults to `"auto"`, which the SDK settles once the run has its version.
 */
export function buildOAuthConfig(
  server: MCPServerConfig,
  options: CompositeConformanceOptions,
): RunConformanceOAuthConfig {
  if (!("url" in server) || typeof server.url !== "string") {
    throw usageError("OAuth conformance requires an HTTP --url");
  }
  const strategy = options.oauthStrategy?.trim() || "interactive";
  if (!VALID_AUTH_MODES.has(strategy)) {
    throw usageError(
      `Unknown --oauth-strategy "${strategy}". Use interactive, headless, or client_credentials.`,
    );
  }
  const registration = options.registration?.trim() || "auto";
  if (registration !== "auto" && !VALID_REGISTRATION_STRATEGIES.has(registration)) {
    throw usageError(
      `Unknown --registration "${registration}". Use auto, dcr, cimd, or preregistered.`,
    );
  }
  // A pinned version is the run's (see `runConformance`), so the OAuth checks
  // below see it now. Unpinned, the version the run negotiates replaces this.
  const pin = options.protocolVersion?.trim();
  const protocolVersion =
    pin && VALID_PROTOCOL_VERSIONS.has(pin) ? pin : "2025-11-25";
  return buildOAuthFlowConfig(
    {
      url: server.url,
      protocolVersion: protocolVersion as OAuthCommandOptions["protocolVersion"],
      authMode: strategy as OAuthCommandOptions["authMode"],
      // With --refresh-token they are that login's client, not this suite's;
      // see `serverTargetOptions`.
      ...(options.refreshToken
        ? {}
        : { clientId: options.clientId, clientSecret: options.clientSecret }),
      clientMetadataUrl: options.clientMetadataUrl,
      redirectUrl: options.redirectUrl,
      scopes: options.scopes,
      stepTimeout: options.stepTimeout,
      header: options.header,
      printUrl: options.printUrl,
    },
    registration as RunConformanceOAuthConfig["registrationStrategy"],
    { authModeFlag: "--oauth-strategy" },
  );
}
