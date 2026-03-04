import type {
  EvalResultInput,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import {
  appendEvalRunIterations,
  chunkResultsForUpload,
  createRuntimeConfig,
  type EvalReportingRuntimeConfig,
  finalizeEvalRun,
  generateExternalRunId,
  reportEvalResults,
  reportEvalResultsSafely,
  startEvalRun,
  withExternalIterationIds,
} from "./report-eval-results.js";

export type CreateEvalRunReporterInput = Omit<
  ReportEvalResultsInput,
  "results"
> & {
  results?: EvalResultInput[];
};

export interface EvalRunReporter {
  add(result: EvalResultInput): void;
  record(result: EvalResultInput): Promise<void>;
  flush(): Promise<void>;
  finalize(): Promise<ReportEvalResultsOutput>;
  getBufferedCount(): number;
}

class EvalRunReporterImpl implements EvalRunReporter {
  private readonly input: CreateEvalRunReporterInput;
  private readonly runtimeConfig: EvalReportingRuntimeConfig;
  private readonly externalRunId: string;
  private runId: string | null = null;
  private finalized = false;
  private completedResult: ReportEvalResultsOutput | null = null;
  private buffered: EvalResultInput[] = [];

  constructor(input: CreateEvalRunReporterInput) {
    this.input = input;
    this.runtimeConfig = createRuntimeConfig({
      ...input,
      suiteName: input.suiteName,
      results: [],
    } as ReportEvalResultsInput);
    this.externalRunId = input.externalRunId ?? generateExternalRunId();
    if (Array.isArray(input.results) && input.results.length > 0) {
      this.buffered.push(...input.results);
    }
  }

  add(result: EvalResultInput): void {
    this.ensureNotFinalized();
    this.buffered.push(result);
  }

  async record(result: EvalResultInput): Promise<void> {
    this.add(result);
    const preview = chunkResultsForUpload(this.buffered, 200, 1024 * 1024);
    if (preview.length > 1 || this.buffered.length >= 200) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    this.ensureNotFinalized();
    if (this.buffered.length === 0) {
      return;
    }
    if (!this.runId) {
      const started = await startEvalRun(this.runtimeConfig, {
        suiteName: this.input.suiteName,
        suiteDescription: this.input.suiteDescription,
        serverNames: this.input.serverNames,
        notes: this.input.notes,
        passCriteria: this.input.passCriteria,
        externalRunId: this.externalRunId,
        framework: this.input.framework,
        ci: this.input.ci,
      });
      this.runId = started.runId;
      if (
        started.reused &&
        started.status === "completed" &&
        started.result &&
        started.summary
      ) {
        this.completedResult = {
          suiteId: started.suiteId,
          runId: started.runId,
          status: started.status as "completed" | "failed",
          result: started.result as "passed" | "failed",
          summary: started.summary,
        };
        this.finalized = true;
        this.buffered = [];
      }
    }

    if (!this.runId || this.finalized) {
      return;
    }

    const withIds = withExternalIterationIds(this.buffered, this.externalRunId);
    const chunks = chunkResultsForUpload(withIds);
    for (const chunk of chunks) {
      await appendEvalRunIterations(this.runtimeConfig, {
        runId: this.runId,
        results: chunk,
      });
    }
    this.buffered = [];
  }

  async finalize(): Promise<ReportEvalResultsOutput> {
    if (this.completedResult) {
      return this.completedResult;
    }
    this.ensureNotFinalized();

    if (!this.runId) {
      const reportInput: ReportEvalResultsInput = {
        suiteName: this.input.suiteName,
        suiteDescription: this.input.suiteDescription,
        serverNames: this.input.serverNames,
        notes: this.input.notes,
        passCriteria: this.input.passCriteria,
        externalRunId: this.externalRunId,
        framework: this.input.framework,
        ci: this.input.ci,
        apiKey: this.input.apiKey,
        baseUrl: this.input.baseUrl,
        strict: this.input.strict,
        results: this.buffered,
      };

      const oneShotResult = this.input.strict
        ? await reportEvalResults(reportInput)
        : await reportEvalResultsSafely(reportInput);

      if (!oneShotResult) {
        const localResult = this.buildLocalFallbackResult();
        this.completedResult = localResult;
        this.finalized = true;
        this.buffered = [];
        return localResult;
      }

      this.completedResult = oneShotResult;
      this.finalized = true;
      this.buffered = [];
      return oneShotResult;
    }

    await this.flush();
    const result = await finalizeEvalRun(this.runtimeConfig, {
      runId: this.runId,
      externalRunId: this.externalRunId,
    });
    this.completedResult = result;
    this.finalized = true;
    return result;
  }

  getBufferedCount(): number {
    return this.buffered.length;
  }

  private ensureNotFinalized(): void {
    if (this.finalized) {
      throw new Error("Eval run reporter has already been finalized");
    }
  }

  private buildLocalFallbackResult(): ReportEvalResultsOutput {
    const total = this.buffered.length;
    const passed = this.buffered.filter((result) => result.passed).length;
    const failed = total - passed;
    const passRate = total > 0 ? passed / total : 0;
    const minimumPassRate = this.input.passCriteria?.minimumPassRate ?? 100;
    const result = passRate * 100 >= minimumPassRate ? "passed" : "failed";

    return {
      suiteId: "",
      runId: "",
      status: "failed",
      result,
      summary: {
        total,
        passed,
        failed,
        passRate,
      },
    };
  }
}

export function createEvalRunReporter(
  input: CreateEvalRunReporterInput
): EvalRunReporter {
  return new EvalRunReporterImpl(input);
}
