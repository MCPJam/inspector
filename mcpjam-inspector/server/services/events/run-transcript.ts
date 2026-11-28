/**
 * Event runs in the chat (plan phase 4, "Playground: event runs appear in the
 * chat"): every trigger has ONE chat session, and each of its runs appends
 * its turn to it, in order.
 *
 * Persisted through the same `/ingest-chat` path every unattended turn uses
 * (`persistChatSessionToConvex`), with the stored shape the backend accepts
 * for event turns: `sourceType: "direct"` and `origin: "event"` (the backend
 * keeps `event` as an origin, not as a stored source type). The stored user
 * message is the rendered event message — the event inside its untrusted
 * data block — so the Playground shows exactly what the model saw.
 *
 * Ingestion writes a session's WHOLE transcript, so appending means: read the
 * thread as it is now (`GET /direct-chat/detail` with the owner's bearer),
 * append this run, write it back with `expectedVersion`. Runs of one trigger
 * are FIFO-serialized by the backend's claim, so a version conflict is rare;
 * it is retried once from a fresh read. The turn id is derived from the run
 * id, so a run that already landed (re-claimed after a lost lease) is found
 * among the thread's turn traces and written nothing, rather than appended
 * twice or moved onto the next run's prompt.
 *
 * Best effort by construction: a transcript that cannot be read is NOT
 * overwritten with a partial one, and nothing here can fail the run.
 */

