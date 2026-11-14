import {
  buildConformanceRunReport,
  reportConformanceRun,
  reportConformanceRunSafely,
  toConformanceReport,
  type ConformanceReport,
  type ConformanceRunReportV1,
  type ConformanceSuiteKind,
} from "@mcpjam/sdk";
import { isMcpjamDeploymentError } from "@mcpjam/sdk/internal/deployment";
import type { Command } from "commander";
import {
  resolveCliDeployment,
  resolvePlatformExtraHeaders,
} from "./platform-client.js";

/** Whether this invocation asked for an upload by flag. */
export function requestsUpload(options: {
  upload?: unknown;
  requireUpload?: unknown;
}): boolean {
  return options.upload === true || options.requireUpload === true;
}

/**
 * Upload a conformance report to the server this command resolved at start,
 * with `MCPJAM_API_KEY` and the `MCPJAM_API_HEADERS` an edge authenticator
 * needs. Resolved here rather than left to the SDK, which reads only its own
 * variables.
 *
 * A failed upload is a warning unless `requireUpload`; a refused address
 * always stops the command, because the result had nowhere it may go.
 */
export async function uploadConformanceReport(
  report: ConformanceRunReportV1,
  args: { serverUrl?: string; requireUpload?: boolean; command: Command },
): Promise<void> {
  const env = process.env;
  const { baseUrl } = resolveCliDeployment({ credential: "api-key" }, { env });
  const headers = resolvePlatformExtraHeaders({}, env);
  const apiKey = env.MCPJAM_API_KEY?.trim();
  const options = {
    serverUrl: args.serverUrl,
    defaultSource: "cli" as const,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
  };
  try {
    const uploaded = args.requireUpload
      ? await reportConformanceRun(report, options)
      : await reportConformanceRunSafely(report, options);
    if (uploaded?.runUrl && !args.command.optsWithGlobals().quiet) {
      process.stderr.write(`Uploaded: ${uploaded.runUrl}\n`);
    }
    if (args.requireUpload && !uploaded) {
      throw new Error("Conformance upload did not return a run record");
    }
  } catch (error) {
    if (args.requireUpload || isMcpjamDeploymentError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: conformance upload failed: ${message}\n`);
  }
}

export async function maybeUploadSingleSuite(args: {
  suiteKind: ConformanceSuiteKind;
  result: unknown;
  report?: ConformanceReport;
  serverUrl?: string;
  upload?: boolean;
  requireUpload?: boolean;
  command: Command;
}): Promise<void> {
  // EXPLICIT ONLY. These commands were local-only before this feature existed,
  // and having an API key exported is not a decision to publish: someone with
  // MCPJAM_API_KEY in their shell running `mcpjam mcp protocol conformance`
  // against a staging server has not asked for that result to land in a
  // project's shared history. `mcpjam conformance run` is the command that
  // treats configured reporting as consent.
  if (!requestsUpload(args)) return;

  const suiteReport =
    args.report ?? toConformanceReport(args.result as never);
  const report = buildConformanceRunReport({
    requestedSuites: [args.suiteKind],
    reports: { [args.suiteKind]: suiteReport },
    startedAt: Date.now() - (suiteReport.durationMs ?? 0),
  });
  await uploadConformanceReport(report, args);
}
