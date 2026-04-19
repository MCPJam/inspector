import { logger } from "./logger";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";

const DEFAULT_INGEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_PREVIEW_CHARS = 200;

/**
 * Headers worth forwarding from the browser request to the Convex ingestion
 * endpoint so that usage-insights enrichment (device, language, geo) works.
 */
const ENRICHMENT_HEADERS_TO_FORWARD = [
  "user-agent",
  "accept-language",
  // Geo headers injected by CDN/edge providers
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-vercel-ip-country-region",
  "x-vercel-ip-city",
  "x-geo-country",
  "x-geo-region",
  "x-geo-city",
  // Client IP headers for visitor hashing
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
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
  modelSource: "mcpjam" | "byok";
  authHeader?: string;
  workspaceId?: string;
  sourceType?: "serverShare" | "chatbox" | "direct";
  directVisibility?: "private" | "workspace";
  surface?: "preview" | "share_link";
  shareToken?: string;
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
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(options.sourceType ? { sourceType: options.sourceType } : {}),
        ...(options.directVisibility
          ? { directVisibility: options.directVisibility }
          : {}),
        ...(options.surface ? { surface: options.surface } : {}),
        ...(options.shareToken ? { shareToken: options.shareToken } : {}),
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
      }),
    });

    if (!response.ok) {
      const responsePreview = await readResponsePreview(response);
      const logMessage =
        response.status === 409 && responsePreview.includes("VERSION_CONFLICT")
          ? "[chat-session-persistence] Chat session version conflict"
          : "[chat-session-persistence] Failed to persist chat session";
      logger.warn(logMessage, {
        status: response.status,
        responsePreview,
      });
    }
  } catch (error) {
    if (isAbortError(error)) {
      logger.warn(
        "[chat-session-persistence] Timed out persisting chat session",
        {
          timeoutMs,
        },
      );
      return;
    }

    logger.warn("[chat-session-persistence] Error persisting chat session", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
