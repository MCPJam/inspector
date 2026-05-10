import type { Context } from "hono";
import { logger } from "./logger";
import { getRequestLogger } from "./request-logger";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";

const DEFAULT_INGEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_PREVIEW_CHARS = 200;

/**
 * Headers worth forwarding from the browser request to the Convex ingestion
 * endpoint so that usage-insights enrichment (device, language) works.
 */
const ENRICHMENT_HEADERS_TO_FORWARD = [
  "user-agent",
  "accept-language",
] as const;

/**
 * Pick enrichment-relevant headers from an incoming request so they can be
 * forwarded to the Convex `/ingest-chat` endpoint.
 */
export function pickEnrichmentHeaders(
  reqHeaders: { get(name: string): string | null | undefined } | Headers,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ENRICHMENT_HEADERS_TO_FORWARD) {
    const value =
      typeof reqHeaders.get === "function" ? reqHeaders.get(name) : undefined;
    if (value) {
      result[name] = value;
    }
  }
  return result;
}

interface ResumeConfig {
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  selectedServers?: string[];
}

/**
 * Direct-chat host configuration sent alongside the transcript so the backend
 * can dedupe per-turn config into `hostConfigs`. Mirrors the `HostConfigPayload`
 * shape accepted by the Convex `/ingest-chat` route. Only emitted for direct
 * chats (serverShare and chatbox flows skip it).
 *
 * Phase 3 read switch: `hostStyle` carries the real host style
 * (`claude` / `chatgpt`). The legacy literal `"direct"` is kept in
 * the union for one deploy so an old backend (still expecting
 * `'direct'`) keeps working until its roll lands; the new backend
 * accepts both and normalizes legacy `'direct'` to the project
 * default's real style with a `legacy_direct_style` warn.
 */
export type DirectChatHostStyle = "claude" | "chatgpt" | "direct";
export interface DirectHostConfig {
  hostStyle: DirectChatHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  selectedServerIds: string[];
}

/**
 * Build a contract-safe direct `hostConfig` payload from the inspector's
 * loose runtime values. Coerces undefined `systemPrompt` / `temperature` /
 * `requireToolApproval` / `selectedServerIds` into the types the backend's
 * `isHostConfigPayload` guard requires — without this, paths like GPT-5 (where
 * `resolvedTemperature` is undefined) would fail the guard and skip with
 * `missing_field`.
 *
 * `hostStyle` defaults to `"claude"` when the caller doesn't supply one.
 * Old call sites that used to hardcode `"direct"` should pass the
 * resolved chat-tab host style instead — see ChatTabV2's hydration
 * from project default for the source of truth.
 */
export function buildDirectHostConfig(input: {
  modelId: string;
  hostStyle?: DirectChatHostStyle;
  systemPrompt?: string;
  requestedTemperature?: number;
  resolvedTemperature?: number;
  requireToolApproval?: boolean;
  selectedServerIds?: string[];
}): DirectHostConfig {
  const {
    modelId,
    hostStyle,
    systemPrompt,
    requestedTemperature,
    resolvedTemperature,
    requireToolApproval,
    selectedServerIds,
  } = input;
  return {
    hostStyle: hostStyle ?? "claude",
    systemPrompt: systemPrompt ?? "",
    modelId,
    temperature:
      typeof resolvedTemperature === "number"
        ? resolvedTemperature
        : typeof requestedTemperature === "number"
          ? requestedTemperature
          : 0.7,
    requireToolApproval: requireToolApproval === true,
    selectedServerIds: selectedServerIds ?? [],
  };
}

/**
 * Shape of a single completed chat turn's trace as it flows from the stream
 * producers (`streamDirectChatWithLiveTrace`, `handleMCPJamFreeChatModel`)
 * through `persistChatSessionToConvex` to the Convex `/ingest-chat` handler.
 * Kept in one place so the producer callbacks and the wire body can't drift.
 */
export interface PersistedTurnTrace {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  spans: EvalTraceSpan[];
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  modelId: string;
}

interface PersistChatSessionOptions {
  chatSessionId: string;
  modelId: string;
  modelSource: "mcpjam" | "byok" | "local_byok";
  authHeader?: string;
  projectId?: string;
  sourceType?: "chatbox" | "direct";
  directVisibility?: "private" | "project";
  surface?: "preview" | "share_link";
  chatboxToken?: string;
  serverId?: string;
  visitorDisplayName?: string;
  sessionMessages?: unknown[];
  messages?: unknown[];
  systemPrompt?: string;
  responseMessages?: unknown[];
  assistantText?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  startedAt: number;
  lastActivityAt?: number;
  timeoutMs?: number;
  resumeConfig?: ResumeConfig;
  expectedVersion?: number;
  turnTrace?: PersistedTurnTrace;
  hostConfig?: DirectHostConfig;
  /** Headers from the original browser request to forward for usage enrichment (user-agent, accept-language, geo headers). */
  forwardHeaders?: Record<string, string>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sanitizeDiagnosticText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const masked = normalized
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?([^"',\s}]+)/gi,
      (_match, prefix: string, scheme?: string) =>
        `${prefix}${scheme ?? ""}[redacted-token]`,
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]+\b/gi, "$1[redacted-token]")
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
      "$1[redacted-secret]",
    )
    .replace(/\bsk-[A-Za-z0-9]+\b/g, "[redacted-secret]");

  if (masked.length <= MAX_RESPONSE_PREVIEW_CHARS) {
    return masked;
  }

  return `${masked.slice(0, MAX_RESPONSE_PREVIEW_CHARS)}...`;
}

