import type {
  EvalResultInput,
  EvalWidgetSnapshotInput,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import { EvalReportingError } from "./errors.js";
import { addBreadcrumb, captureEvalReportingFailure } from "./sentry.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1750];
const CHUNK_SIZE_LIMIT = 200;
const ONE_SHOT_RESULT_LIMIT = 200;
const CHUNK_TARGET_BYTES = 1024 * 1024;

export const DEFAULT_MCPJAM_BASE_URL = "https://sdk.mcpjam.com";

type RuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  retryDelaysMs: number[];
};

type StartRunResponse = {
  suiteId: string;
  runId: string;
  reused?: boolean;
  status?: string;
  result?: string;
  summary?: ReportEvalResultsOutput["summary"];
};

type AppendIterationsResponse = {
  inserted: number;
  skipped: number;
  total: number;
};

type BackendEnvelope<T> = {
  ok?: boolean;
  error?: string;
} & T;

type EvalArtifactUploadUrlResponse = {
  uploadUrl: string;
};

function resolveApiKey(input: Pick<ReportEvalResultsInput, "apiKey">): string | undefined {
  return input.apiKey ?? process.env.MCPJAM_API_KEY;
}

function resolveBaseUrl(input: Pick<ReportEvalResultsInput, "baseUrl">): string {
  return trimTrailingSlash(
    input.baseUrl ?? process.env.MCPJAM_BASE_URL ?? DEFAULT_MCPJAM_BASE_URL
  );
}

function getResultCount(results: ReportEvalResultsInput["results"]): number | undefined {
  return Array.isArray(results) ? results.length : undefined;
}

function buildFailureContext(
  input: ReportEvalResultsInput,
  entrypoint: string
): Parameters<typeof captureEvalReportingFailure>[1] {
  return {
    apiKey: resolveApiKey(input),
    baseUrl: resolveBaseUrl(input),
    entrypoint,
    framework: input.framework,
    resultCount: getResultCount(input.results),
    suiteName: input.suiteName,
  };
}

