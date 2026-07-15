import type {
  EvalResultInput,
  EvalWidgetSnapshotInput,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import { EvalReportingError } from "./errors.js";
import { resolveServerReplayConfigs } from "./server-replay-configs.js";
import { addBreadcrumb, captureEvalReportingFailure } from "./sentry.js";
import {
  buildSdkEvalsWireHostConfig,
  type SdkEvalsWireHostConfig,
} from "./sdk-evals-wire-host-config.js";
import { resolveRunLevelHostSnapshot } from "./sdk-evals-host-config-source.js";
import type { HostJson } from "./host-config/public-types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1750];
const CHUNK_SIZE_LIMIT = 200;
const ONE_SHOT_RESULT_LIMIT = 200;
const CHUNK_TARGET_BYTES = 1024 * 1024;

export const DEFAULT_MCPJAM_BASE_URL = "https://app.mcpjam.com";

/**
 * Where results land. `default` resolves server-side to the API key org's
 * Default project; pass a project id (from the dashboard URL or
 * `GET /api/v1/projects`) to target another project.
 */
export const DEFAULT_MCPJAM_PROJECT = "default";

type RuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  project: string;
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
  // Legacy ingestion error shape.
  error?: string;
  // Canonical v1 error envelope.
  code?: string;
  message?: string;
} & T;

type NormalizedReportingError = {
  message: string;
  isBillingLimitReached: boolean;
};

type EvalArtifactUploadUrlResponse = {
  uploadUrl: string;
};

function resolveApiKey(
  input: Pick<ReportEvalResultsInput, "apiKey">
): string | undefined {
  return input.apiKey ?? process.env.MCPJAM_API_KEY;
}

function resolveBaseUrl(
  input: Pick<ReportEvalResultsInput, "baseUrl">
): string {
  return trimTrailingSlash(
    input.baseUrl ?? process.env.MCPJAM_BASE_URL ?? DEFAULT_MCPJAM_BASE_URL
  );
}

function resolveProject(
  input: Pick<ReportEvalResultsInput, "project">
): string {
  const project = input.project ?? process.env.MCPJAM_PROJECT_ID;
  const trimmed = typeof project === "string" ? project.trim() : "";
  return trimmed || DEFAULT_MCPJAM_PROJECT;
}

/**
 * Ingestion endpoints live on the MCPJam public API
 * (`/api/v1/projects/:projectId/eval-ingest/*`), authenticated with an
 * MCPJam API key (`sk_…`). They replaced the retired `/sdk/v1/evals/*`
 * surface, whose `mcpjam_` project keys no longer exist.
 */
function ingestPath(config: RuntimeConfig, suffix: string): string {
  return `/api/v1/projects/${encodeURIComponent(
    config.project
  )}/eval-ingest/${suffix}`;
}

function getResultCount(
  results: ReportEvalResultsInput["results"]
): number | undefined {
  return Array.isArray(results) ? results.length : undefined;
}

