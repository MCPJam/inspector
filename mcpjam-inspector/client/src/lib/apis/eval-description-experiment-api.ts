/**
 * The browser client for one description-rewrite experiment.
 *
 * Same shape and the same reasons as `eval-route-facts-api.ts`:
 * `PlatformApiClient` already speaks propose / start / get with typed
 * parameters and URL encoding, so this wraps it rather than hand-rolling a
 * second `fetch`, and the transport strips the client's own `Authorization`
 * header so `authFetch` stays the ONE owner of the bearer.
 *
 * Zod sits at the boundary. The experiment envelope is this module's; the
 * optional `report` is the published SDK contract
 * (`descriptionExperimentReportSchema`). An answer that does not validate
 * is `invalidContract`, not a network blip.
 *
 * ── The four ways this can fail, kept apart ──────────────────────────────────
 *
 * `notFound`, `routeUnavailable`, `invalidContract` and `requestFailed` are
 * four different facts. Collapsing them into "couldn't load" loses the only
 * one a reader can act on. `invalidContract` — the route answered and the
 * answer did not validate — is a bug report, not a retry.
 */
import { PlatformApiClient, isPlatformApiError } from "@mcpjam/sdk/platform";
import {
  descriptionExperimentReportSchema,
  type DescriptionExperimentReport,
} from "@mcpjam/sdk/contract";
import { z } from "zod";
import { authFetch } from "@/lib/session-token";

export const DESCRIPTION_EXPERIMENT_STATUSES = [
  "proposing",
  "proposed",
  "launching",
  "running",
  "reporting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type DescriptionExperimentStatus =
  (typeof DESCRIPTION_EXPERIMENT_STATUSES)[number];

export const DESCRIPTION_EXPERIMENT_NON_TERMINAL_STATUSES = [
  "proposing",
  "launching",
  "running",
  "reporting",
] as const;

export const DESCRIPTION_EXPERIMENT_TERMINAL_STATUSES = [
  "proposed",
  "completed",
  "failed",
  "cancelled",
] as const;

export function isDescriptionExperimentNonTerminal(
  status: string,
): status is (typeof DESCRIPTION_EXPERIMENT_NON_TERMINAL_STATUSES)[number] {
  return (
    DESCRIPTION_EXPERIMENT_NON_TERMINAL_STATUSES as readonly string[]
  ).includes(status);
}

export function isDescriptionExperimentTerminal(
  status: string,
): status is (typeof DESCRIPTION_EXPERIMENT_TERMINAL_STATUSES)[number] {
  return (
    DESCRIPTION_EXPERIMENT_TERMINAL_STATUSES as readonly string[]
  ).includes(status);
}

const proposalSchema = z
  .object({
    description: z.string().min(1),
    proposalHash: z.string().min(1),
    modelUsed: z.string().optional(),
    generatedAt: z.number().optional(),
    promptVersion: z.number().optional(),
    evidence: z
      .object({
        failedIterationIds: z.array(z.string()).optional(),
        trialsRead: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const planSchema = z
  .object({
    caseScope: z.enum(["all", "affected"]),
    repetitions: z.number().optional(),
    plannedTrials: z.number().optional(),
    maxTrials: z.number().optional(),
    judgeAutoRun: z.boolean().optional(),
    proposalUsdMicros: z.number().optional(),
  })
  .passthrough();

/**
 * The HTTP envelope around a description experiment.
 *
 * Passthrough on the root so a later PR-E3 field does not break a reader
 * that only needs status, proposal, plan, and report. The report, when
 * present, is the strict SDK contract.
 */
export const evalDescriptionExperimentSchema = z
  .object({
    id: z.string().min(1),
    suiteId: z.string().min(1),
    sourceRunId: z.string().min(1),
    toolName: z.string().min(1),
    serverId: z.string().optional(),
    originalDescription: z.string().optional(),
    originalDescriptionHash: z.string().optional(),
    affectedCaseIds: z.array(z.string()).optional(),
    executionEngine: z.string().optional(),
    status: z.enum(DESCRIPTION_EXPERIMENT_STATUSES),
    errorCode: z.string().optional(),
    proposal: proposalSchema.optional(),
    plan: planSchema.optional(),
    runGroupId: z.string().optional(),
    arms: z
      .object({
        original: z.string().optional(),
        rewrite: z.string().optional(),
      })
      .passthrough()
      .optional(),
    reportVersion: z.number().optional(),
    report: descriptionExperimentReportSchema.optional(),
    reportSourceMaxUpdatedAt: z.number().optional(),
  })
  .passthrough();

export type EvalDescriptionExperiment = z.infer<
  typeof evalDescriptionExperimentSchema
> & {
  report?: DescriptionExperimentReport;
};

/** Why a description-experiment call did not produce a document. */
export type DescriptionExperimentFailureKind =
  /** The route answered 404: this project has no such experiment (or cannot see it). */
  | "notFound"
  /** The deployment does not serve the description-experiment contract at all. */
  | "routeUnavailable"
  /** The route answered and the payload did not validate against the contract. */
  | "invalidContract"
  /** Network, timeout, auth, 5xx — the call did not complete. */
  | "requestFailed";

export class EvalDescriptionExperimentError extends Error {
  readonly kind: DescriptionExperimentFailureKind;
  readonly status?: number;

  constructor(
    kind: DescriptionExperimentFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : {},
    );
    this.name = "EvalDescriptionExperimentError";
    this.kind = kind;
    this.status = options?.status;
  }
}

export function isEvalDescriptionExperimentError(
  error: unknown,
): error is EvalDescriptionExperimentError {
  return error instanceof EvalDescriptionExperimentError;
}

const experimentFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return authFetch(input as Parameters<typeof authFetch>[0], {
    ...init,
    headers,
  });
};

function client(): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "/api/v1",
    // Empty on purpose — `experimentFetch` strips it and `authFetch`
    // supplies the real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: experimentFetch,
  });
}

