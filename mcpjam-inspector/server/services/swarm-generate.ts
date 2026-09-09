/**
 * Fetch wrappers for the backend Swarm generation endpoints (`/swarms/*`).
 *
 * Thin cross-repo HTTP boundary like swarm-agent.ts — no MCP manager, no
 * streaming. Errors are surfaced as {@link SwarmAgentError} carrying the
 * backend status; the message prefers the Convex body's `error` field so
 * user-facing copy (e.g. the 429 quota message) propagates through the proxy
 * verbatim.
 */
import { SwarmAgentError, upstreamRetryAfter } from "./swarm-agent.js";
import { logger } from "../utils/logger.js";

// LLM-backed generation calls; generous timeout to cover slower completions.
// A batch persona request is one slate call plus one journey call per persona
// — the backend fans the journey calls out concurrently, so wall-clock is
// roughly two sequential calls regardless of slate size, but the largest
// slates still need more room than a single completion.
const GENERATE_TIMEOUT_MS = 180_000;

export interface SwarmGeneratedJourney {
  name?: string;
  goal: string;
}

export interface SwarmGeneratedPersona {
  name: string;
  role: string;
  notes?: string;
}

export interface GenerateSwarmPersonaResult {
  persona: SwarmGeneratedPersona;
  journeys: SwarmGeneratedJourney[];
}

/** Free-text audience description + dedup hints, both optional and both
 * forwarded verbatim to the backend prompts. */
export interface SwarmGenerationGrounding {
  description?: string;
  existingPersonas?: { name: string; role: string }[];
}

export interface GenerateSwarmPersonaBatchResult {
  personas: GenerateSwarmPersonaResult[];
}

export interface GenerateSwarmJourneysResult {
  journeys: SwarmGeneratedJourney[];
}

async function postGenerate<T>(
  url: string,
  bearer: string,
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(GENERATE_TIMEOUT_MS), signal])
      : AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    // The route forwards this message VERBATIM to the browser on every 4xx,
    // so the default must carry no transport detail: `url` is the Convex
    // deployment endpoint, and a non-JSON body (WAF/HTML interstitial, proxy
    // error page) is not user-facing copy either. Only the backend's own
    // `error` string — quota messages, member gate, invalid group — is
    // allowed to replace it. Everything else is logged server-side.
    let message = `Generation request failed (${response.status}).`;
    let usedBackendCopy = false;
    try {
      const parsed = JSON.parse(errorText) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
        usedBackendCopy = true;
      }
    } catch {
      // Unparseable body — fall through to the generic message.
    }
    if (!usedBackendCopy) {
      logger.warn("[swarm-generate] upstream error carried no usable copy", {
        url,
        status: response.status,
      });
    }
    throw new SwarmAgentError(
      response.status,
      errorText,
      message,
      upstreamRetryAfter(response)
    );
  }
  return (await response.json()) as T;
}

/**
 * The generated rows are written straight into Convex mutations whose
 * validators reject a missing goal / name / role. Validating the SHAPE here
 * — not just the containers — keeps a malformed upstream payload from
 * committing a persona that every subsequent journey write then rejects,
 * stranding a journey-less row. A bad shape is an upstream defect, so the
 * whole response is refused rather than partially salvaged.
 */
function isGeneratedPersona(value: unknown): value is SwarmGeneratedPersona {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!nonEmpty(p.name) || !nonEmpty(p.role)) return false;
  return p.notes === undefined || typeof p.notes === "string";
}

function isGeneratedJourneyList(
  value: unknown
): value is SwarmGeneratedJourney[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const j = entry as Record<string, unknown>;
    if (typeof j.goal !== "string" || j.goal.trim().length === 0) return false;
    return j.name === undefined || typeof j.name === "string";
  });
}

/**
 * Copy one journey for the client. Extra fields the backend may still emit
 * (including per-tool `suggestedChecks`) are stripped — this create flow
 * does not carry deterministic tool checks.
 */
function sanitizeGeneratedJourney(
  journey: SwarmGeneratedJourney
): SwarmGeneratedJourney {
  return {
    goal: journey.goal,
    ...(journey.name !== undefined ? { name: journey.name } : {}),
  };
}

