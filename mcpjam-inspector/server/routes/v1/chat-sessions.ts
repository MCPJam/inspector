/**
 * Public v1 AGENT PLAYGROUND surface — drive a conversation and read what it
 * produced.
 *
 * WHAT THIS IS FOR. Every other machine surface can LAUNCH work that produces
 * sessions (eval runs, journey runs) and then read the result. None of them
 * can do what a human does in the Playground: send one message, watch which
 * tools the model picked and what the server actually returned, and decide the
 * next message from that. These three routes are that loop, plus the telemetry
 * a participant in the conversation could never see — per-call latency, token
 * usage, raw wire values.
 *
 * ONE PUBLIC ID. `sessionId` everywhere in this module is the `chatSessions`
 * DOCUMENT id, the same id `GET /v1/chat-sessions` returns and the same id the
 * trace and detail reads take. The runtime `chatSessionId` UUID — the ingest
 * write key — is INTERNAL and never leaves this file. Two ids on a public
 * surface is how callers pass the wrong one and get an opaque 404 they cannot
 * diagnose; see the two-id trap documented at `journeys.ts:291`.
 *
 * THE THREE ROUTES, and why they are one module:
 *
 *   GET  /chat-sessions/:sessionId        — metadata + bounded raw messages
 *   GET  /chat-sessions/:sessionId/trace  — per-turn spans, incrementally
 *   POST /chat-sessions/messages          — one turn (creates or continues)
 *
 * The detail read is not optional garnish. Trace spans reference transcript
 * messages BY INDEX, so an agent debugging a past turn needs both reads to
 * resolve a span to the payload that produced it. Shipping the trace alone
 * would ship a pointer with nothing to point at.
 *
 * SCOPING. `chatSessions:getSession` authorizes at the WORKSPACE level — a
 * project member can legitimately read a swarm session in a sibling project of
 * the same workspace. That is wider than this surface wants, so when a caller
 * names a project every route asserts the session belongs to it and 404s
 * otherwise. Refusal and absence are the SAME 404 on purpose: a 403 would make
 * this an existence oracle for sessions the caller cannot see.
 *
 * GUESTS are denied by default and deliberately: the guest allowlist entry is
 * the exact-match `/^\/chat-sessions$/`, so none of the subpaths here match it,
 * and a turn spends hosted-model credits.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ConvexHttpClient } from "convex/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Resource } from "./envelope.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { fetchJsonBlob } from "./blob-read.js";
import { projectMessages } from "./chat-session-payloads.js";
import { registerChatSessionTurnRoute } from "./chat-session-turn.js";

const chatSessions = new Hono();

const BLOB_FETCH_TIMEOUT_MS = 10_000;
/**
 * Ceiling on a transcript or span blob we will buffer to serve a read. Above
 * this the read reports unavailability rather than pulling the blob into
 * memory — a conversation too large to hold is a capacity fact about us, not
 * a reason to take the process down.
 */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

const DEFAULT_MESSAGE_PAGE = 50;
const MAX_MESSAGE_PAGE = 200;
/**
 * Default number of TURNS a trace read returns: the latest one.
 *
 * Not "all of them". A long session's spans are the largest thing this API
 * can emit, the caller is usually a model paying per token, and the turn they
 * just took is the one they are debugging. Older turns are reachable by
 * selector, which is a request the caller made deliberately.
 */
const DEFAULT_TRACE_TURNS = 1;
const MAX_TRACE_TURNS = 20;

/**
 * The `chatSessions` fields these reads consume, hand-mirrored.
 *
 * `getSession` spreads the whole document, so this is deliberately narrower
 * than what arrives — naming the fields we depend on is what makes a backend
 * projection change show up as a type error here rather than as a silently
 * absent field in a public response.
 */
type SessionRow = {
  _id: string;
  chatSessionId?: string;
  projectId?: string;
  origin?: string;
  modelId?: string;
  version?: number;
  startedAt?: number;
  lastActivityAt?: number;
  messagesBlobUrl?: string | null;
  resumeConfig?: {
    modelId?: string;
    toolMode?: "read_only" | "auto";
    environmentId?: string;
    serverIds?: string[];
    systemPrompt?: string;
    temperature?: number;
  };
};

/** The `getSessionTurnTraces` projection, hand-mirrored. */
type TurnTraceRow = {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  finishReason?: string;
  modelId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  spanCount?: number;
  spansBlobUrl?: string | null;
};

/**
 * Preflight semantics for a caller-supplied session id.
 *
 * `getSession` refuses with a plain error that production Convex redacts to
 * "Server Error"; without `redactedIsRefusal` a cross-workspace probe answers
 * 502 — an existence oracle plus a Sentry page — instead of the 404 the
 * preflight exists to guarantee.
 */
function translatePreflightReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, {
    scope: "v1.chat-sessions",
    notFoundMessage: "Chat session not found",
    redactedIsRefusal: true,
  });
}

/** Reads AFTER the preflight: a redacted error there is a genuine incident. */
function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.chat-sessions" });
}

