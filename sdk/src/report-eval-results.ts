import type {
  EvalResultInput,
  EvalWidgetSnapshotInput,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import { EvalReportingError } from "./errors.js";
import { buildAppPermalink } from "./platform/permalinks.js";
import { isEvalRunVerdict } from "./contract/verdict-policy.js";
import { resolveServerReplayConfigs } from "./server-replay-configs.js";
import { addBreadcrumb, captureEvalReportingFailure } from "./sentry.js";
import {
  buildSdkEvalsWireHostConfig,
  type SdkEvalsWireHostConfig,
} from "./sdk-evals-wire-host-config.js";
import { resolveRunLevelHostSnapshot } from "./sdk-evals-host-config-source.js";
import { redactTelemetryString } from "./telemetry-redaction.js";
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
  /** See `ReportEvalResultsOutput.projectId` — optional, mixed-version safe. */
  projectId?: string;
  reused?: boolean;
  status?: string;
  result?: string;
  summary?: ReportEvalResultsOutput["summary"];
  /** v2 verdict fields, absent from a legacy run and a legacy backend. */
  verdictPolicyVersion?: number;
  verdictSummary?: ReportEvalResultsOutput["verdictSummary"];
  verdictPolicyIntegrityError?: string;
};

/**
 * Project a backend run response onto {@link ReportEvalResultsOutput}.
 *
 * The verdict is carried through as the backend spelled it — `inconclusive`
 * included. Narrowing it to `passed | failed` (which is what a bare cast did)
 * reports an unmeasurable run as a failing one, which points a gate at the
 * server under test when the harness is what broke.
 */
export function projectRunVerdict(
  run: Pick<
    StartRunResponse,
    "result" | "verdictPolicyVersion" | "verdictSummary" | "verdictPolicyIntegrityError"
  >
): Pick<
  ReportEvalResultsOutput,
  "result" | "verdictPolicyVersion" | "verdictSummary" | "verdictPolicyIntegrityError"
> {
  return {
    result: isEvalRunVerdict(run.result) ? run.result : "failed",
    ...(run.verdictPolicyVersion !== undefined
      ? {
          verdictPolicyVersion:
            run.verdictPolicyVersion as ReportEvalResultsOutput["verdictPolicyVersion"],
        }
      : {}),
    ...(run.verdictSummary ? { verdictSummary: run.verdictSummary } : {}),
    ...(run.verdictPolicyIntegrityError
      ? { verdictPolicyIntegrityError: run.verdictPolicyIntegrityError }
      : {}),
  };
}

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
  isReportingBackendIncompatible: boolean;
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

/**
 * Runs printed so far, keyed by runId. Module-level and never cleared: it
 * exists so that a single run announces itself exactly ONCE even though the
 * chunked path passes through two print sites (start-reuse and finalize) and
 * the streaming reporter through two more.
 */
const printedRunUrls = new Set<string>();

/**
 * Bound on the guard above, because the SDK is a library inside long-lived
 * processes — a vitest watcher or a CI loop can complete thousands of runs in
 * one process, and an unbounded set would grow for the lifetime of that
 * process. Insertion-ordered, so evicting the oldest entry keeps the recent
 * runs (the only ones a duplicate print could plausibly follow) protected.
 */
const PRINTED_RUN_URL_CAP = 512;

/** Escape hatch for tests, which assert print-once across cases. */
export function __resetPrintedRunUrls(): void {
  printedRunUrls.clear();
}

/**
 * Print a deep link to the run that was just uploaded.
 *
 * The gap this closes: the SDK uploaded results and said nothing about where
 * they went, so seeing them meant leaving the terminal, finding the right
 * project, and then the right suite. One line makes the upload's destination
 * addressable.
 *
 * The route is the UNFLAGGED `/evals/suite/:suiteId/runs/:runId`, not
 * `/ci-evals/…`: the latter sits behind the `evaluate-ci` flag and its
 * redirect drops the run path, so a link there lands flag-less readers on a
 * bare list instead of their run.
 *
 * `?project=` prefers the id the BACKEND resolved, falling back to a
 * caller-configured project and omitting the param entirely for the
 * zero-config `"default"` sentinel — which is not an id and would make the
 * deep link resolve to nothing. Without the param the app falls back to the
 * active project (see `lib/project-deep-link.ts`), which is the right
 * degradation against a backend that doesn't echo the id yet.
 */