import type { ModelMessage } from "ai";
import {
  persistChatSessionToConvex,
  type PersistChatOutcome,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import type { SyntheticModelSource } from "../../utils/org-model-config.js";
import { logger } from "../../utils/logger.js";
import { fetchJsonBlob } from "../../routes/v1/blob-read.js";
import type { EventRunTurnRecord } from "./run-turn-record.js";

const DETAIL_TIMEOUT_MS = 10_000;
const BLOB_TIMEOUT_MS = 10_000;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** One chat thread per trigger. */
export function eventTriggerChatSessionId(triggerId: string): string {
  return `event-trigger-${triggerId}`;
}

/** Stable per run: a run that already landed dedupes instead of appending. */
export function eventRunTurnId(runId: string): string {
  return `event-run-${runId}`;
}

export interface PriorTranscript {
  messages: unknown[];
  version?: number;
  startedAt?: number;
  /** The turn ids of the thread's turn traces: the runs already in it. */
  turnIds?: string[];
}

export interface TranscriptPort {
  /** `null` = no session yet. Throws when the thread exists but cannot be read. */
  load(args: {
    chatSessionId: string;
    projectId: string;
    bearer: string;
  }): Promise<PriorTranscript | null>;
  persist(options: Parameters<typeof persistChatSessionToConvex>[0]): Promise<PersistChatOutcome>;
}

async function loadFromBackend(args: {
  chatSessionId: string;
  projectId: string;
  bearer: string;
}): Promise<PriorTranscript | null> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) throw new Error("CONVEX_HTTP_URL is not set");
  const url = new URL(`${convexUrl.replace(/\/+$/, "")}/direct-chat/detail`);
  url.searchParams.set("chatSessionId", args.chatSessionId);
  url.searchParams.set("projectId", args.projectId);
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${args.bearer}` },
    signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`event run transcript read failed (status ${response.status})`);
  }
  const body = (await response.json()) as {
    session?: { messagesBlobUrl?: string | null; version?: number; startedAt?: number };
    turnTraces?: Array<{ turnId?: unknown }>;
  };
  const parsed = await fetchJsonBlob(body.session?.messagesBlobUrl, {
    timeoutMs: BLOB_TIMEOUT_MS,
    maxBytes: MAX_BLOB_BYTES,
  });
  const messages = Array.isArray(parsed)
    ? parsed
    : (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) {
    throw new Error("event run transcript blob could not be read");
  }
  const turnIds = (Array.isArray(body.turnTraces) ? body.turnTraces : [])
    .map((trace) => trace?.turnId)
    .filter((turnId): turnId is string => typeof turnId === "string");
  return {
    messages,
    ...(typeof body.session?.version === "number" ? { version: body.session.version } : {}),
    ...(typeof body.session?.startedAt === "number" ? { startedAt: body.session.startedAt } : {}),
    turnIds,
  };
}

function countUserMessages(messages: unknown[]): number {
  return messages.filter(
    (message) =>
      !!message && typeof message === "object" && (message as { role?: unknown }).role === "user",
  ).length;
}

/**
 * The engine ran the turn as prompt 0 of a fresh conversation, so its spans
 * and saved requests say prompt 0 and index the run's own messages. In the
 * thread the turn is prompt `promptIndex`, after `messageOffset` earlier
 * messages; without this every run of a trigger lands on the first prompt row.
 */
function alignTurnToThread(
  trace: PersistedTurnTrace,
  promptIndex: number,
  messageOffset: number,
): PersistedTurnTrace {
  return {
    ...trace,
    spans: trace.spans.map((span) => ({
      ...span,
      promptIndex,
      ...(typeof span.messageStartIndex === "number"
        ? { messageStartIndex: span.messageStartIndex + messageOffset }
        : {}),
      ...(typeof span.messageEndIndex === "number"
        ? { messageEndIndex: span.messageEndIndex + messageOffset }
        : {}),
    })),
    ...(trace.requestPayloads
      ? {
          requestPayloads: trace.requestPayloads.map((entry) => ({
            ...entry,
            promptIndex,
          })),
        }
      : {}),
  };
}

export const defaultTranscriptPort: TranscriptPort = {
  load: loadFromBackend,
  persist: (options) => persistChatSessionToConvex(options),
};

export async function persistEventRunTranscript(args: {
  port?: TranscriptPort;
  triggerId: string;
  runId: string;
  projectId: string;
  bearer: string;
  modelId: string;
  modelSource: SyntheticModelSource;
  systemPrompt: string;
  /** This run's whole history, starting with the rendered event message. */
  runMessages: ModelMessage[];
  turnTrace?: PersistedTurnTrace;
  /** The event, environment and skills the turn records (`eventRunTurnRecord`). */
  turnRecord?: EventRunTurnRecord;
  startedAt: number;
}): Promise<{ chatSessionId: string; persisted: boolean }> {
  const port = args.port ?? defaultTranscriptPort;
  const chatSessionId = eventTriggerChatSessionId(args.triggerId);
  const turnId = eventRunTurnId(args.runId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let prior: PriorTranscript | null;
    try {
      prior = await port.load({
        chatSessionId,
        projectId: args.projectId,
        bearer: args.bearer,
      });
    } catch (error) {
      // Never overwrite a thread we could not read with a partial one.
      logger.warn("[events-executor] transcript read failed; run not appended", {
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { chatSessionId, persisted: false };
    }
    // Already in the thread. Ingest would skip the transcript as a duplicate
    // turn but still rewrite the trace row, with this run moved to the next
    // prompt and its spans past its own messages, so write nothing.
    if (prior?.turnIds?.includes(turnId)) {
      logger.info("[events-executor] run already in its thread; transcript not rewritten", {
        runId: args.runId,
      });
      return { chatSessionId, persisted: true };
    }
    // This run's prompt is the next one in the THREAD, not prompt 0 of a
    // fresh conversation (which is what the engine saw).
    const promptIndex = countUserMessages(prior?.messages ?? []);
    const outcome = await port.persist({
      chatSessionId,
      modelId: args.modelId,
      modelSource: args.modelSource,
      authHeader: `Bearer ${args.bearer}`,
      projectId: args.projectId,
      sourceType: "direct",
      origin: "event",
      directVisibility: "project",
      sessionMessages: [...(prior?.messages ?? []), ...args.runMessages],
      systemPrompt: args.systemPrompt,
      startedAt: prior?.startedAt ?? args.startedAt,
      lastActivityAt: Date.now(),
      ...(prior?.version !== undefined ? { expectedVersion: prior.version } : {}),
      turnTrace: {
        ...(args.turnTrace
          ? alignTurnToThread(
              args.turnTrace,
              promptIndex,
              prior?.messages.length ?? 0,
            )
          : {
              startedAt: args.startedAt,
              endedAt: Date.now(),
              spans: [],
              modelId: args.modelId,
            }),
        ...(args.turnRecord ?? {}),
        turnId,
        promptIndex,
      },
    });
    if (outcome.outcome === "conflict") continue;
    const persisted =
      outcome.outcome === "saved" ||
      outcome.outcome === "duplicate" ||
      outcome.outcome === "skipped";
    if (!persisted) {
      logger.warn("[events-executor] transcript not persisted", {
        runId: args.runId,
        outcome: outcome.outcome,
      });
    }
    return { chatSessionId, persisted };
  }
  logger.warn("[events-executor] transcript version conflict persisted twice; run not appended", {
    runId: args.runId,
  });
  return { chatSessionId, persisted: false };
}