/**
 * Resolve a session the caller may see, scoped to a project when they named
 * one.
 *
 * Exported because the turn route needs the identical resolution for a
 * continuation — the check that a caller may append to a session must not be
 * a second, subtly different implementation of the check that they may read
 * it.
 */
export async function resolveScopedSession(
  client: ConvexHttpClient,
  sessionId: string,
  projectId?: string,
): Promise<SessionRow> {
  let session: SessionRow | null;
  try {
    session = (await client.query(
      "chatSessions:getSession" as never,
      {
        sessionId,
      } as never,
    )) as SessionRow | null;
  } catch (error) {
    throw translatePreflightReadError(error);
  }
  if (!session) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Chat session not found");
  }
  // Same 404 as absence. The caller named a project; a session in a different
  // one is, from this request's point of view, not there.
  if (projectId && String(session.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Chat session not found");
  }
  return session;
}

/** Shared scaffolding: mint the delegated bearer and a Convex client. */
export async function chatSessionClient(c: Context): Promise<ConvexHttpClient> {
  return createConvexClient(await getConvexBearerForRequest(c as never));
}

/**
 * Parse a bounded integer query parameter.
 *
 * VALIDATED, NOT COERCED. `Number("oops")` is `NaN`, which silently became
 * "the default" — so a caller paging with a mistyped cursor got already-seen
 * data back with no signal, and could act on the same turn twice.
 */
function intQuery(
  c: Context,
  name: string,
  options: { min: number; max?: number },
): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < options.min) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `${name} must be an integer >= ${options.min}`,
    );
  }
  return options.max !== undefined ? Math.min(parsed, options.max) : parsed;
}

function boolQuery(c: Context, name: string): boolean | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `${name} must be "true" or "false"`,
  );
}

/** Read the stored transcript, or report that we could not. */
async function loadTranscript(
  session: SessionRow,
): Promise<{ messages: unknown[]; unavailable: boolean }> {
  // `messagesBlobId` is a required backend field, so a session ALWAYS has a
  // blob. A null URL means the stored file is gone — "we cannot read it", not
  // "the conversation is empty".
  const parsed = await fetchJsonBlob(session.messagesBlobUrl, {
    timeoutMs: BLOB_FETCH_TIMEOUT_MS,
    maxBytes: MAX_BLOB_BYTES,
  });
  if (parsed === null) return { messages: [], unavailable: true };
  const candidate = Array.isArray(parsed)
    ? parsed
    : (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(candidate)) return { messages: [], unavailable: true };
  return { messages: candidate as unknown[], unavailable: false };
}

/**
 * The transcript as MODEL MESSAGES, for a continuation turn to resume from.
 *
 * Separate from `loadTranscript` only in what it does with failure: a read can
 * report `transcriptUnavailable` and still be useful, but a continuation that
 * silently resumed from an EMPTY history would send the model a conversation
 * with no past and bill the caller for the wrong answer. So this throws.
 */
export async function loadResumeHistory(
  session: SessionRow,
): Promise<unknown[]> {
  const { messages, unavailable } = await loadTranscript(session);
  if (unavailable) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "The stored transcript for this session could not be read, so the conversation cannot be continued. Retry, or start a new session.",
    );
  }
  return messages;
}

// ── GET /v1/chat-sessions/:sessionId ────────────────────────────────────────

/**
 * Session metadata plus a bounded window of raw messages.
 *
 * The window is absolute-indexed (`afterMessageIndex`), not cursor-opaque, and
 * that is the contract: trace spans point into the transcript positionally, so
 * an agent that read a span pointing at message 7 asks for message 7 by
 * number. An opaque cursor would make the one join this read exists for
 * impossible.
 */
chatSessions.get("/chat-sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const projectId = c.req.query("projectId");
  const client = await chatSessionClient(c);
  const session = await resolveScopedSession(client, sessionId, projectId);

  const offset = intQuery(c, "afterMessageIndex", { min: 0 }) ?? 0;
  const limit =
    intQuery(c, "limit", { min: 1, max: MAX_MESSAGE_PAGE }) ??
    DEFAULT_MESSAGE_PAGE;

  const { messages, unavailable } = await loadTranscript(session);
  const page = messages.slice(offset, offset + limit);

  return v1Resource(c, {
    sessionId: session._id,
    projectId: session.projectId ?? null,
    origin: session.origin ?? null,
    modelId: session.modelId ?? null,
    version: session.version ?? null,
    startedAt: session.startedAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
    // The first-turn pins, so a caller who lost track of how a session was
    // configured can read it back rather than guess — and so the
    // `CONFIG_ON_CONTINUATION` refusal is explicable from the API alone.
    toolMode: session.resumeConfig?.toolMode ?? null,
    environmentId: session.resumeConfig?.environmentId ?? null,
    /**
     * `null` — never 0 — when the transcript could not be read. Zero is a
     * claim that the conversation is empty, which is the opposite of what an
     * unreadable blob means.
     */
    messageCount: unavailable ? null : messages.length,
    ...(unavailable ? { transcriptUnavailable: true as const } : {}),
    messages: projectMessages(page, offset),
    ...(offset + page.length < messages.length
      ? { nextMessageIndex: offset + page.length }
      : {}),
  });
});