function toEvalReportingError(
  error: unknown,
  endpoint: string,
  attemptCount: number,
  statusCode?: number
): EvalReportingError {
  if (error instanceof EvalReportingError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new EvalReportingError(message, {
    attemptCount,
    cause: error,
    endpoint,
    statusCode,
  });
}

function getByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base: number): number {
  const variance = Math.floor(base * 0.2);
  return base + Math.floor((Math.random() * 2 - 1) * variance);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function generateExternalRunId(): string {
  return `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function withExternalIterationIds(
  results: EvalResultInput[],
  externalRunId: string
): EvalResultInput[] {
  return results.map((result, index) => {
    if (result.externalIterationId) {
      return result;
    }
    return {
      ...result,
      externalIterationId: `${externalRunId}-${index + 1}`,
    };
  });
}

function chunkResultsForUpload(
  results: EvalResultInput[],
  maxCount: number = CHUNK_SIZE_LIMIT,
  maxBytes: number = CHUNK_TARGET_BYTES
): EvalResultInput[][] {
  const chunks: EvalResultInput[][] = [];
  let currentChunk: EvalResultInput[] = [];

  for (const result of results) {
    const candidate = [...currentChunk, result];
    const candidateBytes = getByteLength(
      JSON.stringify({ results: candidate })
    );
    const shouldSplit =
      currentChunk.length >= maxCount ||
      (candidateBytes > maxBytes && currentChunk.length > 0);

    if (shouldSplit) {
      chunks.push(currentChunk);
      currentChunk = [result];
      continue;
    }

    currentChunk = candidate;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function createRuntimeConfig(input: ReportEvalResultsInput): RuntimeConfig {
  const apiKey = resolveApiKey(input);
  if (!apiKey) {
    throw new Error("Missing MCPJAM API key");
  }

  return {
    apiKey,
    baseUrl: resolveBaseUrl(input),
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
  };
}

async function requestWithRetry<T>(
  config: RuntimeConfig,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);

      let responseBody: BackendEnvelope<T> | undefined;
      try {
        responseBody = (await response.json()) as BackendEnvelope<T>;
      } catch {
        responseBody = undefined;
      }

      if (response.ok) {
        if (responseBody && responseBody.ok === false) {
          const message = responseBody.error ?? "Unknown SDK evals error";
          throw new Error(message);
        }
        return (responseBody ?? {}) as T;
      }

      const message =
        responseBody?.error ??
        `Request failed with status ${response.status}: ${response.statusText}`;
      if (
        isRetryableStatus(response.status) &&
        attempt < config.retryDelaysMs.length
      ) {
        await sleep(jitter(config.retryDelaysMs[attempt]));
        continue;
      }

      throw new EvalReportingError(message, {
        attemptCount: attempt + 1,
        endpoint: path,
        statusCode: response.status,
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      lastError = error;

      const isAbortError =
        error instanceof Error && error.name === "AbortError";
      const errorStatusCode =
        error instanceof EvalReportingError ? error.statusCode : undefined;
      const shouldRetry =
        isAbortError ||
        error instanceof TypeError ||
        (typeof errorStatusCode === "number" &&
          isRetryableStatus(errorStatusCode)) ||
        (error instanceof Error &&
          /network|fetch|timeout|429|5\d\d/i.test(error.message));

      if (shouldRetry && attempt < config.retryDelaysMs.length) {
        await sleep(jitter(config.retryDelaysMs[attempt]));
        continue;
      }

      throw toEvalReportingError(error, path, attempt + 1, errorStatusCode);
    }
  }

  throw toEvalReportingError(
    lastError ?? new Error("Failed to send eval report"),
    path,
    config.retryDelaysMs.length + 1
  );
}

async function startEvalRun(
  config: RuntimeConfig,
  payload: Omit<ReportEvalResultsInput, "results" | "strict"> & {
    externalRunId: string;
    synthesizedTests?: unknown[];
  }
): Promise<StartRunResponse> {
  return await requestWithRetry<StartRunResponse>(
    config,
    "/sdk/v1/evals/runs/start",
    payload
  );
}

async function appendEvalRunIterations(
  config: RuntimeConfig,
  payload: {
    runId: string;
    results: EvalResultInput[];
  }
): Promise<AppendIterationsResponse> {
  return await requestWithRetry<AppendIterationsResponse>(
    config,
    "/sdk/v1/evals/runs/iterations",
    payload
  );
}

async function finalizeEvalRun(
  config: RuntimeConfig,
  payload: {
    runId: string;
    externalRunId: string;
  }
): Promise<ReportEvalResultsOutput> {
  return await requestWithRetry<ReportEvalResultsOutput>(
    config,
    "/sdk/v1/evals/runs/finalize",
    payload
  );
}

async function getEvalArtifactUploadUrl(
  config: RuntimeConfig
): Promise<string> {
  const response = await requestWithRetry<EvalArtifactUploadUrlResponse>(
    config,
    "/sdk/v1/evals/artifacts/upload-url",
    {}
  );
  if (!response.uploadUrl) {
    throw new Error("Eval artifact upload URL response was missing uploadUrl");
  }
  return response.uploadUrl;
}

async function uploadBlobToConvex(
  config: RuntimeConfig,
  uploadUrl: string,
  body: string,
  contentType: string
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt++) {
    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
        },
        body,
      });

      const responseBody = (await response.json().catch(() => ({}))) as {
        storageId?: string;
        error?: string;
      };

      if (response.ok && responseBody.storageId) {
        return responseBody.storageId;
      }

      const message =
        responseBody.error ??
        `Artifact upload failed with status ${response.status}: ${response.statusText}`;
      if (
        isRetryableStatus(response.status) &&
        attempt < config.retryDelaysMs.length
      ) {
        await sleep(jitter(config.retryDelaysMs[attempt]));
        continue;
      }

      throw new Error(message);
    } catch (error) {
      lastError = error;
      const shouldRetry =
        error instanceof TypeError ||
        (error instanceof Error &&
          /network|fetch|timeout|429|5\d\d/i.test(error.message));
      if (shouldRetry && attempt < config.retryDelaysMs.length) {
        await sleep(jitter(config.retryDelaysMs[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to upload eval artifact");
}

function removeInlineWidgetHtml(
  snapshot: EvalWidgetSnapshotInput
): EvalWidgetSnapshotInput {
  const { widgetHtml: _widgetHtml, ...rest } = snapshot;
  return rest;
}

async function uploadWidgetSnapshots(
  config: RuntimeConfig,
  results: EvalResultInput[]
): Promise<EvalResultInput[]> {
  const rewrittenResults: EvalResultInput[] = [];

  for (const result of results) {
    const snapshots = result.widgetSnapshots;
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      rewrittenResults.push(result);
      continue;
    }

    const uploadedSnapshots: EvalWidgetSnapshotInput[] = [];

    for (const snapshot of snapshots) {
      if (snapshot.widgetHtmlBlobId) {
        uploadedSnapshots.push(removeInlineWidgetHtml(snapshot));
        continue;
      }

      if (!snapshot.widgetHtml) {
        console.warn(
          `[mcpjam/sdk] skipped widget snapshot upload for "${snapshot.toolName}": widgetHtml was missing`
        );
        continue;
      }

      try {
        const uploadUrl = await getEvalArtifactUploadUrl(config);
        const storageId = await uploadBlobToConvex(
          config,
          uploadUrl,
          snapshot.widgetHtml,
          "text/html; charset=utf-8"
        );
        uploadedSnapshots.push(
          removeInlineWidgetHtml({
            ...snapshot,
            widgetHtmlBlobId: storageId,
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await addBreadcrumb({
          category: "eval-reporting.widget-upload",
          data: {
            baseUrl: config.baseUrl,
            caseTitle: result.caseTitle,
            toolName: snapshot.toolName,
          },
          level: "warning",
          message: `Widget snapshot upload failed for "${snapshot.toolName}"`,
        });
        console.warn(
          `[mcpjam/sdk] skipped widget snapshot upload for "${snapshot.toolName}": ${message}`
        );
      }
    }

    rewrittenResults.push({
      ...result,
      widgetSnapshots:
        uploadedSnapshots.length > 0 ? uploadedSnapshots : undefined,
    });
  }

  return rewrittenResults;
}

function shouldUseOneShotUpload(
  input: ReportEvalResultsInput,
  config: RuntimeConfig
): boolean {
  if (input.results.length > ONE_SHOT_RESULT_LIMIT) {
    return false;
  }
  const body = {
    suiteName: input.suiteName,
    suiteDescription: input.suiteDescription,
    serverNames: input.serverNames,
    notes: input.notes,
    passCriteria: input.passCriteria,
    externalRunId: input.externalRunId,
    framework: input.framework,
    ci: input.ci,
    results: input.results,
  };
  const bytes = getByteLength(JSON.stringify(body));
  return bytes <= CHUNK_TARGET_BYTES && config.baseUrl.length >= 0;
}

async function reportEvalResultsInternal(
  input: ReportEvalResultsInput
): Promise<ReportEvalResultsOutput> {
  if (!input.suiteName || input.suiteName.trim().length === 0) {
    throw new Error("suiteName is required");
  }
  if (!Array.isArray(input.results) || input.results.length === 0) {
    throw new Error("results must include at least one eval result");
  }

  const config = createRuntimeConfig(input);
  const uploadedResults = await uploadWidgetSnapshots(config, input.results);
  const externalRunId = input.externalRunId ?? generateExternalRunId();
  const resultsWithIterationIds = withExternalIterationIds(
    uploadedResults,
    externalRunId
  );

  if (
    shouldUseOneShotUpload(
      { ...input, externalRunId, results: resultsWithIterationIds },
      config
    )
  ) {
    return await requestWithRetry<ReportEvalResultsOutput>(
      config,
      "/sdk/v1/evals/report",
      {
        suiteName: input.suiteName,
        suiteDescription: input.suiteDescription,
        serverNames: input.serverNames,
        notes: input.notes,
        passCriteria: input.passCriteria,
        externalRunId,
        framework: input.framework,
        ci: input.ci,
        expectedIterations: input.expectedIterations,
        results: resultsWithIterationIds,
      }
    );
  }

  const start = await startEvalRun(config, {
    suiteName: input.suiteName,
    suiteDescription: input.suiteDescription,
    serverNames: input.serverNames,
    notes: input.notes,
    passCriteria: input.passCriteria,
    externalRunId,
    framework: input.framework,
    ci: input.ci,
    expectedIterations: input.expectedIterations,
  });

  if (
    start.reused &&
    start.status === "completed" &&
    start.result &&
    start.summary
  ) {
    return {
      suiteId: start.suiteId,
      runId: start.runId,
      status: start.status as "completed" | "failed",
      result: start.result as "passed" | "failed",
      summary: start.summary,
    };
  }

  const chunks = chunkResultsForUpload(resultsWithIterationIds);
  for (const chunk of chunks) {
    await appendEvalRunIterations(config, {
      runId: start.runId,
      results: chunk,
    });
  }

  return await finalizeEvalRun(config, {
    runId: start.runId,
    externalRunId,
  });
}

export async function reportEvalResults(
  input: ReportEvalResultsInput
): Promise<ReportEvalResultsOutput> {
  try {
    return await reportEvalResultsInternal(input);
  } catch (error) {
    await captureEvalReportingFailure(
      error,
      buildFailureContext(input, "reportEvalResults")
    );
    throw error;
  }
}

export async function reportEvalResultsSafely(
  input: ReportEvalResultsInput
): Promise<ReportEvalResultsOutput | null> {
  try {
    return await reportEvalResultsInternal(input);
  } catch (error) {
    await captureEvalReportingFailure(
      error,
      buildFailureContext(input, "reportEvalResultsSafely")
    );
    if (input.strict) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcpjam/sdk] eval reporting failed: ${message}`);
    return null;
  }
}

export type {
  RuntimeConfig as EvalReportingRuntimeConfig,
  AppendIterationsResponse,
  StartRunResponse,
};

export {
  appendEvalRunIterations,
  chunkResultsForUpload,
  createRuntimeConfig,
  finalizeEvalRun,
  generateExternalRunId,
  reportEvalResultsInternal,
  startEvalRun,
  withExternalIterationIds,
};