export function printRunUrl(
  config: Pick<RuntimeConfig, "baseUrl" | "project">,
  run: { suiteId?: string; runId?: string; projectId?: string }
): void {
  const suiteId = run.suiteId?.trim();
  const runId = run.runId?.trim();
  // The local-fallback result carries empty ids — there is no server-side run
  // to link to, and a URL with blank segments would 404.
  if (!suiteId || !runId) return;
  if (printedRunUrls.has(runId)) return;
  printedRunUrls.add(runId);
  if (printedRunUrls.size > PRINTED_RUN_URL_CAP) {
    const oldest = printedRunUrls.values().next();
    if (!oldest.done) printedRunUrls.delete(oldest.value);
  }

  const projectId =
    run.projectId?.trim() ||
    (config.project && config.project !== DEFAULT_MCPJAM_PROJECT
      ? config.project
      : "");
  let url: string;
  try {
    // `baseUrl` is where CI REPORTS to, and every deployment serves the app
    // from the same origin — so it is the right app origin here. Passed
    // explicitly either way: the builder reads no configuration of its own.
    const appOrigin = new URL(config.baseUrl).origin;
    url = projectId
      ? buildAppPermalink(
          {
            type: "eval_run",
            id: runId,
            parent: { type: "eval_suite", id: suiteId },
            projectId,
          },
          { appOrigin },
        ).url
      : // NOT a permalink, and knowingly so: with no project id the link
        // opens whichever project the reader's picker is parked on. It is
        // still the right line to print for the CI author reading their own
        // terminal — they are almost always on that project — and the
        // alternative for a backend that does not echo `projectId` is no link
        // at all. Built through `URL` rather than concatenation so it stays
        // encoded and stays out of the string-building this module retired.
        new URL(
          `/evals/suite/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}`,
          appOrigin,
        ).toString();
  } catch {
    // A convenience line may never fail a CI report that already succeeded.
    return;
  }

  console.log(`[mcpjam/sdk] View run: ${url}`);
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
  const { message, isBillingLimitReached, isReportingBackendIncompatible } =
    normalizeReportingErrorMessage(rawMessage);
  return new EvalReportingError(message, {
    attemptCount,
    cause: error,
    endpoint,
    isBillingLimitReached,
    isReportingBackendIncompatible,
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

/**
 * Fields this SDK sends that a reporting backend older than the minimum
 * contract will not recognize. `caseId` (declared case identity) is the first
 * and, for now, only one.
 */
const REQUIRED_BACKEND_FIELDS = ["caseId"] as const;

/**
 * Prefix that marks a message as ALREADY rewritten by
 * {@link describeIncompatibleReportingBackend}. The rewrite quotes the backend
 * verbatim at the end, so without a sentinel a second normalization pass would
 * match its own output and nest the explanation inside itself.
 */
const INCOMPATIBLE_BACKEND_PREFIX =
  "This reporting backend is older than this SDK requires";

/** Phrasings that come BEFORE the field: "extra field `caseId`". */
const UNKNOWN_FIELD_BEFORE =
  "(?:extra|unknown|unexpected|unrecognized|additional)\\s+(?:field|argument|propert\\w*|key)|no such (?:field|argument)";
/** Phrasings that come AFTER it: "`caseId` is not allowed". */
const UNKNOWN_FIELD_AFTER =
  "(?:is\\s+)?not\\s+(?:in the validator|allowed|permitted|a\\s+(?:valid|known|recognized)\\s+(?:field|argument|propert\\w*))";

/**
 * An "I do not know this field" rejection, as opposed to "this field's value is
 * wrong".
 *
 * The distinction is the whole point. A backend that understands `caseId` also
 * rejects bad ones — an unusable charset, an id that disagrees with
 * `externalCaseId` — and those messages are written for the author and must
 * reach them as written. What is matched here is the other thing: a strict
 * argument validator refusing a field it has never heard of, which says nothing
 * about the payload and everything about the destination.
 *
 * Phrasings are matched loosely because they are not ours to pin down. Convex
 * says "Object contains extra field `caseId` that is not in the validator"; a
 * caller-supplied `baseUrl` reimplementing the ingest contract will say
 * something else.
 *
 * The field name must be ADJACENT to the phrasing, not merely present in the
 * message. A validator that refuses some other unknown field echoes the whole
 * rejected object back, and that echo contains `caseId` — so "mentions caseId
 * somewhere AND complains about an unknown field" matches a rejection that has
 * nothing to do with declared ids, and would answer it with upgrade advice for
 * the wrong field while suppressing the retry it might deserve. Adjacency is
 * what separates the sentence from the payload dump that follows it.
 */
function rejectsFieldAsUnknown(message: string, field: string): boolean {
  // Only quoting and punctuation may sit between the phrase and the name —
  // "extra field `caseId`", never "extra field `metadata` … {caseId: …}".
  const phraseThenField = new RegExp(
    `(?:${UNKNOWN_FIELD_BEFORE})[\\s:='"\`]{0,4}${field}\\b`,
    "i"
  );
  // The mirror image, bounded to one line so it cannot reach into the dump.
  const fieldThenPhrase = new RegExp(
    `\\b${field}["'\`]?[^\\n]{0,24}?(?:${UNKNOWN_FIELD_AFTER})`,
    "i"
  );
  return phraseThenField.test(message) || fieldThenPhrase.test(message);
}

function isUnknownFieldRejection(rawMessage: string): boolean {
  if (rawMessage.startsWith(INCOMPATIBLE_BACKEND_PREFIX)) return false;
  return REQUIRED_BACKEND_FIELDS.some((field) =>
    rejectsFieldAsUnknown(rawMessage, field)
  );
}

/**
 * Turn a strict-validator refusal into the sentence the author can act on.
 *
 * The public SDK reports to a caller-supplied `baseUrl`, so we cannot prove
 * every destination is current — what we can do is not make somebody read a
 * validator dump to learn that their deployment needs an upgrade. Three facts
 * the raw message never carries: NOTHING was filed (argument validation is
 * strict, so the whole upload is refused rather than the field stripped), the
 * run itself is fine, and the fix is on the destination rather than in the
 * suite.
 *
 * The backend's own words are kept at the end. They name which field and which
 * endpoint, and a rewrite that discarded them would be harder to debug than the
 * dump it replaced.
 */
function describeIncompatibleReportingBackend(rawMessage: string): string {
  return (
    `${INCOMPATIBLE_BACKEND_PREFIX}: it rejected \`caseId\`, the declared case ` +
    `identity @mcpjam/sdk sends on every result. Argument validation is strict, ` +
    `so the WHOLE report was refused rather than the field ignored — no results ` +
    `were filed, and this is a reporting failure, not an eval verdict. Upgrade ` +
    `the reporting backend to one that accepts declared case ids (MCPJam-hosted ` +
    `app.mcpjam.com does), or point \`baseUrl\` at one that is. Backend said: ` +
    rawMessage
  );
}

/**
 * Every ingest failure message the backend hands back funnels through here on
 * its way into an `EvalReportingError`, and from there into both stderr and
 * Sentry's exception value. The string is server-controlled, and the ingest
 * body it describes carries `accessToken`/`refreshToken`/`clientSecret` — a
 * validator that echoes the rejected argument (Convex's ArgumentValidationError
 * does exactly that) would otherwise publish live credentials to a log and a
 * third-party error tracker.
 *
 * Redact once, here, rather than at each sink: this is the single point where a
 * remote string becomes ours, so every downstream consumer inherits the
 * guarantee instead of having to remember it.
 */
function normalizeReportingErrorMessage(
  rawMessage: string
): NormalizedReportingError {
  if (!rawMessage.includes("billing_limit_reached")) {
    // Redact FIRST, then explain: the compatibility rewrite quotes the backend
    // verbatim, and the dump a Convex validator echoes is the ingest body —
    // the one that carries `accessToken`/`refreshToken`/`clientSecret`.
    const redacted = redactTelemetryString(rawMessage);
    const incompatible = isUnknownFieldRejection(redacted);
    return {
      message: incompatible
        ? describeIncompatibleReportingBackend(redacted)
        : redacted,
      isBillingLimitReached: false,
      isReportingBackendIncompatible: incompatible,
    };
  }

  const payload = extractFirstJsonObject(rawMessage);
  const billingMessage = payload ? normalizeBillingLimitMessage(payload) : null;
  return {
    message: billingMessage
      ? redactTelemetryString(billingMessage)
      : "Billing limit reached.",
    isBillingLimitReached: true,
    isReportingBackendIncompatible: false,
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

/**
 * A rejection no retry can fix. Mirrors {@link isBillingLimitReachedError}: the
 * destination's validator will refuse the identical payload every time, so the
 * three backoff attempts only delay the message the author needs to read.
 */
function isReportingBackendIncompatibleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    error instanceof EvalReportingError &&
    error.isReportingBackendIncompatible
  ) {
    return true;
  }
  return normalizeReportingErrorMessage(error.message)
    .isReportingBackendIncompatible;
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
          const {
            message,
            isBillingLimitReached,
            isReportingBackendIncompatible,
          } = normalizeReportingErrorMessage(rawMessage);
          throw new EvalReportingError(message, {
            attemptCount: attempt + 1,
            endpoint: path,
            isBillingLimitReached,
            isReportingBackendIncompatible,
            statusCode: response.status,
          });
        }
        return (responseBody ?? {}) as T;
      }

      const rawMessage =
        responseBody?.error ??
        responseBody?.message ??
        `Request failed with status ${response.status}: ${response.statusText}`;
      const { message, isBillingLimitReached, isReportingBackendIncompatible } =
        normalizeReportingErrorMessage(rawMessage);
      if (
        !isBillingLimitReached &&
        !isReportingBackendIncompatible &&
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
        isReportingBackendIncompatible,
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
        !isReportingBackendIncompatibleError(error) &&
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

      // Same reasoning as `normalizeReportingErrorMessage`: server-controlled
      // string, and this one reaches a console.warn in the widget-snapshot path.
      const message = redactTelemetryString(
        responseBody.error ??
          `Artifact upload failed with status ${response.status}: ${response.statusText}`
      );
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
    const oneShot = await requestWithRetry<ReportEvalResultsOutput>(
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
        evaluationConfigHash: input.evaluationConfigHash,
        // The v2 marker. Sent only when the caller declared a policy, so a
        // legacy run's body is byte-identical to what it was: this is the field
        // that decides which aggregation a run is graded under, and a default
        // would silently re-grade every existing suite.
        ...(input.verdictPolicy ? { verdictPolicy: input.verdictPolicy } : {}),
        results: resultsWithIterationIds,
        ...wireHostConfigBody,
      }
    );
    printRunUrl(config, oneShot);
    return oneShot;
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
    evaluationConfigHash: input.evaluationConfigHash,
    // Resolved and FROZEN by the backend at run start — which is why it rides
    // the start call rather than each chunk. Later chunks carry evidence, not
    // policy.
    ...(input.verdictPolicy ? { verdictPolicy: input.verdictPolicy } : {}),
    ...wireHostConfigBody,
  });

  if (
    start.reused &&
    start.status === "completed" &&
    start.result &&
    start.summary
  ) {
    // The CI-retry path — a re-upload of an already-complete run. It still
    // deserves the link: the run exists, and "where did that go?" is exactly
    // the question a retry raises.
    const reused: ReportEvalResultsOutput = {
      suiteId: start.suiteId,
      runId: start.runId,
      ...(start.projectId ? { projectId: start.projectId } : {}),
      status: start.status as "completed" | "failed",
      ...projectRunVerdict(start),
      summary: start.summary,
    };
    printRunUrl(config, reused);
    return reused;
  }

  const chunks = chunkResultsForUpload(resultsWithIterationIds);
  for (const chunk of chunks) {
    await appendEvalRunIterations(config, {
      runId: start.runId,
      results: chunk,
    });
  }

  const finalized = await finalizeEvalRun(config, {
    runId: start.runId,
    externalRunId,
  });
  printRunUrl(config, finalized);
  return finalized;
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
