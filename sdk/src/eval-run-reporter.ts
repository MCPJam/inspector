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
import type { PromptResult } from "./PromptResult.js";
import type { EvalRunResult } from "./EvalTest.js";
import { captureEvalReportingFailure } from "./sentry.js";
import {
  runToEvalResults,
  suiteRunToEvalResults,
  type RunToEvalResultsOptions,
  type SuiteRunToEvalResultsOptions,
} from "./eval-result-mapping.js";

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

  /**
   * Convert a PromptResult to an EvalResultInput and add it to the buffer.
   * Provider and model default to the prompt's metadata unless overridden.
   */
  addFromPrompt(
    promptResult: PromptResult,
    overrides?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    >
  ): void;

  /**
   * Convert a PromptResult to an EvalResultInput, add it to the buffer, and
   * auto-flush when the buffer is large enough. Calls record() internally.
   */
  recordFromPrompt(
    promptResult: PromptResult,
    overrides?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    >
  ): Promise<void>;

  /**
   * Convert all iterations from an EvalTest run to EvalResultInputs and add them.
   */
  addFromRun(run: EvalRunResult, options: RunToEvalResultsOptions): void;

  /**
   * Convert all iterations from an EvalTest run to EvalResultInputs,
   * add them, and auto-flush.
   */
  recordFromRun(
    run: EvalRunResult,
    options: RunToEvalResultsOptions
  ): Promise<void>;

  /**
   * Convert all iterations from an EvalSuite run to EvalResultInputs and add them.
   */
  addFromSuiteRun(
    suiteRun: Map<string, EvalRunResult>,
    options: SuiteRunToEvalResultsOptions
  ): void;

  /**
   * Convert all iterations from an EvalSuite run to EvalResultInputs,
   * add them, and auto-flush.
   */
  recordFromSuiteRun(
    suiteRun: Map<string, EvalRunResult>,
    options: SuiteRunToEvalResultsOptions
  ): Promise<void>;

  /**
   * Get the total count of results added (including via helper methods).
   */
  getAddedCount(): number;
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
  private addedCount = 0;
  private passedCount = 0;

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
      for (const result of input.results) {
        this.recordAddedResult(result);
      }
    }
  }

  add(result: EvalResultInput): void {
    this.ensureNotFinalized();
    this.buffered.push(result);
    this.recordAddedResult(result);
  }

  async record(result: EvalResultInput): Promise<void> {
    this.add(result);
    const preview = chunkResultsForUpload(this.buffered, 200, 1024 * 1024);
    if (preview.length > 1 || this.buffered.length >= 200) {
      await this.flush();
    }
  }

  addFromPrompt(
    promptResult: PromptResult,
    overrides?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    >
  ): void {
    this.add(promptResult.toEvalResult(overrides));
  }

  async recordFromPrompt(
    promptResult: PromptResult,
    overrides?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    >
  ): Promise<void> {
    await this.record(promptResult.toEvalResult(overrides));
  }

  addFromRun(run: EvalRunResult, options: RunToEvalResultsOptions): void {
    const results = runToEvalResults(run, options);
    for (const result of results) {
      this.add(result);
    }
  }

  async recordFromRun(
    run: EvalRunResult,
    options: RunToEvalResultsOptions
  ): Promise<void> {
    const results = runToEvalResults(run, options);
    for (const result of results) {
      await this.record(result);
    }
  }

  addFromSuiteRun(
    suiteRun: Map<string, EvalRunResult>,
    options: SuiteRunToEvalResultsOptions
  ): void {
    const results = suiteRunToEvalResults(suiteRun, options);
    for (const result of results) {
      this.add(result);
    }
  }

  async recordFromSuiteRun(
    suiteRun: Map<string, EvalRunResult>,
    options: SuiteRunToEvalResultsOptions
  ): Promise<void> {
    const results = suiteRunToEvalResults(suiteRun, options);
    for (const result of results) {
      await this.record(result);
    }
  }

  getAddedCount(): number {
    return this.addedCount;
  }

  async flush(): Promise<void> {
    this.ensureNotFinalized();
    if (this.buffered.length === 0) {
      return;
    }
    try {
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
    } catch (error) {
      await captureEvalReportingFailure(error, {
        apiKey: this.runtimeConfig.apiKey,
        baseUrl: this.runtimeConfig.baseUrl,
        bufferedCount: this.buffered.length,
        entrypoint: "evalRunReporter.flush",
        resultCount: this.buffered.length,
        runId: this.runId,
        suiteName: this.input.suiteName,
      });
      if (this.input.strict) {
        throw error;
      }
      this.completedResult = this.buildLocalFallbackResult();
      this.finalized = true;
      this.buffered = [];
    }
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

    try {
      await this.flush();
      if (this.completedResult) {
        return this.completedResult;
      }
      const result = await finalizeEvalRun(this.runtimeConfig, {
        runId: this.runId,
        externalRunId: this.externalRunId,
      });
      this.completedResult = result;
      this.finalized = true;
      return result;
    } catch (error) {
      await captureEvalReportingFailure(error, {
        apiKey: this.runtimeConfig.apiKey,
        baseUrl: this.runtimeConfig.baseUrl,
        bufferedCount: this.buffered.length,
        entrypoint: "evalRunReporter.finalize",
        resultCount: this.buffered.length,
        runId: this.runId,
        suiteName: this.input.suiteName,
      });
      if (this.input.strict) {
        throw error;
      }
      const localResult = this.buildLocalFallbackResult();
      this.completedResult = localResult;
      this.finalized = true;
      return localResult;
    }
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
    const total = this.addedCount;
    const passed = this.passedCount;
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

  private recordAddedResult(result: EvalResultInput): void {
    this.addedCount += 1;
    if (result.passed) {
      this.passedCount += 1;
    }
  }
}

export function createEvalRunReporter(
  input: CreateEvalRunReporterInput
): EvalRunReporter {
  return new EvalRunReporterImpl(input);
}
