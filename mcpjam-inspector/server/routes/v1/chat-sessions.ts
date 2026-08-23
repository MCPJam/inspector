/**
 * Public v1 chat-session DETAIL reads — one session's transcript and its
 * incremental per-turn traces.
 *
 * Distinct from the catalog proxy at `GET /chat-sessions` (the list). That
 * route forwards to Convex `/v1/chat-sessions`. These routes call Convex
 * FUNCTIONS (`chatSessions:getSession`, `chatSessions:getSessionTurnTraces`)
 * and then fetch the stored blobs themselves so a caller never receives a
 * `messagesBlobUrl` or `spansBlobUrl`. Those URLs are direct handles with no
 * further authorization and no expiry the caller can reason about.
 *
 * CROSS-PROJECT: optional `?projectId=` is a filter, not an owning path
 * segment (same as the list). A real session that lives in a different
 * project reads as `404 NOT_FOUND` — never `403`, which would confirm the
 * id exists somewhere the caller cannot see.
 *
 * Guest-DENIED. The allowlist entry is the exact match `/^\/chat-sessions$/`
 * and must stay that way: a guest who can list their own rows must not
 * inherit transcript + span reads for free.
 */
import { Hono, type Context } from "hono";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Resource } from "./envelope.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const chatSessions = new Hono();

const TRANSCRIPT_PAGE_SIZE = 50;
const TRANSCRIPT_MAX_PAGE_SIZE = 200;
const TRACE_PAGE_SIZE = 20;
const TRACE_MAX_PAGE_SIZE = 50;
const BLOB_FETCH_TIMEOUT_MS = 10_000;
/**
 * Ceiling on a transcript or span blob we will buffer to serve a page.
 *
 * Above this the session reports `transcriptUnavailable` / `spansUnavailable`
 * rather than being pulled into memory — a conversation too large to hold is
 * a capacity fact about us, not a reason to take the process down.
 */
const BLOB_MAX_BYTES = 8 * 1024 * 1024;

function translatePreflightReadError(
  error: unknown,
  notFoundMessage: string
): WebRouteError {
  return translateConvexReadError(error, {
    scope: "v1.chat-sessions",
    notFoundMessage,
    redactedIsRefusal: true,
  });
}

function notFound(): WebRouteError {
  return new WebRouteError(404, ErrorCode.NOT_FOUND, "Session not found");
}

/**
 * Read a response body as text, giving up once `maxBytes` have arrived.
 *
 * Returns `null` when the body is over the ceiling or cannot be streamed, so
 * the caller reports unavailability rather than a silent truncation — a
 * transcript cut mid-array would either fail to parse or, worse, parse into
 * a conversation that stops early with no sign that it did.
 *
 * The counting is on RECEIVED bytes. Checking `content-length` instead would
 * miss the two cases that matter: a chunked response has no such header, and
 * a present one is a claim, not a measurement.
 */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

type RawMessage = {
  role?: unknown;
  content?: unknown;
  parts?: unknown;
  createdAt?: unknown;
  toolName?: unknown;
};

/**
 * Flatten a message's content to text.
 *
 * Deliberately LOSSY. A stored message can carry tool payloads, base64
 * images and provider-specific blobs; this projects the parts that are
 * words and drops the rest rather than passing an unbounded structure
 * through a public API.
 */
function messageText(message: RawMessage): string {
  if (typeof message.content === "string") return message.content;
  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
    ? message.content
    : [];
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function projectMessage(message: RawMessage): Record<string, unknown> {
  return {
    role: typeof message.role === "string" ? message.role : "unknown",
    text: messageText(message),
    ...(typeof message.toolName === "string"
      ? { toolName: message.toolName }
      : {}),
    ...(typeof message.createdAt === "number"
      ? { createdAt: message.createdAt }
      : {}),
  };
}

type SessionDoc = Record<string, unknown> & {
  messagesBlobUrl?: string;
  projectId?: unknown;
  chatSessionId?: unknown;
  resumeConfig?: unknown;
};

type TurnTraceDoc = {
  turnId?: unknown;
  promptIndex?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  finishReason?: unknown;
  usage?: unknown;
  spanCount?: unknown;
  modelId?: unknown;
  pluginVersionsAtTurn?: unknown;
  spansBlobUrl?: unknown;
};

function parsePositiveLimit(
  raw: string | undefined,
  fallback: number,
  max: number
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `limit must be an integer between 1 and ${max}`
    );
  }
  return Math.min(Math.floor(parsed), max);
}

function parseNonNegativeIntQuery(
  raw: string | undefined,
  name: string
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `${name} must be a value returned as nextCursor by this endpoint`
    );
  }
  return parsed;
}

