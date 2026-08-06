/**
 * Fetch wrappers for the backend Swarm generation endpoints (`/swarms/*`).
 *
 * Thin cross-repo HTTP boundary like swarm-agent.ts — no MCP manager, no
 * streaming. Errors are surfaced as {@link SwarmAgentError} carrying the
 * backend status; the message prefers the Convex body's `error` field so
 * user-facing copy (e.g. the 429 quota message) propagates through the proxy
 * verbatim.
 */
import { SwarmAgentError } from "./swarm-agent.js";
import { logger } from "../utils/logger.js";

// LLM-backed generation calls; generous timeout to cover slower completions
// (generate-persona makes two model calls behind one request).
const GENERATE_TIMEOUT_MS = 120_000;

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
    throw new SwarmAgentError(response.status, errorText, message);
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
    journeys: data.journeys.slice(0, args.journeyCount),
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
  }
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
  return { journeys: data.journeys.slice(0, args.journeyCount) };
}
