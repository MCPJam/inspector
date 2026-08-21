import {
  buildConformanceRunReport,
  isConformanceReportingConfigured,
  reportConformanceRun,
  reportConformanceRunSafely,
  toConformanceReport,
  type ConformanceReport,
  type ConformanceSuiteKind,
} from "@mcpjam/sdk";
import type { Command } from "commander";

export function addConformanceUploadOptions<T extends Command>(command: T): T {
  return command
    .option(
      "--upload",
      "Upload this suite's result into MCPJam run history",
    )
    .option(
      "--require-upload",
      "Fail if reporting is configured but the UI record cannot be written",
    ) as T;
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
  const shouldUpload =
    args.upload === true ||
    args.requireUpload === true ||
    isConformanceReportingConfigured();
  if (!shouldUpload) return;

  const suiteReport =
    args.report ?? toConformanceReport(args.result as never);
  const report = buildConformanceRunReport({
    requestedSuites: [args.suiteKind],
    reports: { [args.suiteKind]: suiteReport },
    startedAt: Date.now() - (suiteReport.durationMs ?? 0),
  });
  try {
    const uploaded = args.requireUpload
      ? await reportConformanceRun(report, {
          serverUrl: args.serverUrl,
          source: "cli",
        })
      : await reportConformanceRunSafely(report, {
          serverUrl: args.serverUrl,
          source: "cli",
        });
    if (uploaded?.runUrl && !args.command.optsWithGlobals().quiet) {
      process.stderr.write(`Uploaded: ${uploaded.runUrl}\n`);
    }
    if (args.requireUpload && !uploaded) {
      throw new Error("Conformance upload did not return a run record");
    }
  } catch (error) {
    if (args.requireUpload) throw error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: conformance upload failed: ${message}\n`);
  }
}