/**
 * First-turn pins only. The stored `resumeConfig` also carries system
 * prompt, plugin provenance, and image-rendering knobs that a public
 * reader does not need and that we will not start leaking here.
 */
function projectResumePins(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cfg = raw as Record<string, unknown>;
  const pins: Record<string, unknown> = {};
  if (typeof cfg.modelId === "string") pins.modelId = cfg.modelId;
  if (cfg.toolMode === "read_only" || cfg.toolMode === "auto") {
    pins.toolMode = cfg.toolMode;
  }
  if (typeof cfg.environmentId === "string") {
    pins.environmentId = cfg.environmentId;
  }
  if (
    Array.isArray(cfg.serverIds) &&
    cfg.serverIds.every((id) => typeof id === "string")
  ) {
    pins.serverIds = cfg.serverIds;
  }
  return Object.keys(pins).length > 0 ? pins : null;
}

async function loadAuthorizedSession(
  c: Context,
  sessionId: string
): Promise<SessionDoc> {
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let session: SessionDoc | null;
  try {
    session = (await client.query(
      "chatSessions:getSession" as never,
      {
        sessionId,
      } as never
    )) as SessionDoc | null;
  } catch (error) {
    // Preflight semantics: `getSession` refuses with a plain
    // "ChatSession not found or unauthorized" (redacted in production),
    // and the id came from the caller — so refusal and absence must be
    // the same 404 here too. Never 403: that is an existence oracle.
    throw translatePreflightReadError(error, "Session not found");
  }
  if (!session) throw notFound();

  const projectId = c.req.query("projectId");
  if (
    typeof projectId === "string" &&
    projectId.length > 0 &&
    String(session.projectId ?? "") !== projectId
  ) {
    throw notFound();
  }
  return session;
}

async function fetchJsonBlob(
  url: string
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false };
    const text = await readCapped(response, BLOB_MAX_BYTES);
    if (text === null) return { ok: false };
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function loadMessages(session: SessionDoc): Promise<{
  messages: RawMessage[];
  transcriptUnavailable: boolean;
}> {
  if (typeof session.messagesBlobUrl !== "string") {
    return { messages: [], transcriptUnavailable: true };
  }
  const fetched = await fetchJsonBlob(session.messagesBlobUrl);
  if (!fetched.ok) {
    return { messages: [], transcriptUnavailable: true };
  }
  const candidate = Array.isArray(fetched.value)
    ? fetched.value
    : (fetched.value as { messages?: unknown })?.messages;
  if (!Array.isArray(candidate)) {
    return { messages: [], transcriptUnavailable: true };
  }
  return { messages: candidate as RawMessage[], transcriptUnavailable: false };
}

function sessionMeta(
  sessionId: string,
  session: SessionDoc
): Record<string, unknown> {
  const resumeConfig = projectResumePins(session.resumeConfig);
  return {
    id: sessionId,
    chatSessionId:
      typeof session.chatSessionId === "string" ? session.chatSessionId : null,
    projectId: typeof session.projectId === "string" ? session.projectId : null,
    title: typeof session.customTitle === "string" ? session.customTitle : null,
    status: typeof session.status === "string" ? session.status : null,
    origin: typeof session.origin === "string" ? session.origin : null,
    sourceType:
      typeof session.sourceType === "string" ? session.sourceType : null,
    version: typeof session.version === "number" ? session.version : null,
    modelId: typeof session.modelId === "string" ? session.modelId : null,
    startedAt: typeof session.startedAt === "number" ? session.startedAt : null,
    lastActivityAt:
      typeof session.lastActivityAt === "number"
        ? session.lastActivityAt
        : null,
    ...(resumeConfig ? { resumeConfig } : {}),
  };
}

// GET /v1/chat-sessions/:sessionId
//
// The transcript, PAGED and PROJECTED. Two things this deliberately does
// not do:
//
//   1. It never returns `messagesBlobUrl`. That URL is a direct handle on
//      the stored conversation with no further authorization — handing it
//      out would turn one authorized read into an unbounded, unrevocable
//      one, shareable by anyone who receives it. The gateway fetches the
//      blob itself and serves the contents.
//   2. It does not return raw message objects. Stored messages carry tool
//      payloads and provider blobs; the DTO projects role, text and timing.
chatSessions.get("/chat-sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const limit = parsePositiveLimit(
    c.req.query("limit"),
    TRANSCRIPT_PAGE_SIZE,
    TRANSCRIPT_MAX_PAGE_SIZE
  );
  const offset = parseNonNegativeIntQuery(c.req.query("cursor"), "cursor") ?? 0;
  const session = await loadAuthorizedSession(c, sessionId);
  const { messages, transcriptUnavailable } = await loadMessages(session);
  const page = messages.slice(offset, offset + limit);
  return v1Resource(c, {
    ...sessionMeta(sessionId, session),
    /**
     * `null` — never 0 — when the transcript could not be read. Zero is a
     * claim that the visitor said nothing, which is the opposite of what
     * an unreadable blob means.
     */
    messageCount: transcriptUnavailable ? null : messages.length,
    ...(transcriptUnavailable ? { transcriptUnavailable: true } : {}),
    messages: page.map(projectMessage),
    ...(offset + page.length < messages.length
      ? { nextCursor: String(offset + page.length) }
      : {}),
  });
});

function asPromptIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

async function hydrateTurn(
  trace: TurnTraceDoc
): Promise<Record<string, unknown>> {
  let spans: unknown[] = [];
  let spansUnavailable = false;
  if (typeof trace.spansBlobUrl === "string") {
    const fetched = await fetchJsonBlob(trace.spansBlobUrl);
    if (!fetched.ok || !Array.isArray(fetched.value)) {
      spansUnavailable = true;
    } else {
      spans = fetched.value;
    }
  } else {
    spansUnavailable = true;
  }
  const usage =
    trace.usage &&
    typeof trace.usage === "object" &&
    !Array.isArray(trace.usage)
      ? trace.usage
      : undefined;
  return {
    turnId: typeof trace.turnId === "string" ? trace.turnId : null,
    promptIndex: asPromptIndex(trace.promptIndex),
    startedAt: typeof trace.startedAt === "number" ? trace.startedAt : null,
    endedAt: typeof trace.endedAt === "number" ? trace.endedAt : null,
    ...(typeof trace.finishReason === "string"
      ? { finishReason: trace.finishReason }
      : {}),
    ...(usage ? { usage } : {}),
    spanCount:
      typeof trace.spanCount === "number" ? trace.spanCount : spans.length,
    ...(typeof trace.modelId === "string" ? { modelId: trace.modelId } : {}),
    ...(trace.pluginVersionsAtTurn !== undefined
      ? { pluginVersionsAtTurn: trace.pluginVersionsAtTurn }
      : {}),
    spans,
    ...(spansUnavailable ? { spansUnavailable: true } : {}),
  };
}

// GET /v1/chat-sessions/:sessionId/trace
//
// Incremental per-turn traces. `getSessionTurnTraces` returns metadata plus
// a `spansBlobUrl` per turn; this route fetches those blobs (bounded,
// timed out) and inlines the spans. The URL itself never leaves.
//
// `afterPromptIndex` (or `cursor`, the previous page's `nextCursor`) keeps
// the payload to turns the caller has not seen — an agent polling after
// each send does not re-download the whole session.
chatSessions.get("/chat-sessions/:sessionId/trace", async (c) => {
  const sessionId = c.req.param("sessionId");
  const limit = parsePositiveLimit(
    c.req.query("limit"),
    TRACE_PAGE_SIZE,
    TRACE_MAX_PAGE_SIZE
  );
  const cursorAfter = parseNonNegativeIntQuery(c.req.query("cursor"), "cursor");
  const explicitAfter = parseNonNegativeIntQuery(
    c.req.query("afterPromptIndex"),
    "afterPromptIndex"
  );
  // `cursor` wins so the documented pagination loop pages correctly when
  // a caller also left a stale `afterPromptIndex` on the URL.
  const afterPromptIndex = cursorAfter ?? explicitAfter ?? -1;

  const session = await loadAuthorizedSession(c, sessionId);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let traces: TurnTraceDoc[];
  try {
    traces = (await client.query(
      "chatSessions:getSessionTurnTraces" as never,
      { sessionId } as never
    )) as TurnTraceDoc[];
  } catch (error) {
    throw translatePreflightReadError(error, "Session not found");
  }
  if (!Array.isArray(traces)) traces = [];

  const ordered = [...traces].sort((left, right) => {
    const a = asPromptIndex(left.promptIndex) ?? 0;
    const b = asPromptIndex(right.promptIndex) ?? 0;
    return a - b;
  });
  const unseen = ordered.filter((trace) => {
    const index = asPromptIndex(trace.promptIndex);
    return index !== null && index > afterPromptIndex;
  });
  const page = unseen.slice(0, limit);
  const turns = await Promise.all(page.map(hydrateTurn));
  const last = page[page.length - 1];
  const lastIndex = last ? asPromptIndex(last.promptIndex) : null;

  return v1Resource(c, {
    ...sessionMeta(sessionId, session),
    turnCount: unseen.length,
    turns,
    ...(lastIndex !== null && page.length < unseen.length
      ? { nextCursor: String(lastIndex) }
      : {}),
  });
});

export default chatSessions;
