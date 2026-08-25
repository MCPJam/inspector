import {
  conformanceExitCode,
  reportIncomplete,
  reportScore,
} from "../lib/conformance-exit-code.js";
import {
  isConformanceReportingConfigured,
  reportConformanceRun,
  reportConformanceRunSafely,
  runConformance,
  type ConformanceSuiteKind,
  type MCPServerConfig,
  type OAuthConformanceConfig,
} from "@mcpjam/sdk";
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
} from "../lib/conformance-output.js";
import { parseReporterFormat } from "../lib/reporting.js";
import {
  addSharedServerOptions,
  getGlobalOptions,
  parseServerConfig,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { setProcessExitCode, usageError } from "../lib/output.js";

const SUITE_KINDS: ConformanceSuiteKind[] = [
  "protocol",
  "apps",
  "tasks",
  "oauth",
];

export interface CompositeConformanceOptions extends SharedServerTargetOptions {
  suite?: string[];
  requireUpload?: boolean;
  upload?: boolean;
  oauthStrategy?: string;
}

function writeConformanceOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function registerConformanceRunCommand(program: Command): void {
  const conformance = program
    .command("conformance")
    .description("Run MCPJam conformance suites and optionally upload results");

  addSharedServerOptions(
    conformance
      .command("run")
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
        "--upload",
        "Upload results even when MCPJAM_API_KEY is not otherwise implied",
      )
      .option(
        "--require-upload",
        "Fail the process if reporting is configured but the UI record cannot be written",
      )
      .option(
        "--oauth-strategy <strategy>",
        "Required when --suite oauth is set: client_credentials",
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
      ...options,
      timeout: globalOptions.timeout,
    });
    if (!("url" in server) || typeof server.url !== "string") {
      throw usageError("conformance run requires an HTTP --url target");
    }

    let oauth: OAuthConformanceConfig | undefined;
    if (suites.includes("oauth")) {
      oauth = buildOAuthConfig(server, options);
    }

    const report = await runConformance({
      server,
      suites,
      oauth,
      engineVersion: packageJson.version,
    });

    if (reporter === "json-summary" || format === "json") {
      writeConformanceOutput(JSON.stringify(report, null, 2));
    } else if (reporter === "junit-xml") {
      const { renderConformanceReportJUnitXml } = await import("@mcpjam/sdk");
      const xml = Object.values(report.reports)
        .map((suiteReport) => renderConformanceReportJUnitXml(suiteReport))
        .join("\n");
      writeConformanceOutput(xml);
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

    const shouldUpload =
      options.upload === true ||
      options.requireUpload === true ||
      isConformanceReportingConfigured();
    if (shouldUpload) {
      const serverUrl = String(server.url);
      try {
        const uploaded = options.requireUpload
          ? await reportConformanceRun(report, { serverUrl, defaultSource: "cli" })
          : await reportConformanceRunSafely(report, {
              serverUrl,
              defaultSource: "cli",
            });
        if (uploaded?.runUrl && !command.optsWithGlobals().quiet) {
          process.stderr.write(`Uploaded: ${uploaded.runUrl}\n`);
        }
        if (options.requireUpload && !uploaded) {
          throw new Error("Conformance upload did not return a run record");
        }
      } catch (error) {
        if (options.requireUpload) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Warning: conformance upload failed: ${message}\n`);
      }
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

function buildOAuthConfig(
  server: MCPServerConfig,
  options: CompositeConformanceOptions,
): OAuthConformanceConfig {
  const strategy = options.oauthStrategy?.trim();
  if (strategy !== "client_credentials") {
    throw usageError(
      "OAuth on `conformance run` requires --oauth-strategy client_credentials and noninteractive credentials",
    );
  }
  if (!("url" in server) || typeof server.url !== "string") {
    throw usageError("OAuth conformance requires an HTTP --url");
  }
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw usageError(
      "OAuth client_credentials requires --client-id and --client-secret",
    );
  }
  return {
    serverUrl: server.url,
    protocolVersion: "2025-11-25",
    registrationStrategy: "preregistered",
    auth: {
      mode: "client_credentials",
      clientId,
      clientSecret,
    },
  };
}
