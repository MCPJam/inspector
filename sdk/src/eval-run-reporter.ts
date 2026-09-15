import { reportingReceiptError } from "./eval-reporting-receipt.js";
import { LEGACY_SUITE_WIDE_THRESHOLD_PERCENT } from "./contract/grading-policy.js";
import {
  normalizeReportingConfig,
  prepareReportingConfig,
  snapshotReportingInput,
  buildReportingBody,
} from "./eval-reporting-config.js";
import type {
  EvalResultInput,
  EvalReportingReceipt,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import {
  appendEvalRunIterations,
  attachReportingWarnings,
  resolveTerminationStatus,
  chunkResultsForUpload,
  createRuntimeConfig,
  type EvalReportingRuntimeConfig,
  finalizeEvalRun,
  generateExternalRunId,
  printRunUrl,
  projectRunVerdict,
  reportEvalResults,
  reportCaseRunEvaluations,
  startEvalRun,
  requireReportingCapabilities,
  resolveWireHostConfigForRun,
} from "./report-eval-results.js";
import type { PromptResult } from "./PromptResult.js";
import type { EvalRunResult } from "./EvalTest.js";
import { captureEvalReportingFailure } from "./sentry.js";
import {
  resolveServerNames,
  resolveServerReplayConfigs,
} from "./server-replay-configs.js";
import { writeGithubActionReceipt } from "./github-action-receipt.js";
import {
  promptsToEvalResult,
  runToEvalResults,
  suiteRunToEvalResults,
  type PromptsToEvalResultOverrides,
  type RunToEvalResultsOptions,
  type SuiteRunToEvalResultsOptions,
} from "./eval-result-mapping.js";

export type CreateEvalRunReporterInput = Omit<
  ReportEvalResultsInput,
  "results"
> & {
  results?: EvalResultInput[];
  /** Limits include unacknowledged in-flight results. Omitted limits are unbounded. */
  queueLimits?: { maxCount?: number; maxBytes?: number };
};

export interface EvalRunReporter {
  add(result: EvalResultInput): void;
  record(result: EvalResultInput): Promise<void>;
  flush(): Promise<void>;
  finalize(options?: {
    terminalStatus: "cancelled" | "timed_out";
  }): Promise<ReportEvalResultsOutput>;
  /** Always resolves with reporting state, including when strict mode rejects. */
  finalizeWithReceipt(options?: {
    terminalStatus: "cancelled" | "timed_out";
  }): Promise<EvalReportingReceipt>;
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
    > & { failOnToolError?: boolean }
  ): void;

  /**
   * Convert a PromptResult to an EvalResultInput, add it to the buffer, and
   * auto-flush when the buffer is large enough. Calls record() internally.
   */
  recordFromPrompt(
    promptResult: PromptResult,
    overrides?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    > & { failOnToolError?: boolean }
  ): Promise<void>;

  /**
   * Aggregate multiple PromptResults into one EvalResultInput and add it.
   */
  addFromPrompts(
    prompts: PromptResult[],
    overrides: PromptsToEvalResultOverrides
  ): void;

  /**
   * Aggregate multiple PromptResults into one EvalResultInput, add it, and
   * auto-flush when the buffer is large enough.
   */
  recordFromPrompts(
    prompts: PromptResult[],
    overrides: PromptsToEvalResultOverrides
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
  getReportingAccounting(): {
    accepted: number;
    acknowledged: number;
    pending: number;
  };
  getReportingError(): unknown;
  /** Memory-only recovery; may include results committed remotely with a lost response. */
  exportPendingResults(): EvalResultInput[];
}

class EvalRunReporterImpl implements EvalRunReporter {
  private input: CreateEvalRunReporterInput;
  private readonly runtimeConfig: EvalReportingRuntimeConfig;
  private readonly externalRunId: string;
  private runId: string | null = null;
  private finalized = false;
  private completedResult: ReportEvalResultsOutput | null = null;
  private preparation: Promise<CreateEvalRunReporterInput>;
  private preparationApplied = false;
  private reusedReport: ReportEvalResultsOutput | null = null;
  private buffered: EvalResultInput[] = [];
  private generatedIterationCount = 0;
  private expectedIterations: number | undefined;
  private addedCount = 0;
  private passedCount = 0;
  private inFlight: EvalResultInput[] = [];
  private acknowledgedCount = 0;
  private reportingError: unknown;
  private operation: Promise<unknown> = Promise.resolve();
  private finalizing = false;
  private finalizePromise: Promise<ReportEvalResultsOutput> | null = null;
  private readonly acceptedIds = new Set<string>();
  private readonly resultBytes = new Map<string, number>();
  private queuedBytes = 0;

  constructor(input: CreateEvalRunReporterInput) {
    input = normalizeReportingConfig(snapshotReportingInput(input));
    this.preparation = prepareReportingConfig(input);
    // Observe early rejection even when callers postpone their first flush.
    void this.preparation.catch(() => {});
    // Empty CI keeps the one-shot fallback from detecting again at finalize.
    this.input = {
      ...input,
      results: undefined,
      ci: { ...input.ci },
      runMetadata: structuredClone(input.runMetadata),
      runTags: structuredClone(input.runTags),
      queueLimits: input.queueLimits ? { ...input.queueLimits } : undefined,
      verdictPolicy: structuredClone(input.verdictPolicy),
      passCriteria: structuredClone(input.passCriteria),
      serverNames: structuredClone(input.serverNames),
      serverReplayConfigs: structuredClone(input.serverReplayConfigs),
      tags: structuredClone(input.tags),
    };
    this.runtimeConfig = createRuntimeConfig({
      ...input,
      suiteName: input.suiteName,
      results: [],
    } as ReportEvalResultsInput);
    this.externalRunId = input.externalRunId ?? generateExternalRunId();
    this.expectedIterations = input.expectedIterations;
    if (
      this.expectedIterations !== undefined &&
      (!Number.isSafeInteger(this.expectedIterations) ||
        this.expectedIterations < 1)
    )
      throw new TypeError(
        "Expected iterations must be a positive safe integer"
      );
    for (const value of Object.values(input.queueLimits ?? {})) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error("Reporter queue limits must be positive safe integers");
      }
    }
    if (Array.isArray(input.results) && input.results.length > 0) {
      for (const result of input.results) this.add(result);
    }
  }

  add(result: EvalResultInput): void {
    this.ensureNotFinalized();
    const snapshot = structuredClone(result);
    let generated = this.generatedIterationCount;
    let id = snapshot.externalIterationId;
    if (!id) {
      do {
        id = `${this.externalRunId}-${++generated}`;
      } while (this.acceptedIds.has(id));
    }
    if (this.acceptedIds.has(id))
      throw new Error("Duplicate externalIterationId in reporter");
    snapshot.externalIterationId = id;
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    if (
      this.getBufferedCount() + 1 >
        (this.input.queueLimits?.maxCount ?? Infinity) ||
      this.queuedBytes + bytes > (this.input.queueLimits?.maxBytes ?? Infinity)
    ) {
      throw new Error(
        "Eval run reporter queue limit exceeded; flush before adding more results"
      );
    }
    if (!result.externalIterationId) this.generatedIterationCount = generated;
    this.acceptedIds.add(id);
    this.resultBytes.set(id, bytes);
    this.queuedBytes += bytes;
    this.buffered.push(snapshot);
    this.recordAddedResult(snapshot);
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
    > & { failOnToolError?: boolean }
  ): void {
    this.add(
      promptResult.toEvalResult({
        ...overrides,
        failOnToolError:
          overrides?.failOnToolError !== undefined
            ? overrides.failOnToolError
            : this.input.failOnToolError,
      })
    );
  }

  async recordFromPrompt(
    promptResult: PromptResult,
    overrides?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    > & { failOnToolError?: boolean }
  ): Promise<void> {
    await this.record(
      promptResult.toEvalResult({
        ...overrides,
        failOnToolError:
          overrides?.failOnToolError !== undefined
            ? overrides.failOnToolError
            : this.input.failOnToolError,
      })
    );
  }

  addFromPrompts(
    prompts: PromptResult[],
    overrides: PromptsToEvalResultOverrides
  ): void {
    this.add(
      promptsToEvalResult(prompts, {
        ...overrides,
        failOnToolError:
          overrides.failOnToolError !== undefined
            ? overrides.failOnToolError
            : this.input.failOnToolError,
      })
    );
  }

  async recordFromPrompts(
    prompts: PromptResult[],
    overrides: PromptsToEvalResultOverrides
  ): Promise<void> {
    await this.record(
      promptsToEvalResult(prompts, {
        ...overrides,
        failOnToolError:
          overrides.failOnToolError !== undefined
            ? overrides.failOnToolError
            : this.input.failOnToolError,
      })
    );
  }

  addFromRun(run: EvalRunResult, options: RunToEvalResultsOptions): void {
    const results = runToEvalResults(run, {
      ...options,
      failOnToolError:
        options.failOnToolError !== undefined
          ? options.failOnToolError
          : this.input.failOnToolError,
    });
    for (const result of results) {
      this.add(result);
    }
  }

  async recordFromRun(
    run: EvalRunResult,
    options: RunToEvalResultsOptions
  ): Promise<void> {
    const results = runToEvalResults(run, {
      ...options,
      failOnToolError:
        options.failOnToolError !== undefined
          ? options.failOnToolError
          : this.input.failOnToolError,
    });
    for (const result of results) {
      await this.record(result);
    }
  }

  addFromSuiteRun(
    suiteRun: Map<string, EvalRunResult>,
    options: SuiteRunToEvalResultsOptions
  ): void {
    const results = suiteRunToEvalResults(suiteRun, {
      ...options,
      failOnToolError:
        options.failOnToolError !== undefined
          ? options.failOnToolError
          : this.input.failOnToolError,
    });
    for (const result of results) {
      this.add(result);
    }
  }

  async recordFromSuiteRun(
    suiteRun: Map<string, EvalRunResult>,
    options: SuiteRunToEvalResultsOptions
  ): Promise<void> {
    const results = suiteRunToEvalResults(suiteRun, {
      ...options,
      failOnToolError:
        options.failOnToolError !== undefined
          ? options.failOnToolError
          : this.input.failOnToolError,
    });
    for (const result of results) {
      await this.record(result);
    }
  }

  getAddedCount(): number {
    return this.addedCount;
  }

  private async applyPreparation(): Promise<void> {
    if (this.preparationApplied) return;
    const terminalStatus = this.input.terminalStatus;
    this.input = {
      ...this.input,
      ...(await this.preparation),
      ...(terminalStatus ? { terminalStatus } : {}),
    };
    this.preparationApplied = true;
  }

  flush(): Promise<void> {
    this.ensureNotFinalized();
    return this.enqueue(async () => {
      await this.flushInternal();
    });
  }

  private async flushInternal(): Promise<void> {
    if (this.buffered.length === 0) {
      return;
    }
    this.inFlight = this.buffered;
    this.buffered = [];
    this.reportingError = undefined;
    try {
      await this.applyPreparation();
      const serverReplayConfigs = resolveServerReplayConfigs(this.input);
      if (!this.runId) {
        await requireReportingCapabilities(this.runtimeConfig, this.input);
        const started = await startEvalRun(this.runtimeConfig, {
          ...buildReportingBody(this.input),
          serverNames: resolveServerNames(this.input, serverReplayConfigs),
          suiteName: this.input.suiteName,
          serverReplayConfigs,
          externalRunId: this.externalRunId,
          expectedIterations: this.expectedIterations,
          ...((await resolveWireHostConfigForRun({
            ...this.input,
            results: this.inFlight,
          })) ?? {}),
        });
        this.runId = started.runId;
        if (
          started.reused &&
          started.status === "completed" &&
          started.result &&
          started.summary
        ) {
          this.reusedReport = {
            suiteId: started.suiteId,
            runId: started.runId,
            ...(started.projectId ? { projectId: started.projectId } : {}),
            status: "completed",
            ...projectRunVerdict(started),
            summary: started.summary,
          };
        }
      }

      if (!this.runId || this.finalized) {
        return;
      }

      const withIds = this.inFlight;
      const uploadReady = withIds;
      const chunks = chunkResultsForUpload(uploadReady);
      for (const chunk of chunks) {
        const receipt = await appendEvalRunIterations(this.runtimeConfig, {
          runId: this.runId,
          results: chunk,
        });
        if (
          !Number.isSafeInteger(receipt.inserted) ||
          receipt.inserted < 0 ||
          !Number.isSafeInteger(receipt.skipped) ||
          receipt.skipped < 0 ||
          receipt.inserted + receipt.skipped !== chunk.length
        ) {
          throw new Error("Incomplete iteration upload acknowledgment");
        }
        const acknowledged = this.inFlight.splice(0, chunk.length);
        this.acknowledgedCount += acknowledged.length;
        for (const result of acknowledged) {
          this.queuedBytes -=
            this.resultBytes.get(result.externalIterationId!) ?? 0;
          this.resultBytes.delete(result.externalIterationId!);
        }
      }
    } catch (error) {
      this.reportingError = error;
      this.buffered = [...this.inFlight, ...this.buffered];
      this.inFlight = [];
      await captureEvalReportingFailure(error, {
        apiKey: this.runtimeConfig.apiKey,
        baseUrl: this.runtimeConfig.baseUrl,
        project: this.runtimeConfig.project,
        bufferedCount: this.buffered.length,
        entrypoint: "evalRunReporter.flush",
        resultCount: this.buffered.length,
        runId: this.runId,
        suiteName: this.input.suiteName,
      });
      if (this.input.strict) {
        throw error;
      }
    }
  }

  finalize(options?: {
    terminalStatus: "cancelled" | "timed_out";
  }): Promise<ReportEvalResultsOutput> {
    if (options) {
      if (!["cancelled", "timed_out"].includes(options.terminalStatus))
        throw new TypeError("terminalStatus must be cancelled or timed_out");
      if (
        (this.finalizing || this.finalized) &&
        options.terminalStatus !== this.input.terminalStatus
      )
        throw new Error(
          "Cannot change termination after finalization has started"
        );
      this.input = { ...this.input, terminalStatus: options.terminalStatus };
    }
    if (this.completedResult) return Promise.resolve(this.completedResult);
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizing = true;
    this.finalizePromise = this.enqueue(() => this.finalizeInternal()).finally(
      () => {
        this.finalizing = false;
        this.finalizePromise = null;
      }
    );
    return this.finalizePromise;
  }

  async finalizeWithReceipt(options?: {
    terminalStatus: "cancelled" | "timed_out";
  }): Promise<EvalReportingReceipt> {
    let report: ReportEvalResultsOutput | undefined;
    let failure: unknown;
    try {
      report = await this.finalize(options);
    } catch (error) {
      failure = error;
    }
    const reportingError = failure ?? this.reportingError;
    const accounting = this.getReportingAccounting();
    const persisted =
      !!report?.runId && !reportingError && accounting.pending === 0;
    // The one-shot helper can have acknowledged earlier chunks before failing.
    const unknown = !!reportingError && !this.runId;
    return {
      schemaVersion: 1,
      state: persisted ? "persisted" : "failed",
      acceptedIterations: accounting.accepted,
      acknowledgedIterations: unknown ? null : accounting.acknowledged,
      pendingIterations: unknown ? null : accounting.pending,
      ...(report?.warnings?.length
        ? { warnings: structuredClone(report.warnings) }
        : {}),
      ...(persisted
        ? { report }
        : { error: reportingReceiptError(reportingError) }),
    };
  }

  private async finalizeInternal(): Promise<ReportEvalResultsOutput> {
    await this.applyPreparation();
    if (this.completedResult) {
      return this.completedResult;
    }
    if (!this.runId) {
      const serverReplayConfigs = resolveServerReplayConfigs(this.input);
      const reportInput: ReportEvalResultsInput = {
        ...this.input,
        suiteName: this.input.suiteName,
        serverReplayConfigs,
        externalRunId: this.externalRunId,
        expectedIterations: this.expectedIterations,
        results: this.buffered,
      };

      try {
        const oneShotResult = await reportEvalResults(reportInput);
        this.reportingError = undefined;
        this.acknowledgedCount += this.buffered.length;
        this.buffered = [];
        this.queuedBytes = 0;
        this.resultBytes.clear();
        this.completedResult = oneShotResult;
        this.finalized = true;
        return oneShotResult;
      } catch (error) {
        this.reportingError = error;
        if (this.input.strict) throw error;
        return this.buildLocalFallbackResult();
      }
    }

    try {
      this.reportingError = undefined;
      await this.flushInternal();
      if (this.reportingError) return this.buildLocalFallbackResult();
      if (this.completedResult) {
        return this.completedResult;
      }
      const terminalStatus = await resolveTerminationStatus(
        this.runtimeConfig,
        this.input
      );
      const result =
        (terminalStatus ? undefined : this.reusedReport) ??
        (await finalizeEvalRun(this.runtimeConfig, {
          runId: this.runId,
          externalRunId: this.externalRunId,
          ...(terminalStatus ? { terminalStatus } : {}),
        }));
      if (this.input.runEvaluations?.length)
        await reportCaseRunEvaluations(
          this.runtimeConfig,
          result.runId,
          this.externalRunId,
          this.input.runEvaluations
        );
      const reported = attachReportingWarnings(this.runtimeConfig, result);
      await writeGithubActionReceipt(this.runtimeConfig, this.input, reported);
      printRunUrl(this.runtimeConfig, reported);
      this.completedResult = reported;
      this.finalized = true;
      return reported;
    } catch (error) {
      this.reportingError = error;
      await captureEvalReportingFailure(error, {
        apiKey: this.runtimeConfig.apiKey,
        baseUrl: this.runtimeConfig.baseUrl,
        project: this.runtimeConfig.project,
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
      return localResult;
    }
  }

  getBufferedCount(): number {
    return this.buffered.length + this.inFlight.length;
  }

  setExpectedIterations(count: number): void {
    this.ensureNotFinalized();
    if (this.runId || this.inFlight.length)
      throw new Error("Expected iterations are frozen after reporting starts");
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error("Expected iterations must be a positive safe integer");
    this.expectedIterations = count;
  }

  private ensureNotFinalized(): void {
    if (this.finalized || this.finalizing) {
      throw new Error("Eval run reporter has already been finalized");
    }
  }

  getReportingAccounting() {
    return {
      accepted: this.addedCount,
      acknowledged: this.acknowledgedCount,
      pending: this.getBufferedCount(),
    };
  }

  getReportingError(): unknown {
    return this.reportingError;
  }

  exportPendingResults(): EvalResultInput[] {
    return structuredClone([...this.inFlight, ...this.buffered]);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation);
    this.operation = next.catch(() => {});
    return next;
  }

  /**
   * The summary this reporter produces when the run could not be reported.
   *
   * A NAMED legacy adapter, and one of the three suite-wide producers the
   * grading-policy contract distinguishes: it counts the results it was HANDED,
   * one per iteration, `failed` is the remainder rather than a classification,
   * and an empty population rates `0` — where the hosted run finalizer rates
   * the same empty run `1`. The arithmetic is deliberately unchanged;
   * `resolveGradingPolicyFromRunReporting({ producer: "localFallback" })` is
   * how a surface names which rule decided a summary from here, and
   * `LEGACY_SUITE_WIDE_THRESHOLD_PERCENT` replaces the bare `100` so the
   * producer fallback is spelled once across the repo.
   */
  private buildLocalFallbackResult(): ReportEvalResultsOutput {
    const total = this.addedCount;
    const passed = this.passedCount;
    const failed = total - passed;
    const passRate = total > 0 ? passed / total : 0;
    const minimumPassRate =
      this.input.passCriteria?.minimumPassRate ??
      LEGACY_SUITE_WIDE_THRESHOLD_PERCENT;
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