export async function generateSwarmPersona(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    /** Exactly one grounding source — the route's zod refine enforces it. */
    serverAttachmentId?: string;
    environmentId?: string;
    journeyCount: number;
    signal?: AbortSignal;
  }
): Promise<GenerateSwarmPersonaResult> {
  const data = await postGenerate<{
    ok?: boolean;
    persona?: SwarmGeneratedPersona;
    journeys?: SwarmGeneratedJourney[];
  }>(
    `${convexHttpUrl}/swarms/generate-persona`,
    bearer,
    {
      projectId: args.projectId,
      ...(args.serverAttachmentId
        ? { serverAttachmentId: args.serverAttachmentId }
        : {}),
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      journeyCount: args.journeyCount,
    },
    args.signal
  );
  if (
    !data.ok ||
    !isGeneratedPersona(data.persona) ||
    !isGeneratedJourneyList(data.journeys)
  ) {
    throw new SwarmAgentError(
      502,
      JSON.stringify(data),
      "Persona generation returned an unexpected response"
    );
  }
  // The user's 1-5 choice is authoritative. The backend already truncates to
  // the requested count, but over-delivery here would silently write more
  // rows than were asked for — so clamp rather than trust. Truncating (not
  // rejecting) mirrors the backend's own slate contract.
  return {
    persona: data.persona,
    journeys: data.journeys
      .slice(0, args.journeyCount)
      .map(sanitizeGeneratedJourney),
  };
}

/**
 * Batch sibling of {@link generateSwarmPersona}: one request, a slate of
 * `personaCount` personas, each with its own journeys.
 *
 * Sending `personaCount` is what selects the batch response shape backend-side
 * — its absence keeps the legacy single-persona shape for deployed clients —
 * so this function and `generateSwarmPersona` hit the same URL and differ only
 * in that field.
 *
 * The backend drops a persona whose journey slate failed rather than failing
 * the whole request, so a short slate is a normal (partial) success. Only an
 * empty one is an error.
 */
export async function generateSwarmPersonaBatch(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    /** Exactly one grounding source — the route's zod refine enforces it. */
    serverAttachmentId?: string;
    environmentId?: string;
    personaCount: number;
    journeyCount: number;
    signal?: AbortSignal;
  } & SwarmGenerationGrounding
): Promise<GenerateSwarmPersonaBatchResult> {
  const data = await postGenerate<{
    ok?: boolean;
    personas?: unknown;
    // Tolerated for a backend that predates the batch shape: the deploy order
    // makes this unreachable, but a one-element wrap is cheaper than a
    // confusing 502 if the two repos ever ship out of order.
    persona?: SwarmGeneratedPersona;
    journeys?: SwarmGeneratedJourney[];
  }>(
    `${convexHttpUrl}/swarms/generate-persona`,
    bearer,
    {
      projectId: args.projectId,
      ...(args.serverAttachmentId
        ? { serverAttachmentId: args.serverAttachmentId }
        : {}),
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      personaCount: args.personaCount,
      journeyCount: args.journeyCount,
      ...(args.description ? { description: args.description } : {}),
      ...(args.existingPersonas?.length
        ? { existingPersonas: args.existingPersonas }
        : {}),
    },
    args.signal
  );

  const rawEntries = Array.isArray(data.personas)
    ? data.personas
    : data.ok && isGeneratedPersona(data.persona)
    ? [{ persona: data.persona, journeys: data.journeys }]
    : null;
  const valid =
    data.ok &&
    rawEntries !== null &&
    rawEntries.length > 0 &&
    rawEntries.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return (
        isGeneratedPersona(e.persona) && isGeneratedJourneyList(e.journeys)
      );
    });
  if (!valid) {
    throw new SwarmAgentError(
      502,
      JSON.stringify(data),
      "Persona generation returned an unexpected response"
    );
  }

  // Both counts are enforced locally for the same reason the single-persona
  // path clamps journeys: the user's choice is authoritative, and
  // over-delivery would silently write more rows than were asked for.
  return {
    personas: (rawEntries as GenerateSwarmPersonaResult[])
      .slice(0, args.personaCount)
      .map((entry) => ({
        persona: entry.persona,
        journeys: entry.journeys
          .slice(0, args.journeyCount)
          .map(sanitizeGeneratedJourney),
      })),
  };
}

export async function generateSwarmJourneys(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    /** Exactly one grounding source — the route's zod refine enforces it. */
    serverAttachmentId?: string;
    environmentId?: string;
    journeyCount: number;
    persona: SwarmGeneratedPersona;
    signal?: AbortSignal;
  } & SwarmGenerationGrounding
): Promise<GenerateSwarmJourneysResult> {
  const data = await postGenerate<{
    ok?: boolean;
    journeys?: SwarmGeneratedJourney[];
  }>(
    `${convexHttpUrl}/swarms/generate-journeys`,
    bearer,
    {
      projectId: args.projectId,
      ...(args.serverAttachmentId
        ? { serverAttachmentId: args.serverAttachmentId }
        : {}),
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      journeyCount: args.journeyCount,
      persona: args.persona,
      ...(args.description ? { description: args.description } : {}),
    },
    args.signal
  );
  if (!data.ok || !isGeneratedJourneyList(data.journeys)) {
    throw new SwarmAgentError(
      502,
      JSON.stringify(data),
      "Journey generation returned an unexpected response"
    );
  }
  // See generateSwarmPersona: the requested count is enforced locally.
  return {
    journeys: data.journeys
      .slice(0, args.journeyCount)
      .map(sanitizeGeneratedJourney),
  };
}
