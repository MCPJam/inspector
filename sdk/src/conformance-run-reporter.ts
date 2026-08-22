import type { ConformanceReport } from "./conformance-reporting.js";
import {
  finalizeConformanceRun,
  reportConformanceRun,
  reportConformanceRunSafely,
  startConformanceRun,
  uploadConformanceSuiteReport,
  type ReportConformanceRunOptions,
  type ReportConformanceRunOutput,
} from "./report-conformance-run.js";
import type {
  ConformanceRunReportV1,
  ConformanceSuiteKind,
} from "./conformance-run-types.js";

export interface ConformanceRunReporter {
  start(): Promise<ReportConformanceRunOutput>;
  recordSuite(
    suiteKind: ConformanceSuiteKind,
    report: ConformanceReport,
  ): Promise<void>;
  finalize(): Promise<ReportConformanceRunOutput>;
}

export function createConformanceRunReporter(
  snapshot: Pick<
    ConformanceRunReportV1,
    "requestedSuites" | "protocolVersion" | "engineVersion"
  >,
  options: ReportConformanceRunOptions = {},
): ConformanceRunReporter {
  let started: ReportConformanceRunOutput | null = null;
  return {
    async start() {
      started = await startConformanceRun(snapshot, options);
      return started;
    },
    async recordSuite(suiteKind, report) {
      if (!started) started = await startConformanceRun(snapshot, options);
      await uploadConformanceSuiteReport(
        started.runId,
        suiteKind,
        report,
        options,
      );
    },
    async finalize() {
      if (!started) started = await startConformanceRun(snapshot, options);
      return await finalizeConformanceRun(started.runId, options);
    },
  };
}

export {
  reportConformanceRun,
  reportConformanceRunSafely,
};
