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
    // Prefer the backend's user-facing `error` copy (quota messages, member
    // gate, invalid group) over a generic transport message. A non-JSON body
    // (WAF/HTML interstitial, proxy error page) is NOT user-facing copy and
    // must not reach the client — the route forwards `message` verbatim on
    // every 4xx — so it is logged server-side and the generic message stands.
    let message = `swarm-generate ${url} failed (${response.status})`;
    try {
      const parsed = JSON.parse(errorText) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      if (errorText) {
        logger.warn("[swarm-generate] non-JSON error body from upstream", {
          url,
          status: response.status,
        });
      }
    }
    throw new SwarmAgentError(response.status, errorText, message);
  }
  return (await response.json()) as T;
}

export async function generateSwarmPersona(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    serverAttachmentId: string;
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
      serverAttachmentId: args.serverAttachmentId,
      journeyCount: args.journeyCount,
    },
    args.signal
  );
  if (!data.ok || !data.persona || !Array.isArray(data.journeys)) {
    throw new SwarmAgentError(
      502,
      JSON.stringify(data),
      "Persona generation returned an unexpected response"
    );
  }
  return { persona: data.persona, journeys: data.journeys };
}

export async function generateSwarmJourneys(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    serverAttachmentId: string;
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
      serverAttachmentId: args.serverAttachmentId,
      journeyCount: args.journeyCount,
      persona: args.persona,
    },
    args.signal
  );
  if (!data.ok || !Array.isArray(data.journeys)) {
    throw new SwarmAgentError(
      502,
      JSON.stringify(data),
      "Journey generation returned an unexpected response"
    );
  }
  return { journeys: data.journeys };
}