/**
 * A deployment that predates the description-experiment routes, as
 * opposed to an experiment that is not there.
 *
 * `FEATURE_NOT_SUPPORTED` and `501` are the two ways an API says "this build
 * does not serve that"; `405` is the same answer from a router that knows the
 * path shape but not this method. A bare 404 (`codeSource === "status"`) is
 * the same dark-ship window. An enveloped 404 is a fact about the experiment.
 */
function isRouteUnavailable(
  status: number,
  code: string,
  codeSource?: "envelope" | "status",
): boolean {
  return (
    code === "FEATURE_NOT_SUPPORTED" ||
    code === "NOT_IMPLEMENTED" ||
    status === 501 ||
    status === 405 ||
    (status === 404 && codeSource === "status")
  );
}

function mapPlatformError(
  error: unknown,
  signal: AbortSignal | undefined,
  notFoundMessage: string,
  unavailableMessage: string,
): never {
  if (signal?.aborted) throw error;
  if (isPlatformApiError(error)) {
    if (isRouteUnavailable(error.status, error.code, error.codeSource)) {
      throw new EvalDescriptionExperimentError(
        "routeUnavailable",
        unavailableMessage,
        { status: error.status, cause: error },
      );
    }
    if (error.status === 404) {
      throw new EvalDescriptionExperimentError("notFound", notFoundMessage, {
        status: error.status,
        cause: error,
      });
    }
    throw new EvalDescriptionExperimentError("requestFailed", error.message, {
      status: error.status,
      cause: error,
    });
  }
  throw new EvalDescriptionExperimentError(
    "requestFailed",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

export function parseEvalDescriptionExperiment(
  raw: unknown,
): EvalDescriptionExperiment {
  const parsed = evalDescriptionExperimentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalDescriptionExperimentError(
      "invalidContract",
      "The description experiment document did not match the published contract.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * Draft a rewritten tool description from a finished run's failed trials.
 *
 * SPENDS a small model budget. The receipt is usually `proposing`; poll
 * {@link fetchEvalDescriptionExperiment} rather than re-proposing.
 */
export async function proposeEvalDescriptionRewrite(
  params: {
    projectId: string;
    runId: string;
    toolName: string;
    caseIds?: string[];
  },
  signal?: AbortSignal,
): Promise<EvalDescriptionExperiment> {
  let raw: unknown;
  try {
    raw = await client().proposeEvalDescriptionRewrite(
      {
        projectId: params.projectId,
        runId: params.runId,
        toolName: params.toolName,
        // An empty list is refused with a 400 — omit it rather than send it.
        ...(params.caseIds && params.caseIds.length > 0
          ? { caseIds: params.caseIds }
          : {}),
      },
      { signal },
    );
  } catch (error) {
    mapPlatformError(
      error,
      signal,
      "Description experiment not found.",
      "This deployment does not serve description experiments.",
    );
  }

  const experiment = parseEvalDescriptionExperiment(raw);
  if (experiment.sourceRunId !== params.runId) {
    throw new EvalDescriptionExperimentError(
      "invalidContract",
      "The description experiment is for a different run than the one requested.",
    );
  }
  return experiment;
}

/**
 * Launch the two-arm experiment (original + rewrite).
 *
 * SPENDS eval-iteration credits. The receipt is usually `launching`; poll
 * {@link fetchEvalDescriptionExperiment}.
 */
export async function startEvalDescriptionExperiment(
  params: {
    projectId: string;
    experimentId: string;
    caseScope?: "all" | "affected";
    iterationOverride?: number;
    maxTrials?: number;
  },
  signal?: AbortSignal,
): Promise<EvalDescriptionExperiment> {
  let raw: unknown;
  try {
    raw = await client().startEvalDescriptionExperiment(
      {
        projectId: params.projectId,
        experimentId: params.experimentId,
        ...(params.caseScope !== undefined
          ? { caseScope: params.caseScope }
          : {}),
        ...(params.iterationOverride !== undefined
          ? { iterationOverride: params.iterationOverride }
          : {}),
        ...(params.maxTrials !== undefined
          ? { maxTrials: params.maxTrials }
          : {}),
      },
      { signal },
    );
  } catch (error) {
    mapPlatformError(
      error,
      signal,
      "Description experiment not found.",
      "This deployment does not serve description experiments.",
    );
  }

  const experiment = parseEvalDescriptionExperiment(raw);
  if (experiment.id !== params.experimentId) {
    throw new EvalDescriptionExperimentError(
      "invalidContract",
      "The description experiment document is for a different experiment than the one requested.",
    );
  }
  return experiment;
}

/**
 * ONE experiment's document, addressed by id.
 *
 * `notFound` here is ABSENCE, not an error to shout about: the API
 * deliberately gives the same answer for "no document" and "not visible".
 */
export async function fetchEvalDescriptionExperiment(
  params: { projectId: string; experimentId: string },
  signal?: AbortSignal,
): Promise<EvalDescriptionExperiment> {
  let raw: unknown;
  try {
    raw = await client().getEvalDescriptionExperiment(
      {
        projectId: params.projectId,
        experimentId: params.experimentId,
      },
      { signal },
    );
  } catch (error) {
    mapPlatformError(
      error,
      signal,
      "Description experiment not found.",
      "This deployment does not serve description experiments.",
    );
  }

  const experiment = parseEvalDescriptionExperiment(raw);
  if (experiment.id !== params.experimentId) {
    throw new EvalDescriptionExperimentError(
      "invalidContract",
      "The description experiment document is for a different experiment than the one requested.",
    );
  }
  return experiment;
}

/**
 * The experiments already attached to a source run, if the collection
 * GET exists. The body is `{ items: [...] }`; anything else — a missing
 * body included — is `invalidContract`, never an empty list. A dark-ship
 * 404 is `routeUnavailable` so the hook can stay absent until the
 * operator proposes.
 */
export async function listEvalDescriptionExperimentsForRun(
  params: { projectId: string; runId: string },
  signal?: AbortSignal,
): Promise<EvalDescriptionExperiment[]> {
  // Collection GET is not on PlatformApiClient yet (PR-E3). Same path
  // family as propose; a dark-ship 404 is `routeUnavailable`.
  const raw = await getCollection(params, signal);
  return parseExperimentCollection(raw, params.runId);
}

async function getCollection(
  params: { projectId: string; runId: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const path = `/api/v1/projects/${encodeURIComponent(params.projectId)}/eval-runs/${encodeURIComponent(params.runId)}/description-experiments`;
  let response: Response;
  try {
    response = await experimentFetch(path, { method: "GET", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new EvalDescriptionExperimentError(
      "requestFailed",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  let body: unknown = undefined;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (response.ok) return body;

  const envelope =
    body && typeof body === "object"
      ? (body as { code?: unknown; error?: { code?: unknown } })
      : undefined;
  const envelopeCode =
    typeof envelope?.code === "string"
      ? envelope.code
      : typeof envelope?.error?.code === "string"
        ? envelope.error.code
        : undefined;
  const code = envelopeCode ?? `HTTP_${response.status}`;
  const codeSource: "envelope" | "status" = envelopeCode ? "envelope" : "status";

  if (isRouteUnavailable(response.status, code, codeSource)) {
    throw new EvalDescriptionExperimentError(
      "routeUnavailable",
      "This deployment does not serve description experiments.",
      { status: response.status },
    );
  }
  if (response.status === 404) {
    throw new EvalDescriptionExperimentError(
      "notFound",
      "Description experiment not found.",
      { status: response.status },
    );
  }
  throw new EvalDescriptionExperimentError(
    "requestFailed",
    typeof (body as { message?: unknown })?.message === "string"
      ? ((body as { message: string }).message)
      : `Description experiment list failed (${response.status}).`,
    { status: response.status },
  );
}

function parseExperimentCollection(
  raw: unknown,
  sourceRunId: string,
): EvalDescriptionExperiment[] {
  const rows =
    raw !== null &&
    typeof raw === "object" &&
    Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : null;
  if (rows === null) {
    throw new EvalDescriptionExperimentError(
      "invalidContract",
      "The description experiment list did not match the published contract.",
    );
  }
  const experiments = rows.map((row) => parseEvalDescriptionExperiment(row));
  for (const experiment of experiments) {
    if (experiment.sourceRunId !== sourceRunId) {
      throw new EvalDescriptionExperimentError(
        "invalidContract",
        "The description experiment is for a different run than the one requested.",
      );
    }
  }
  return experiments;
}
