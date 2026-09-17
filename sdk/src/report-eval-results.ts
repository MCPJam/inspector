import {
  reportingRequest,
  ReportingHttpError,
  ReportingProtocolError,
  type ReportingTransportOptions,
} from "./eval-reporting-transport.js";
import {
  prepareReportingConfig,
  snapshotReportingInput,
  buildReportingBody,
  requiresRunMetadataCapability,
} from "./eval-reporting-config.js";
import type {
  EvalReportingWarning,
  EvalResultInput,
  EvalWidgetSnapshotInput,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import { EvalReportingError } from "./errors.js";
import { buildAppPermalink } from "./platform/permalinks.js";
import { writeGithubActionReceipt } from "./github-action-receipt.js";
import {
  isEvalRunVerdict,
  evalVerdictDecisionSchema,
} from "./contract/verdict-policy.js";
import {
  resolveServerNames,
  resolveServerReplayConfigs,
} from "./server-replay-configs.js";
import { addBreadcrumb, captureEvalReportingFailure } from "./sentry.js";
import {
  buildSdkEvalsWireHostConfig,
  type SdkEvalsWireHostConfig,
} from "./sdk-evals-wire-host-config.js";
import { resolveRunLevelHostSnapshot } from "./sdk-evals-host-config-source.js";
import { redactTelemetryString } from "./telemetry-redaction.js";
import type { HostJson } from "./host-config/public-types.js";
import {
  capabilityAcceptsCanonicalRole,
  definitionsForDeployment,
} from "./contract/policy-spelling.js";
import type { ScorerRole } from "./contract/types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1750];
const CHUNK_SIZE_LIMIT = 200;
const ONE_SHOT_RESULT_LIMIT = 200;
const CHUNK_TARGET_BYTES = 1024 * 1024;

/**
 * Headroom left when weighing one result against {@link CHUNK_TARGET_BYTES}:
 * the ids and framing a result picks up after the widget-offload decision, plus
 * a margin so the decision is never a byte away from wrong.
 */
const RESULT_ENVELOPE_SLACK = 4096;

/** Hosts that never leave the machine, so plain http to them is not on a wire. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

export const DEFAULT_MCPJAM_BASE_URL = "https://app.mcpjam.com";

/**
 * Where results land. `default` resolves server-side to the API key org's
 * Default project; pass a project id (from the dashboard URL or
 * `GET /api/v1/projects`) to target another project.
 */
export const DEFAULT_MCPJAM_PROJECT = "default";

type RuntimeConfig = ReportingTransportOptions & {
  warnings?: EvalReportingWarning[];
  apiKey: string;
  baseUrl: string;
  project: string;
  timeoutMs: number;
  retryDelaysMs: number[];
  /**
   * The target's advertised capabilities, resolved at most once per run by
   * {@link resolveTargetCapabilities}. `null` records a probe that failed —
   * distinct from `undefined`, which means "not asked yet" — so a target that
   * cannot answer is not re-probed once per consumer.
   */
  capabilitiesCache?: unknown;
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
    | "result"
    | "verdictPolicyVersion"
    | "verdictSummary"
    | "verdictPolicyIntegrityError"
  >
): Pick<
  ReportEvalResultsOutput,
  | "result"
  | "verdictPolicyVersion"
  | "verdictSummary"
  | "verdictPolicyIntegrityError"
> {
  return {
    result: isEvalRunVerdict(run.result)
      ? run.result
      : run.result === "pending"
        ? "pending"
        : "failed",
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
 * Links open the exact uploaded run in the public Evaluate experience.
 *
 * `?project=` prefers the id the BACKEND resolved, falling back to a
 * caller-configured project and omitting the param entirely for the
 * zero-config `"default"` sentinel — which is not an id and would make the
 * deep link resolve to nothing. Without the param the app falls back to the
 * active project (see `lib/project-deep-link.ts`), which is the right
 * degradation against a backend that doesn't echo the id yet.
 */
export function buildRunUrl(
  run: { suiteId: string; runId: string; projectId?: string },
  config: { baseUrl?: string; project?: string } = {}
): string | undefined {
  const suiteId = run.suiteId?.trim();
  const runId = run.runId?.trim();
  if (!suiteId || !runId) return undefined;
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
    const appOrigin = new URL(config.baseUrl ?? DEFAULT_MCPJAM_BASE_URL).origin;
    url = projectId
      ? buildAppPermalink(
          {
            type: "eval_run",
            id: runId,
            parent: { type: "eval_suite", id: suiteId },
            projectId,
          },
          { appOrigin }
        ).url
      : // NOT a permalink, and knowingly so: with no project id the link
        // opens whichever project the reader's picker is parked on. It is
        // still the right line to print for the CI author reading their own
        // terminal — they are almost always on that project — and the
        // alternative for a backend that does not echo `projectId` is no link
        // at all. Built through `URL` rather than concatenation so it stays
        // encoded and stays out of the string-building this module retired.
        new URL(
          `/evaluate/suite/${encodeURIComponent(
            suiteId
          )}/runs/${encodeURIComponent(runId)}`,
          appOrigin
        ).toString();
  } catch {
    // A convenience line may never fail a CI report that already succeeded.
    return;
  }

  return url;
}

export function printRunUrl(
  config: Pick<RuntimeConfig, "baseUrl" | "project">,
  run: { suiteId?: string; runId?: string; projectId?: string }
): void {
  const suiteId = run.suiteId?.trim();
  const runId = run.runId?.trim();
  // The local-fallback result carries empty ids — there is no server-side run
  // to link to, and a URL with blank segments would 404.
  if (!suiteId || !runId) return;
  (run as { url?: string }).url = buildRunUrl(
    { suiteId, runId, projectId: run.projectId },
    config
  );
  if (printedRunUrls.has(runId)) return;
  printedRunUrls.add(runId);
  if (printedRunUrls.size > PRINTED_RUN_URL_CAP) {
    const oldest = printedRunUrls.values().next();
    if (!oldest.done) printedRunUrls.delete(oldest.value);
  }

  const url = buildRunUrl({ suiteId, runId, projectId: run.projectId }, config);
  if (!url) return;
  (run as { url?: string }).url = url;

  try {
    console.log(`[mcpjam/sdk] View run: ${url}`);
  } catch {
    // Presentation must never turn an acknowledged upload into a failure.
  }
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
    ...input.transport,
    timeoutMs: input.transport?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
  };
}

function validateReportingResponse(
  path: string,
  body: Record<string, unknown>,
  request: Record<string, unknown>
): void {
  const invalid = () => {
    throw new ReportingProtocolError("Invalid reporting response for " + path);
  };
  const id = (key: string) =>
    typeof body[key] === "string" && (body[key] as string).trim().length > 0;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (path.endsWith("runs/evaluations")) {
    if (
      body.runId !== request.runId ||
      !count(body.persistedCases) ||
      body.persistedCases !== (request.evaluations as unknown[]).length
    )
      invalid();
    return;
  }
  if (path.endsWith("/capabilities")) {
    if (
      !body.capabilities ||
      typeof body.capabilities !== "object" ||
      Array.isArray(body.capabilities)
    )
      invalid();
    return;
  }
  if (path.endsWith("artifacts/upload-url")) {
    if (!id("uploadUrl")) invalid();
    try {
      const url = new URL(body.uploadUrl as string);
      // A widget snapshot is a whole built app, and this URL is now reached
      // automatically, so it must not carry one in cleartext across a network.
      // Loopback keeps `npx convex dev` and a self-hosted deployment working,
      // where the upload URL is http://127.0.0.1 by construction.
      const cleartextIsLocal =
        url.protocol === "http:" && isLoopbackHostname(url.hostname);
      if (
        (url.protocol !== "https:" && !cleartextIsLocal) ||
        url.username ||
        url.password
      )
        invalid();
    } catch {
      invalid();
    }
    return;
  }
  if (path.endsWith("runs/iterations")) {
    if (!count(body.inserted) || !count(body.skipped) || !count(body.total))
      invalid();
    if (
      Number(body.inserted) + Number(body.skipped) !==
        (request.results as unknown[]).length ||
      Number(body.total) < Number(body.inserted)
    )
      invalid();
    return;
  }
  if (!id("suiteId") || !id("runId")) invalid();
  if (request.runId !== undefined && body.runId !== request.runId) invalid();
  if (body.projectId !== undefined && !id("projectId")) invalid();
  if (body.reused !== undefined && typeof body.reused !== "boolean") invalid();
  if (
    body.status !== undefined &&
    (typeof body.status !== "string" ||
      ![
        "pending",
        "running",
        "grading",
        "completed",
        "failed",
        "cancelled",
        "timed_out",
      ].includes(body.status))
  )
    invalid();
  if (
    body.result !== undefined &&
    body.result !== "pending" &&
    !isEvalRunVerdict(body.result)
  )
    invalid();
  if (
    body.verdictPolicyVersion !== undefined &&
    body.verdictPolicyVersion !== 1 &&
    body.verdictPolicyVersion !== 2
  )
    invalid();
  if (
    body.verdictSummary !== undefined &&
    !evalVerdictDecisionSchema.safeParse(body.verdictSummary).success
  )
    invalid();
  if (
    body.verdictPolicyIntegrityError !== undefined &&
    typeof body.verdictPolicyIntegrityError !== "string"
  )
    invalid();
  if (body.summary !== undefined) {
    const summary = body.summary as Record<string, unknown>;
    if (
      !summary ||
      typeof summary !== "object" ||
      !count(summary.total) ||
      !count(summary.passed) ||
      !count(summary.failed) ||
      Number(summary.passed) + Number(summary.failed) > Number(summary.total) ||
      typeof summary.passRate !== "number" ||
      !Number.isFinite(summary.passRate) ||
      summary.passRate < 0 ||
      summary.passRate > 1
    )
      invalid();
  }
  if (!path.endsWith("runs/start")) {
    if (!body.status || !body.result || !body.summary) invalid();
    const terminal = ["completed", "failed", "cancelled", "timed_out"].includes(
      String(body.status)
    );
    if (terminal ? !isEvalRunVerdict(body.result) : body.result !== "pending")
      invalid();
  }
}

async function requestWithRetry<T>(
  config: RuntimeConfig,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  if (
    config.maxRequestBytes !== undefined &&
    (!Number.isSafeInteger(config.maxRequestBytes) ||
      config.maxRequestBytes <= 0)
  )
    throw new ReportingProtocolError("Invalid reporting maxRequestBytes");
  const serialized = JSON.stringify(body);
  if (getByteLength(serialized) > (config.maxRequestBytes ?? 5 * 1024 * 1024))
    throw new EvalReportingError(
      "Eval report exceeds the configured request byte limit; split the report into smaller batches",
      { endpoint: path }
    );
  let attemptCount = 0;
  const normalize = (value: Record<string, unknown>) =>
    normalizeReportingErrorMessage(
      typeof value.error === "string"
        ? value.error
        : typeof value.message === "string"
          ? value.message
          : "Reporting request was rejected"
    );
  try {
    return await reportingRequest(
      config,
      `${config.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: serialized,
      },
      (response) => {
        if (response.ok === false) {
          const error = normalize(response);
          throw new EvalReportingError(error.message, {
            endpoint: path,
            ...error,
          });
        }
        validateReportingResponse(path, response, body);
        return response as T;
      },
      (error) => {
        const normalized = normalize(error.body);
        return (
          !normalized.isBillingLimitReached &&
          !normalized.isReportingBackendIncompatible &&
          isRetryableStatus(error.status)
        );
      },
      (count) => {
        attemptCount = count;
      }
    );
  } catch (error) {
    if (error instanceof ReportingHttpError) {
      const normalized = normalize(error.body);
      throw new EvalReportingError(normalized.message, {
        endpoint: path,
        attemptCount,
        statusCode: error.status,
        ...normalized,
      });
    }
    throw toEvalReportingError(error, path, attemptCount);
  }
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
  return await requestStartOrReport<StartRunResponse>(
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
    terminalStatus?: "cancelled" | "timed_out";
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
  if (
    config.maxArtifactBytes !== undefined &&
    (!Number.isSafeInteger(config.maxArtifactBytes) ||
      config.maxArtifactBytes <= 0)
  )
    throw new ReportingProtocolError("Invalid reporting maxArtifactBytes");
  if (getByteLength(body) > (config.maxArtifactBytes ?? 16 * 1024 * 1024))
    throw new ReportingProtocolError(
      "Eval artifact exceeds the configured byte limit"
    );
  return reportingRequest(
    config,
    uploadUrl,
    { method: "POST", headers: { "Content-Type": contentType }, body },
    (response) => {
      if (typeof response.storageId !== "string" || !response.storageId.trim())
        throw new ReportingProtocolError(
          "Invalid artifact upload acknowledgment"
        );
      return response.storageId;
    },
    (error) => isRetryableStatus(error.status)
  );
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

/**
 * Send widget HTML to blob storage when leaving it inline would make a single
 * result too large to upload. Only the results that do not fit are rewritten —
 * every other snapshot stays inline, in the one request it always did.
 *
 * A result is weighed inside the request that will actually carry it: the
 * reporting envelope around it, plus room for the per-result fields added after
 * this point (`externalIterationId`), so a result that only just fits here does
 * not become one that only just fails on the wire.
 */
async function offloadOversizedWidgetSnapshots(
  config: RuntimeConfig,
  input: ReportEvalResultsInput,
  results: EvalResultInput[]
): Promise<EvalResultInput[]> {
  const envelopeBytes = getByteLength(
    JSON.stringify({ ...buildReportingBody(input), results: [] })
  );
  const budget = CHUNK_TARGET_BYTES - envelopeBytes - RESULT_ENVELOPE_SLACK;
  const oversized = new Set<number>();
  results.forEach((result, index) => {
    if (
      Array.isArray(result.widgetSnapshots) &&
      result.widgetSnapshots.length > 0 &&
      getByteLength(JSON.stringify(result)) > budget
    ) {
      oversized.add(index);
    }
  });
  if (oversized.size === 0) {
    return results;
  }
  const rewritten = await uploadWidgetSnapshots(
    config,
    results.filter((_result, index) => oversized.has(index))
  );
  // Put each rewritten result back at its own index so order is unchanged.
  // A short list would silently reinstate the oversized result this whole
  // function exists to remove, so treat it as the contract break it is.
  if (rewritten.length !== oversized.size) {
    throw new ReportingProtocolError(
      "Widget snapshot upload returned a different number of results"
    );
  }
  const queue = [...rewritten];
  return results.map((result, index) =>
    oversized.has(index) ? queue.shift()! : result
  );
}

function shouldUseOneShotUpload(
  input: ReportEvalResultsInput,
  config: RuntimeConfig
): boolean {
  if (input.results.length > ONE_SHOT_RESULT_LIMIT) {
    return false;
  }
  const body = { ...buildReportingBody(input), results: input.results };
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
export async function resolveWireHostConfigForRun(
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
  // Snapshot once, before any async work, for both upload paths and retries.
  input = snapshotReportingInput(input);
  const providedIds = new Set<string>();
  for (const result of input.results ?? []) {
    if (result.externalIterationId !== undefined) {
      if (
        !result.externalIterationId.trim() ||
        providedIds.has(result.externalIterationId)
      )
        throw new TypeError(
          "externalIterationId must be nonempty and unique within a report"
        );
      providedIds.add(result.externalIterationId);
    }
  }
  input = await prepareReportingConfig({
    ...input,
    externalRunId: input.externalRunId ?? generateExternalRunId(),
  });
  if (!input.suiteName || input.suiteName.trim().length === 0) {
    throw new Error("suiteName is required");
  }
  if (
    !Array.isArray(input.results) ||
    (input.results.length === 0 && !input.terminalStatus)
  ) {
    throw new Error("results must include at least one eval result");
  }

  const config = createRuntimeConfig(input);
  await requireReportingCapabilities(config, input);
  const terminalStatus = await resolveTerminationStatus(config, input);
  // Backend stores inline widget evidence after content hashing and
  // authorization, and inline keeps a retry resending identical bytes — so that
  // stays the default. But widget HTML is a whole built app, and two tool calls
  // of one can push a single result past the 1MB request-body limit, which
  // chunking cannot fix because it only splits BETWEEN results. Those offload
  // to blob storage instead, once, before the retry loop below.
  const uploadedResults = await offloadOversizedWidgetSnapshots(
    config,
    input,
    input.results
  );
  const externalRunId = input.externalRunId ?? generateExternalRunId();
  const serverReplayConfigs = resolveServerReplayConfigs(input);
  input = {
    ...input,
    serverNames: resolveServerNames(input, serverReplayConfigs),
  };
  const resultsWithIterationIds = resultsWithFrozenPolicySpelling(
    withExternalIterationIds(uploadedResults, externalRunId)
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
    !terminalStatus &&
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
    const oneShot = await requestStartOrReport<ReportEvalResultsOutput>(
      config,
      ingestPath(config, "report"),
      {
        ...buildReportingBody(input),
        externalRunId,
        serverReplayConfigs,
        results: resultsWithIterationIds,
        ...wireHostConfigBody,
      }
    );
    printRunUrl(config, oneShot);
    return finishReportedRun(config, input, oneShot);
  }

  const start = await startEvalRun(config, {
    ...buildReportingBody(input),
    suiteName: input.suiteName,
    externalRunId,
    serverReplayConfigs,
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
    for (const chunk of chunkResultsForUpload(resultsWithIterationIds)) {
      await appendEvalRunIterations(config, {
        runId: start.runId,
        results: chunk,
      });
    }
    printRunUrl(config, reused);
    return finishReportedRun(config, input, reused);
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
    ...(terminalStatus ? { terminalStatus } : {}),
  });
  printRunUrl(config, finalized);
  return finishReportedRun(config, input, finalized);
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

/**
 * The target's advertised capabilities, fetched at most ONCE per run.
 *
 * Three consumers need them — the run-metadata gate, the run-evaluations gate,
 * and the policy-role projection below — and each used to probe for itself. One
 * memoized probe is both cheaper and more honest: two consumers can no longer
 * disagree about what this deployment supports because their probes landed on
 * either side of a deploy.
 *
 * Never throws for a target that cannot answer: a failed probe caches `null`
 * and every consumer reads it as "does not advertise", which is the safe
 * direction for all three. An explicit cancellation still propagates.
 */
async function resolveTargetCapabilities(
  config: RuntimeConfig
): Promise<unknown> {
  if (config.capabilitiesCache !== undefined) return config.capabilitiesCache;
  try {
    const response = await requestWithRetry<{ capabilities?: unknown }>(
      config,
      ingestPath(config, "capabilities"),
      {}
    );
    config.capabilitiesCache = response?.capabilities ?? null;
  } catch (error) {
    if (config.signal?.aborted) throw error;
    config.capabilitiesCache = null;
  }
  return config.capabilitiesCache;
}

/**
 * Freeze every policy role in the PRIMARY iteration payload at the legacy
 * spelling.
 *
 * `scoreMetadata` embeds each iteration's `evaluationConfig` — definitions and
 * all — into the results that go to `/report` and `/runs/iterations`. That is
 * the payload almost every run sends, and a target that has not deployed the
 * canonical spelling refuses a `required` role there. The refusal does not fail
 * the upload: it quarantines every iteration of the run as
 * `score_integrity_invalid`, so the dashboard shows an EMPTY run rather than a
 * broken one.
 *
 * Frozen rather than negotiated, and that is the point. Negotiating would mean
 * probing `/capabilities` before the first upload of every run, and a run whose
 * probe was slow, cached, or answered by the wrong deployment would be exactly
 * the run that got quarantined. The payload needs no canonical word anyway: it
 * is a STORED contract, the backend keeps what it is given, and a vocabulary-2
 * reader gets `required` from the read projection regardless. This is the same
 * promise `hashSpelling` makes for the digest and `legacyRoleSpelling` makes
 * for the gate report — a stored contract is historical evidence, and the
 * spelling it was written in does not move.
 *
 * The optional `/runs/evaluations` path is the one place that DOES negotiate,
 * because it already handshakes with the target for its own reasons and its
 * rows are advisory by construction.
 *
 * Returns the input uncopied when nothing moves, so a run whose definitions
 * carry no canonical role sends the bytes it has always sent.
 */
function resultsWithFrozenPolicySpelling(
  results: EvalResultInput[]
): EvalResultInput[] {
  let changed = false;
  const out = results.map((result) => {
    const metadata = result.metadata as
      { evaluationConfig?: { definitions?: unknown } } | undefined;
    const definitions = metadata?.evaluationConfig?.definitions;
    if (!Array.isArray(definitions)) return result;
    // `definitionsForDeployment` with no advertised capability IS the freeze:
    // one function decides the legacy spelling for both paths, so they cannot
    // drift apart.
    const frozen = definitions.map((definition) =>
      definition == null
        ? definition
        : definitionsForDeployment(
            [definition as { role: ScorerRole }],
            undefined
          )[0]
    );
    if (frozen.every((definition, index) => definition === definitions[index]))
      return result;
    changed = true;
    return {
      ...result,
      metadata: {
        ...metadata,
        evaluationConfig: {
          ...metadata!.evaluationConfig,
          definitions: [...frozen],
        },
      },
    } as EvalResultInput;
  });
  return changed ? out : results;
}

export async function requireReportingCapabilities(
  config: RuntimeConfig,
  input:
    | ReportEvalResultsInput
    | import("./eval-reporting-types.js").MCPJamReportingConfig
): Promise<void> {
  if (!requiresRunMetadataCapability(input)) return;
  // Optional compatibility probing cannot discard the core run; the shared
  // resolver caches a failed probe as `null` and only rethrows an explicit
  // upload cancellation.
  const capabilities = (await resolveTargetCapabilities(config)) as
    { evalsRunMetadata?: number } | null | undefined;
  if (capabilities?.evalsRunMetadata === 1) return;
  omitRunMetadata(input);
  addReportingWarning(config, {
    code: "RUN_METADATA_OMITTED",
    message:
      "Optional run metadata and expanded CI fields were omitted because target support was not confirmed. Core eval results are still reported.",
  });
}

async function finishReportedRun(
  config: RuntimeConfig,
  input: ReportEvalResultsInput,
  report: ReportEvalResultsOutput
): Promise<ReportEvalResultsOutput> {
  if (input.runEvaluations?.length)
    await reportCaseRunEvaluations(
      config,
      report.runId,
      input.externalRunId!,
      input.runEvaluations
    );
  const completed = attachReportingWarnings(config, report);
  await writeGithubActionReceipt(config, input, completed);
  return completed;
}

export async function reportCaseRunEvaluations(
  config: RuntimeConfig,
  runId: string,
  externalRunId: string,
  evaluations: import("./run-evaluators.js").CaseRunEvaluation[]
): Promise<void> {
  try {
    const capabilities = await resolveTargetCapabilities(config);
    const supported =
      (capabilities as { evalsRunEvaluations?: number } | null | undefined)
        ?.evalsRunEvaluations === 1;
    if (!supported) {
      addReportingWarning(config, {
        code: "RUN_EVALUATIONS_OMITTED",
        message:
          "Advisory case-run evaluations were not uploaded because target support was not confirmed. Core eval results are persisted.",
      });
      return;
    }
    await requestWithRetry(config, ingestPath(config, "runs/evaluations"), {
      runId,
      externalRunId,
      // The policy role's spelling is settled HERE, against the handshake this
      // call already makes, rather than at the dozen builders that mint a
      // definition. A target that does not advertise `vocabulary.values.role`
      // has a `validateScorePayload` that refuses `required`, and the refusal
      // is not a rejected upload — it quarantines every iteration of the run
      // as `score_integrity_invalid`, so the dashboard shows an empty run
      // rather than a broken one. Hash-neutral, so the rows file under the
      // same digests either way.
      evaluations: evaluationsForDeployment(evaluations, capabilities),
    });
  } catch {
    // The core run has already been acknowledged. Keep that fact even when
    // optional advisory persistence fails or the caller cancels this last step.
    addReportingWarning(config, {
      code: "RUN_EVALUATIONS_NOT_CONFIRMED",
      message:
        "Advisory case-run persistence could not be confirmed. Core eval results are persisted; local advisory results remain available.",
    });
  }
}

/**
 * Put every definition's role into the spelling this target accepts.
 *
 * Returns the input unchanged and uncopied when nothing moves, which is both
 * the common case and the one that matters: a target that speaks the canonical
 * vocabulary gets a byte-identical body.
 */
function evaluationsForDeployment(
  evaluations: import("./run-evaluators.js").CaseRunEvaluation[],
  capabilities: unknown
): import("./run-evaluators.js").CaseRunEvaluation[] {
  if (capabilityAcceptsCanonicalRole(capabilities)) return evaluations;
  let changed = false;
  const out = evaluations.map((envelope) => {
    const definitions = definitionsForDeployment(
      envelope.evaluationConfig.definitions,
      capabilities
    );
    if (definitions === envelope.evaluationConfig.definitions) return envelope;
    changed = true;
    return {
      ...envelope,
      evaluationConfig: {
        ...envelope.evaluationConfig,
        definitions: [...definitions],
      },
    };
  });
  return changed ? out : evaluations;
}

function addReportingWarning(
  config: RuntimeConfig,
  warning: EvalReportingWarning
): void {
  config.warnings ??= [];
  if (config.warnings.some((entry) => entry.code === warning.code)) return;
  config.warnings.push(warning);
  try {
    console.warn(`[mcpjam/sdk] ${warning.message}`);
  } catch {
    /* presentation only */
  }
}

/** Attach only SDK-produced diagnostics, never raw backend errors or payloads. */
export function attachReportingWarnings(
  config: RuntimeConfig,
  report: ReportEvalResultsOutput
): ReportEvalResultsOutput {
  return config.warnings?.length
    ? { ...report, warnings: structuredClone(config.warnings) }
    : report;
}

/** Explicit partial terminalization is a semantic contract, never silently downgraded. */
export async function resolveTerminationStatus(
  config: RuntimeConfig,
  input: import("./eval-reporting-types.js").MCPJamReportingConfig
): Promise<"cancelled" | "timed_out" | undefined> {
  if (!input.terminalStatus) return undefined;
  // Reuse the run's answer when there IS one, but never inherit a failed probe.
  // `resolveTargetCapabilities` caches a failure as `null` because every other
  // consumer wants "does not advertise" — here that would turn a transport
  // error into "your target does not support termination", which is a claim we
  // have not earned. So a cache miss or a cached failure asks again and lets
  // the transport error reach the caller as itself.
  const cached = config.capabilitiesCache;
  const capabilities =
    cached && typeof cached === "object"
      ? (cached as { evalsRunTermination?: number })
      : (
          await requestWithRetry<{
            capabilities: { evalsRunTermination?: number };
          }>(config, ingestPath(config, "capabilities"), {})
        ).capabilities;
  if (capabilities.evalsRunTermination !== 1)
    throw new EvalReportingError(
      "SDK_RUN_TERMINATION_UNSUPPORTED: target support is required to explicitly terminate a partial run",
      { isReportingBackendIncompatible: true }
    );
  return input.terminalStatus;
}

function omitRunMetadata(
  input: import("./eval-reporting-types.js").MCPJamReportingConfig
): void {
  delete input.runName;
  delete input.runTags;
  delete input.runMetadata;
  if (input.ci) {
    input.ci = { ...input.ci };
    delete input.ci.dirty;
    delete input.ci.pullRequestNumber;
  }
}

/** A stale capability response must not prevent otherwise valid legacy evidence. */
async function requestStartOrReport<T>(
  config: RuntimeConfig,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  try {
    return await requestWithRetry<T>(config, path, body);
  } catch (error) {
    if (
      !(error instanceof EvalReportingError) ||
      ![400, 422].includes(error.statusCode ?? 0) ||
      !requiresRunMetadataCapability(body)
    )
      throw error;
    // Retry once, with the SAME external identity and evidence. Policy and
    // evaluator fields stay intact, so an invalid core report still fails.
    const legacyBody = { ...body };
    omitRunMetadata(legacyBody);
    addReportingWarning(config, {
      code: "RUN_METADATA_OMITTED",
      message:
        "Optional run metadata was omitted after target validation refused the expanded payload. Core evidence and policy were preserved for retry.",
    });
    return await requestWithRetry<T>(config, path, legacyBody);
  }
}