// ── GET /v1/chat-sessions/:sessionId/trace ──────────────────────────────────

/**
 * Per-turn execution trace: spans with per-call latency, token usage, and
 * message indices.
 *
 * INCREMENTAL BY DEFAULT. `limit` defaults to the LATEST turn, not to the
 * whole session, because "all spans for all turns" is both the largest thing
 * this API can emit and almost never what a debugging caller wants. Older
 * turns come back through `turnId` or `afterPromptIndex`; `includeSpans=false`
 * gives the cheap per-turn summary for deciding which turn to pull.
 *
 * The per-turn shape is the eval trace shape on purpose — the same
 * `EvalTraceSpan[]` the eval iteration read returns, which
 * `client/src/components/evals/trace-viewer-adapter.ts` already renders. One
 * span vocabulary across evals and chat is what lets a caller (or a viewer)
 * treat them as the same kind of evidence.
 */
chatSessions.get("/chat-sessions/:sessionId/trace", async (c) => {
  const sessionId = c.req.param("sessionId");
  const projectId = c.req.query("projectId");
  const client = await chatSessionClient(c);
  const session = await resolveScopedSession(client, sessionId, projectId);

  const turnId = c.req.query("turnId");
  const afterPromptIndex = intQuery(c, "afterPromptIndex", { min: 0 });
  if (turnId !== undefined && afterPromptIndex !== undefined) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Pass at most one of turnId or afterPromptIndex",
    );
  }
  const limit =
    intQuery(c, "limit", { min: 1, max: MAX_TRACE_TURNS }) ??
    DEFAULT_TRACE_TURNS;
  const includeSpans = boolQuery(c, "includeSpans") ?? true;

  let rows: TurnTraceRow[];
  try {
    rows = ((await client.query(
      "chatSessions:getSessionTurnTraces" as never,
      {
        sessionId,
      } as never,
    )) ?? []) as TurnTraceRow[];
  } catch (error) {
    throw translateReadError(error);
  }

  if (rows.length === 0) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "No turn traces have been recorded for this session",
    );
  }

  // Ascending by promptIndex — the backend already sorts, restated here
  // because the WINDOWING below is only correct on a sorted list and a future
  // projection change must not silently reorder it.
  const ordered = [...rows].sort((a, b) => a.promptIndex - b.promptIndex);

  let selected: TurnTraceRow[];
  if (turnId !== undefined) {
    selected = ordered.filter((row) => row.turnId === turnId);
    if (selected.length === 0) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "No turn trace with that turnId in this session",
      );
    }
  } else if (afterPromptIndex !== undefined) {
    selected = ordered
      .filter((row) => row.promptIndex > afterPromptIndex)
      .slice(0, limit);
  } else {
    // The DEFAULT window: the last `limit` turns, still in ascending order.
    selected = ordered.slice(Math.max(0, ordered.length - limit));
  }

  const turns = await Promise.all(
    selected.map(async (row) => {
      const base = {
        turnId: row.turnId,
        promptIndex: row.promptIndex,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        ...(row.finishReason ? { finishReason: row.finishReason } : {}),
        ...(row.modelId ? { modelId: row.modelId } : {}),
        ...(row.usage ? { usage: normalizeUsage(row.usage) } : {}),
        spanCount: row.spanCount ?? 0,
      };
      if (!includeSpans) return base;
      const parsed = await fetchJsonBlob(row.spansBlobUrl, {
        timeoutMs: BLOB_FETCH_TIMEOUT_MS,
        maxBytes: MAX_BLOB_BYTES,
      });
      if (parsed === null) {
        // NEVER a silent empty array. "This turn made no calls" and "we could
        // not fetch the evidence" are opposite conclusions, and an agent
        // reading an empty span list would act on the first.
        return { ...base, spansUnavailable: true as const };
      }
      const spans = Array.isArray(parsed)
        ? (parsed as EvalTraceSpan[])
        : ((parsed as { spans?: unknown })?.spans as EvalTraceSpan[]) ??
          undefined;
      if (!Array.isArray(spans)) {
        return { ...base, spansUnavailable: true as const };
      }
      return {
        ...base,
        spans,
        // The blob is the record; a count that disagrees with it means the
        // reader is looking at a partial write, and saying so is cheaper than
        // letting the caller discover it by arithmetic.
        ...(base.spanCount > 0 && spans.length < base.spanCount
          ? { spansTruncated: true as const }
          : {}),
      };
    }),
  );

  return v1Resource(c, {
    sessionId: session._id,
    origin: session.origin ?? null,
    traceVersion: 1,
    turnCount: ordered.length,
    turns,
    ...(ordered.length > 0
      ? { latestPromptIndex: ordered[ordered.length - 1]!.promptIndex }
      : {}),
  });
});

/** Fill the token fields the public shape promises, without inventing totals. */
function normalizeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
}): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

// ── POST /v1/chat-sessions/messages ─────────────────────────────────────────

registerChatSessionTurnRoute(chatSessions);

export default chatSessions;
export type { SessionRow };