async function readResponsePreview(response: Response): Promise<string> {
  const responseText = await response.text().catch(() => "");
  return sanitizeDiagnosticText(responseText);
}

export async function persistChatSessionToConvex(
  options: PersistChatSessionOptions,
  c?: Context,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl || !options.authHeader || !options.chatSessionId) {
    return;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${convexUrl}/ingest-chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: options.authHeader,
        ...options.forwardHeaders,
      },
      signal: controller.signal,
      body: JSON.stringify({
        chatSessionId: options.chatSessionId,
        modelId: options.modelId,
        modelSource: options.modelSource,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.sourceType ? { sourceType: options.sourceType } : {}),
        ...(options.directVisibility
          ? { directVisibility: options.directVisibility }
          : {}),
        ...(options.surface ? { surface: options.surface } : {}),
        ...(options.chatboxToken ? { chatboxToken: options.chatboxToken } : {}),
        ...(options.serverId ? { serverId: options.serverId } : {}),
        ...(options.visitorDisplayName
          ? { visitorDisplayName: options.visitorDisplayName }
          : {}),
        ...(options.sessionMessages
          ? { sessionMessages: options.sessionMessages }
          : {}),
        ...(options.messages ? { messages: options.messages } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.responseMessages
          ? { responseMessages: options.responseMessages }
          : {}),
        ...(options.assistantText
          ? { assistantText: options.assistantText }
          : {}),
        ...(options.toolCalls ? { toolCalls: options.toolCalls } : {}),
        ...(options.toolResults ? { toolResults: options.toolResults } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.finishReason ? { finishReason: options.finishReason } : {}),
        startedAt: options.startedAt,
        ...(options.lastActivityAt
          ? { lastActivityAt: options.lastActivityAt }
          : {}),
        ...(options.resumeConfig ? { resumeConfig: options.resumeConfig } : {}),
        ...(options.expectedVersion !== undefined
          ? { expectedVersion: options.expectedVersion }
          : {}),
        ...(options.turnTrace ? { turnTrace: options.turnTrace } : {}),
        ...(options.hostConfig ? { hostConfig: options.hostConfig } : {}),
      }),
    });

    if (!response.ok) {
      const responsePreview = await readResponsePreview(response);
      const isVersionConflict =
        response.status === 409 &&
        (response.headers.get("content-type")?.includes("application/json")
          ? false
          : responsePreview.includes("VERSION_CONFLICT"));
      let failureKind: "version_conflict" | "http_error" = "http_error";

      if (response.status === 409) {
        let jsonCode: string | undefined;
        try {
          const cloned = response.clone();
          const json = (await cloned.json()) as { code?: string };
          jsonCode = json?.code;
        } catch {
          // ignored — use text fallback
        }
        if (
          jsonCode === "VERSION_CONFLICT" ||
          isVersionConflict ||
          responsePreview.includes("VERSION_CONFLICT")
        ) {
          failureKind = "version_conflict";
        }
      }

      if (c) {
        const reqLogger = getRequestLogger(c, "utils.chat-ingestion");
        reqLogger.event("chat.session.persist.failed", {
          failureKind,
          statusCode: response.status,
          sourceType: options.sourceType,
        });
      } else {
        const logMessage =
          failureKind === "version_conflict"
            ? "[chat-session-persistence] Chat session version conflict"
            : `[chat-session-persistence] Failed to persist chat session (${response.status}): ${responsePreview}`;
        logger.warn(logMessage, { status: response.status, responsePreview });
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      if (c) {
        const reqLogger = getRequestLogger(c, "utils.chat-ingestion");
        reqLogger.event("chat.session.persist.failed", {
          failureKind: "timeout",
          sourceType: options.sourceType,
        });
      } else {
        logger.warn(
          "[chat-session-persistence] Timed out persisting chat session",
          { timeoutMs },
        );
      }
      return;
    }

    if (c) {
      const reqLogger = getRequestLogger(c, "utils.chat-ingestion");
      reqLogger.event(
        "chat.session.persist.failed",
        { failureKind: "exception", sourceType: options.sourceType },
        { error: error instanceof Error ? error : undefined },
      );
    } else {
      logger.warn("[chat-session-persistence] Error persisting chat session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
