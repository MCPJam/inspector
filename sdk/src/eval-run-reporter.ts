import type {
  EvalCiMetadata,
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
} from "./report-eval-results.js";

export type CreateEvalRunReporterInput = Omit<
  ReportEvalResultsInput,
  "results" | "framework" | "ci"
> & {
  ci?: Omit<EvalCiMetadata, "provider">;
  results?: EvalResultInput[];
};

export interface EvalRunReporter {
  add(result: EvalResultInput): void;
  record(result: EvalResultInput): Promise<void>;
  flush(): Promise<void>;
  finalize(): Promise<ReportEvalResultsOutput>;
  getBufferedCount(): number;
  setExpectedIterations(count: number): void;
}

class EvalRunReporterImpl implements EvalRunReporter {
  private readonly input: CreateEvalRunReporterInput;
  private readonly runtimeConfig: EvalReportingRuntimeConfig;
  private readonly externalRunId: string;
  private runId: string | null = null;
  private finalized = false;
  private completedResult: ReportEvalResultsOutput | null = null;
  private buffered: EvalResultInput[] = [];
  private generatedIterationCount = 0;
  private expectedIterations: number | undefined;

  constructor(input: CreateEvalRunReporterInput) {
    this.input = input;
    this.runtimeConfig = createRuntimeConfig({
      ...input,
      suiteName: input.suiteName,
      results: [],
    } as ReportEvalResultsInput);
    this.externalRunId = input.externalRunId ?? generateExternalRunId();
    this.expectedIterations = input.expectedIterations;
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
        ci: this.withoutCiProvider(this.input.ci),
        expectedIterations: this.expectedIterations,
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

    const uploadReady = this.withUniqueExternalIterationIds(this.buffered);
    const chunks = chunkResultsForUpload(uploadReady);
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
        ci: this.withoutCiProvider(this.input.ci),
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

  setExpectedIterations(count: number): void {
    this.expectedIterations = count;
  }

  private ensureNotFinalized(): void {
    if (this.finalized) {
      throw new Error("Eval run reporter has already been finalized");
    }
  }

  private withUniqueExternalIterationIds(
    results: EvalResultInput[]
  ): EvalResultInput[] {
    return results.map((result) => {
      if (result.externalIterationId) {
        return result;
      }
      this.generatedIterationCount += 1;
      return {
        ...result,
        externalIterationId: `${this.externalRunId}-${this.generatedIterationCount}`,
      };
    });
  }

  private withoutCiProvider(
    ci: CreateEvalRunReporterInput["ci"] | EvalCiMetadata | undefined
  ): Omit<EvalCiMetadata, "provider"> | undefined {
    if (!ci) {
      return undefined;
    }
    const { provider: _provider, ...rest } = ci as EvalCiMetadata & {
      [key: string]: unknown;
    };
    return rest;
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
