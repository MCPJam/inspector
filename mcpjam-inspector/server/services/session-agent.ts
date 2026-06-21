import type { ServerToolSnapshot } from "../utils/export-helpers.js";
// Reuse eval-agent's attachment payload type — backend treats the wire
// shape identically for both eval generation and session simulation
// (single shared parser in mcpjam-backend/convex/lib/snapshotAttachmentScope.ts).
import type { ServerAttachmentInput } from "./eval-agent.js";

export type { ServerAttachmentInput };

/**
 * Inspector-side adapter for backend AI-generated chatbox session simulation.
 *
 * The persona-slate prompt, persona-as-user driver, and run record live in
 * `mcpjam-backend/convex/sessionSimulation/`. This file is a thin fetch
 * wrapper that trusts the backend's already-normalized payloads. Anything
 * authoring-related (system prompts, LLM calls, billing) belongs server-side.
 *
 * Mirrors the shape of `server/services/eval-agent.ts`.
 */

export interface PersonaSlate {
  id: string;
  name: string;
  role: string;
  notes: string;
}

/**
 * Durable roster persona (Phase 2). Mirrors the `chatboxPersonas` row shape the
 * backend's `chatboxPersonas.listChatboxPersonas` / `getPersonaTrackRecord`
 * return. `personaId` is the slate-compatible string key; `_id` is the durable
 * `personaRefId`. A roster persona maps to a `PersonaSlate`
 * (`{ id: personaId, name, role, notes }`) when launched into a run.
 */
export interface Persona {
  _id: string;
  personaId: string;
  name: string;
  role: string;
  notes: string;
  source: "manual" | "generated" | "cluster";
  seedThemeClusterId?: string;
  seedKeywords?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Project a durable roster persona into the inline slate payload. */
export function personaToSlate(persona: Persona): PersonaSlate {
  return {
    id: persona.personaId,
    name: persona.name,
    role: persona.role,
    notes: persona.notes,
  };
}

export interface RunSummary {
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

export interface RunRecord {
  _id: string;
  chatboxId: string;
  projectId: string;
  createdAt: number;
  createdByUserId?: string;
  personaCount: number;
  sessionsPerPersona: number;
  maxTurns: number;
  personas: PersonaSlate[];
  // `rate_limited` was added on the backend after the LLM driver
  // started returning 429s as a terminal state on the run summary.
  // The dialog already renders the label (Stage 3); this just
  // tightens the type so call sites don't need a defensive cast.
  status: "running" | "completed" | "partial" | "failed" | "rate_limited";
  summary: RunSummary;
  error?: string;
  lastHeartbeatAt: number;
}

export interface PersonaNextTurnResponse {
  message: string;
  endSession: boolean;
}

export interface DeltaSummary {
  succeeded?: number;
  failed?: number;
  rateLimited?: number;
}

// Cross-repo HTTP boundary: every Convex call here can hang on a stuck
// backend, so attach an AbortSignal timeout to all of them. Non-LLM
// control-plane calls (create/get/update) get 30s; LLM-backed calls
// (generatePersonas, personaNextTurn) get 120s to cover slower models.
const NON_LLM_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 120_000;

async function postJson<T>(
  url: string,
  convexAuthToken: string,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${convexAuthToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `session-agent ${url} failed (${response.status}): ${errorText}`
    );
  }
  return (await response.json()) as T;
}

export async function generatePersonas(
  toolSnapshot: ServerToolSnapshot,
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  chatboxId: string,
  personaCount: number,
  serverAttachment?: ServerAttachmentInput
): Promise<PersonaSlate[]> {
  const data = await postJson<{
    ok?: boolean;
    personas?: PersonaSlate[];
    error?: string;
  }>(
    `${convexHttpUrl}/session-simulation/generate-personas`,
    convexAuthToken,
    {
      projectId,
      chatboxId,
      toolSnapshot,
      personaCount,
      ...(serverAttachment ? { serverAttachment } : {}),
    },
    LLM_TIMEOUT_MS
  );
  if (!data.ok || !Array.isArray(data.personas)) {
    throw new Error(
      `Invalid response from backend generatePersonas: ${
        data.error ?? "unknown error"
      }`
    );
  }
  return data.personas;
}

export async function createRun(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  chatboxId: string,
  personas: PersonaSlate[],
  sessionsPerPersona: number,
  maxTurns: number,
  // Phase 2: when the swarm is launched from selected roster personas, pass
  // their durable refs. The backend resolves them into the same persona
  // payload shape and merges with any inline `personas`.
  personaRefIds?: string[]
): Promise<{ runId: string }> {
  const data = await postJson<{
    ok?: boolean;
    runId?: string;
    error?: string;
  }>(
    `${convexHttpUrl}/session-simulation/runs/create`,
    convexAuthToken,
    {
      projectId,
      chatboxId,
      personas,
      sessionsPerPersona,
      maxTurns,
      ...(personaRefIds && personaRefIds.length > 0 ? { personaRefIds } : {}),
    },
    NON_LLM_TIMEOUT_MS
  );
  if (!data.ok || typeof data.runId !== "string") {
    throw new Error(
      `Invalid response from backend createRun: ${
        data.error ?? "unknown error"
      }`
    );
  }
  return { runId: data.runId };
}

export async function personaNextTurn(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string,
  personaId: string,
  transcriptSoFar: Array<{ role: "user" | "assistant"; content: string }>
): Promise<PersonaNextTurnResponse> {
  const data = await postJson<{
    ok?: boolean;
    message?: string;
    endSession?: boolean;
    error?: string;
  }>(
    `${convexHttpUrl}/session-simulation/persona-next-turn`,
    convexAuthToken,
    { projectId, runId, personaId, transcriptSoFar },
    LLM_TIMEOUT_MS
  );
  if (!data.ok || typeof data.message !== "string") {
    throw new Error(
      `Invalid response from backend personaNextTurn: ${
        data.error ?? "unknown error"
      }`
    );
  }
  return {
    message: data.message,
    endSession: data.endSession === true,
  };
}

export async function updateRun(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string,
  deltaSummary: DeltaSummary,
  status?: RunRecord["status"]
): Promise<void> {
  const data = await postJson<{ ok?: boolean; error?: string }>(
    `${convexHttpUrl}/session-simulation/runs/update`,
    convexAuthToken,
    {
      projectId,
      runId,
      deltaSummary,
      ...(status ? { status } : {}),
    },
    NON_LLM_TIMEOUT_MS
  );
  // Backend may return HTTP 200 with {ok: false} for soft validation
  // failures; treat that as an error so callers can decide whether to
  // retry or abort the batch.
  if (data.ok !== true) {
    throw new Error(
      `Invalid response from backend updateRun: ${
        data.error ?? "unknown error"
      }`
    );
  }
}

export async function getRun(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string
): Promise<{ run: RunRecord; threadIds: string[] }> {
  const url = new URL(`${convexHttpUrl}/session-simulation/runs`);
  url.searchParams.set("runId", runId);
  url.searchParams.set("projectId", projectId);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${convexAuthToken}`,
    },
    signal: AbortSignal.timeout(NON_LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `session-agent getRun failed (${response.status}): ${errorText}`
    );
  }
  const data = (await response.json()) as {
    ok?: boolean;
    run?: RunRecord;
    threadIds?: string[];
    error?: string;
  };
  if (!data.ok || !data.run) {
    throw new Error(
      `Invalid response from backend getRun: ${data.error ?? "unknown error"}`
    );
  }
  return { run: data.run, threadIds: data.threadIds ?? [] };
}