function buildFailureContext(
  input: ReportEvalResultsInput,
  entrypoint: string
): Parameters<typeof captureEvalReportingFailure>[1] {
  return {
    apiKey: resolveApiKey(input),
    baseUrl: resolveBaseUrl(input),
    project: resolveProject(input),
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

  const rawMessage = error instanceof Error ? error.message : String(error);
  const { message, isBillingLimitReached } =
    normalizeReportingErrorMessage(rawMessage);
  return new EvalReportingError(message, {
    attemptCount,
    cause: error,
    endpoint,
    isBillingLimitReached,
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

function extractFirstJsonObject(value: string): Record<string, unknown> | null {
  const start = value.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index++) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1)) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function formatResetTime(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

function normalizeBillingLimitMessage(
  payload: Record<string, unknown>
): string | null {
  if (payload.code !== "billing_limit_reached") {
    return null;
  }

  const limit = payload.limit ?? payload.gateKey;
  const resetsAt = formatResetTime(payload.resetsAt);
  if (limit === "maxEvalIterationsPerMonth") {
    if (resetsAt) {
      return `Eval iteration limit reached. Resets at ${resetsAt}.`;
    }

    const currentValue = payload.currentValue;
    const allowedValue = payload.allowedValue;
    if (typeof currentValue === "number" && typeof allowedValue === "number") {
      return `Eval iteration limit reached. This run would use ${currentValue}/${allowedValue} iterations.`;
    }

    return "Eval iteration limit reached.";
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  return "Billing limit reached.";
}

function normalizeReportingErrorMessage(
  rawMessage: string
): NormalizedReportingError {
  if (!rawMessage.includes("billing_limit_reached")) {
    return { message: rawMessage, isBillingLimitReached: false };
  }

  const payload = extractFirstJsonObject(rawMessage);
  const billingMessage = payload ? normalizeBillingLimitMessage(payload) : null;
  return {
    message: billingMessage ?? "Billing limit reached.",
    isBillingLimitReached: true,
  };
}

function isBillingLimitReachedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof EvalReportingError && error.isBillingLimitReached) {
    return true;
  }
  return (
    error.message.startsWith("Eval iteration limit reached.") ||
    normalizeReportingErrorMessage(error.message).isBillingLimitReached
  );
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
    project: resolveProject(input),
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
          const rawMessage =
            responseBody.error ??
            responseBody.message ??
            "Unknown SDK evals error";
          const { message, isBillingLimitReached } =
            normalizeReportingErrorMessage(rawMessage);
          throw new EvalReportingError(message, {
            attemptCount: attempt + 1,
            endpoint: path,
            isBillingLimitReached,
            statusCode: response.status,
          });
        }
        return (responseBody ?? {}) as T;
      }

      const rawMessage =
        responseBody?.error ??
        responseBody?.message ??
        `Request failed with status ${response.status}: ${response.statusText}`;
      const { message, isBillingLimitReached } =
        normalizeReportingErrorMessage(rawMessage);
      if (
        !isBillingLimitReached &&
        isRetryableStatus(response.status) &&
        attempt < config.retryDelaysMs.length
      ) {
        await sleep(jitter(config.retryDelaysMs[attempt]));
        continue;
      }

      throw new EvalReportingError(message, {
        attemptCount: attempt + 1,
        endpoint: path,
        isBillingLimitReached,
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
        !isBillingLimitReachedError(error) &&
        (isAbortError ||
          error instanceof TypeError ||
          (typeof errorStatusCode === "number" &&
            isRetryableStatus(errorStatusCode)) ||
          (error instanceof Error &&
            /network|fetch|timeout|429|5\d\d/i.test(error.message)));

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
    /**
     * Stage 5 Step 3 wire host-config pair. Sent only when the backend
     * advertises capability `evalsHostConfig` AND a usable, homogeneous
     * snapshot was resolved. Backend rejects partial pairs with 400.
     */
    hostConfig?: SdkEvalsWireHostConfig["hostConfig"];
    hostConfigHash?: SdkEvalsWireHostConfig["hostConfigHash"];
  }
): Promise<StartRunResponse> {
  return await requestWithRetry<StartRunResponse>(
    config,
    ingestPath(config, "runs/start"),
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
    ingestPath(config, "runs/iterations"),
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
    ingestPath(config, "runs/finalize"),
    payload
  );
}

async function getEvalArtifactUploadUrl(
  config: RuntimeConfig
): Promise<string> {
  const response = await requestWithRetry<EvalArtifactUploadUrlResponse>(
    config,
    ingestPath(config, "artifacts/upload-url"),
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
        uploadedSnapshots.push(snapshot);
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
    serverReplayConfigs: input.serverReplayConfigs,
    notes: input.notes,
    passCriteria: input.passCriteria,
    externalRunId: input.externalRunId,
    framework: input.framework,
    ci: input.ci,
    tags: input.tags,
    results: input.results,
  };
  const bytes = getByteLength(JSON.stringify(body));
  return bytes <= CHUNK_TARGET_BYTES && config.baseUrl.length >= 0;
}

/**
 * Cheap check for whether ANY snapshot source could possibly contribute
 * to the run-level wire pair. When false, we skip the capability probe
 * entirely — there's nothing to ship even if the backend supports it,
 * so callers that never supply host info skip the resolution work
 * entirely.
 */
function hasAnyHostSnapshotSource(input: ReportEvalResultsInput): boolean {
  if (input.host) return true;
  if (input.executor?.getHostSnapshot) return true;
  for (const result of input.results) {
    if ((result as { hostSnapshot?: unknown }).hostSnapshot) return true;
  }
  return false;
}

/**
 * Resolve the per-run wire pair {hostConfig, hostConfigHash}. Returns
 * `null` when no usable snapshot source exists OR iteration snapshots are
 * heterogeneous (pass-1 omit). The v1 ingest surface has always accepted
 * the pair, so the old per-baseUrl capability probe is gone.
 *
 * The wire pair is per-RUN: it is injected only into one-shot `/report`
 * and chunked `/runs/start` bodies, never into `/runs/iterations` or
 * `/runs/finalize`.
 */
async function resolveWireHostConfigForRun(
  input: ReportEvalResultsInput
): Promise<SdkEvalsWireHostConfig | null> {
  // Nothing to ship: keep callers with no host, no executor, and no
  // per-iteration snapshot on the plain flow (also keeps fetch-mock
  // counts stable in existing tests).
  if (!hasAnyHostSnapshotSource(input)) return null;

  // `input.results` are `EvalResultInput`s; the homogeneity gate treats
  // each as a potential carrier of `hostSnapshot`. Today `EvalResultInput`
  // does not carry that field, so this list is effectively snapshot-less
  // and the resolver falls through to executor → explicitHost. Cast keeps
  // the type surface forward-compatible for when per-iteration
  // `hostSnapshot` is wired through `EvalResultInput`.
  const iterations = input.results as readonly {
    hostSnapshot?: HostJson | undefined;
  }[];

  // Fail-safe: a malformed hostSnapshot, unexpected executor return, or
  // non-canonicalizable host JSON must NOT fail the whole eval upload —
  // log + omit the wire pair.
  try {
    const snapshot = await resolveRunLevelHostSnapshot({
      iterations,
      executor: input.executor,
      explicitHost: input.host,
    });
    if (!snapshot) return null;
    return await buildSdkEvalsWireHostConfig(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[mcpjam/sdk] eval reporting: omitting hostConfig wire pair (${message})`
    );
    return null;
  }
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
  const serverReplayConfigs = resolveServerReplayConfigs(input);
  const resultsWithIterationIds = withExternalIterationIds(
    uploadedResults,
    externalRunId
  );

  // Resolved once per `reportEvalResultsInternal` call so both code paths
  // (one-shot and chunked-start) attach the same byte-stable pair.
  const wireHostConfig = await resolveWireHostConfigForRun(input);
  const wireHostConfigBody = wireHostConfig
    ? {
        hostConfig: wireHostConfig.hostConfig,
        hostConfigHash: wireHostConfig.hostConfigHash,
      }
    : {};

  if (
    shouldUseOneShotUpload(
      {
        ...input,
        externalRunId,
        serverReplayConfigs,
        results: resultsWithIterationIds,
      },
      config
    )
  ) {
    return await requestWithRetry<ReportEvalResultsOutput>(
      config,
      ingestPath(config, "report"),
      {
        suiteName: input.suiteName,
        suiteDescription: input.suiteDescription,
        serverNames: input.serverNames,
        serverReplayConfigs,
        notes: input.notes,
        passCriteria: input.passCriteria,
        externalRunId,
        framework: input.framework,
        ci: input.ci,
        expectedIterations: input.expectedIterations,
        tags: input.tags,
        results: resultsWithIterationIds,
        ...wireHostConfigBody,
      }
    );
  }

  const start = await startEvalRun(config, {
    suiteName: input.suiteName,
    suiteDescription: input.suiteDescription,
    serverNames: input.serverNames,
    serverReplayConfigs,
    notes: input.notes,
    passCriteria: input.passCriteria,
    externalRunId,
    framework: input.framework,
    ci: input.ci,
    expectedIterations: input.expectedIterations,
    tags: input.tags,
    ...wireHostConfigBody,
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
  uploadWidgetSnapshots,
  withExternalIterationIds,
};
