import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ErrorCode } from "../web/errors.js";
import { logger } from "../../utils/logger.js";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { getClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";

const DEFAULT_STT_MODEL = "openai/whisper-1";
const STT_TIMEOUT_MS = 55_000;
const GUEST_IP_HASH_HEADER = "x-mcpjam-guest-ip-hash";
const MCPJAM_VOICE_BUDGET_CODE = "user_rate_limit";
const MCPJAM_VOICE_BUDGET_MESSAGE = "You've used today's voice budget.";
const MCPJAM_VOICE_IN_PROGRESS_CODE = "voice_transcription_in_progress";
const MCPJAM_VOICE_IN_PROGRESS_MESSAGE =
  "Another voice message is still processing. Try again in a moment.";
const AUDIO_UPLOAD_RATE_LIMIT = 12;
const AUDIO_UPLOAD_WINDOW_MS = 60_000;
const SUPPORTED_AUDIO_FORMATS = new Set([
  "wav",
  "mp3",
  "flac",
  "m4a",
  "ogg",
  "webm",
  "aac",
]);

interface TranscriptionRequestBody {
  model?: unknown;
  projectId?: unknown;
  selectedServerIds?: unknown;
  chatboxId?: unknown;
  accessVersion?: unknown;
  input_audio?: {
    data?: unknown;
    format?: unknown;
  };
  language?: unknown;
  temperature?: unknown;
  provider?: unknown;
  audioDurationSeconds?: unknown;
}

const audioUploadWindows = new Map<
  string,
  { count: number; windowStart: number }
>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of audioUploadWindows) {
    if (now - entry.windowStart > AUDIO_UPLOAD_WINDOW_MS * 2) {
      audioUploadWindows.delete(key);
    }
  }
}, 5 * 60_000).unref();

function getAudioUploadRateLimitKey(c: Context): string {
  const clientIp = getClientIp(c);
  if (clientIp) return `ip:${clientIp}`;

  const sessionAuth = c.req.header("x-mcp-session-auth")?.trim();
  if (sessionAuth) return `session:${sessionAuth.slice(0, 48)}`;

  const auth = c.req.header("authorization")?.trim();
  if (auth) return `auth:${auth.slice(0, 48)}`;

  return "unknown";
}

function checkAudioUploadRateLimit(c: Context): Response | null {
  const key = getAudioUploadRateLimitKey(c);
  const now = Date.now();
  const entry = audioUploadWindows.get(key);

  if (!entry || now - entry.windowStart >= AUDIO_UPLOAD_WINDOW_MS) {
    audioUploadWindows.set(key, { count: 1, windowStart: now });
    return null;
  }

  if (entry.count >= AUDIO_UPLOAD_RATE_LIMIT) {
    return c.json(
      {
        code: ErrorCode.RATE_LIMITED,
        message:
          "Voice upload rate limit exceeded. Try again later or sign in for higher limits.",
      },
      429
    );
  }

  entry.count++;
  return null;
}

export function resetAudioUploadRateLimitForTests(): void {
  audioUploadWindows.clear();
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;

  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === "string") return error.message;
  }
  if (typeof record.message === "string") return record.message;
  return fallback;
}

function readUpstreamError(
  payload: unknown,
  fallback: string
): Record<string, unknown> {
  const message = readErrorMessage(payload, fallback);
  if (!payload || typeof payload !== "object") {
    return { error: message };
  }

  const record = payload as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  const isVoiceBudgetError = code === MCPJAM_VOICE_BUDGET_CODE;
  const isVoiceInProgressError = code === MCPJAM_VOICE_IN_PROGRESS_CODE;

  return {
    error: isVoiceBudgetError
      ? MCPJAM_VOICE_BUDGET_MESSAGE
      : isVoiceInProgressError
      ? MCPJAM_VOICE_IN_PROGRESS_MESSAGE
      : message,
    ...(code ? { code } : {}),
    ...(typeof record.isRetryable === "boolean"
      ? { isRetryable: record.isRetryable }
      : {}),
    ...(typeof record.retryAfter === "number"
      ? { retryAfter: record.retryAfter }
      : {}),
    ...(typeof record.details === "string" ? { details: record.details } : {}),
  };
}

function validateRequest(body: TranscriptionRequestBody):
  | {
      ok: true;
      value: {
        model: string;
        projectId?: string;
        selectedServerIds?: string[];
        chatboxId?: string;
        accessVersion?: number;
        inputAudio: { data: string; format: string };
        language?: string;
        temperature?: number;
        provider?: unknown;
        audioDurationSeconds?: number;
      };
    }
  | { ok: false; error: string } {
  const projectId =
    typeof body.projectId === "string" && body.projectId.trim().length > 0
      ? body.projectId.trim()
      : undefined;
  const selectedServerIds = Array.isArray(body.selectedServerIds)
    ? Array.from(
        new Set(
          body.selectedServerIds
            .filter(
              (serverId): serverId is string => typeof serverId === "string"
            )
            .map((serverId) => serverId.trim())
            .filter((serverId) => serverId.length > 0)
        )
      )
    : undefined;
  const chatboxId =
    typeof body.chatboxId === "string" && body.chatboxId.trim().length > 0
      ? body.chatboxId.trim()
      : undefined;
  const accessVersion =
    typeof body.accessVersion === "number" &&
    Number.isInteger(body.accessVersion) &&
    body.accessVersion >= 0
      ? body.accessVersion
      : undefined;

  const model =
    typeof body.model === "string" && body.model.trim().length > 0
      ? body.model.trim()
      : DEFAULT_STT_MODEL;

  const data =
    typeof body.input_audio?.data === "string"
      ? body.input_audio.data.trim()
      : "";
  if (!data) {
    return { ok: false, error: "input_audio.data is required" };
  }
  if (data.startsWith("data:")) {
    return {
      ok: false,
      error: "input_audio.data must be raw base64, not a data URI",
    };
  }

  const format =
    typeof body.input_audio?.format === "string"
      ? body.input_audio.format.trim().toLowerCase()
      : "";
  if (!SUPPORTED_AUDIO_FORMATS.has(format)) {
    return {
      ok: false,
      error:
        "input_audio.format must be one of wav, mp3, flac, m4a, ogg, webm, or aac",
    };
  }

  const language =
    typeof body.language === "string" && body.language.trim().length > 0
      ? body.language.trim()
      : undefined;
  const temperature =
    typeof body.temperature === "number" &&
    Number.isFinite(body.temperature) &&
    body.temperature >= 0 &&
    body.temperature <= 1
      ? body.temperature
      : undefined;
  const audioDurationSeconds =
    typeof body.audioDurationSeconds === "number" &&
    Number.isFinite(body.audioDurationSeconds) &&
    body.audioDurationSeconds > 0
      ? body.audioDurationSeconds
      : undefined;

  return {
    ok: true,
    value: {
      model,
      ...(projectId ? { projectId } : {}),
      ...(selectedServerIds && selectedServerIds.length > 0
        ? { selectedServerIds }
        : {}),
      ...(chatboxId ? { chatboxId } : {}),
      ...(accessVersion !== undefined ? { accessVersion } : {}),
      inputAudio: { data, format },
      ...(language ? { language } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(audioDurationSeconds !== undefined ? { audioDurationSeconds } : {}),
    },
  };
}

function getMcpjamTranscriptionUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  return `${convexHttpUrl.replace(/\/$/, "")}/audio/transcriptions`;
}

const audioTranscriptions = new Hono();

function createTranscriptionSignal(inboundSignal?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, STT_TIMEOUT_MS);
  const abortFromInbound = () => controller.abort();

  if (inboundSignal?.aborted) {
    controller.abort();
  } else {
    inboundSignal?.addEventListener("abort", abortFromInbound, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout);
      inboundSignal?.removeEventListener("abort", abortFromInbound);
    },
  };
}

audioTranscriptions.post("/transcriptions", async (c) => {
  const rateLimitResponse = checkAudioUploadRateLimit(c);
  if (rateLimitResponse) return rateLimitResponse;

  let body: TranscriptionRequestBody;
  try {
    body = (await c.req.json()) as TranscriptionRequestBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const validation = validateRequest(body);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }

  // Voice is always MCPJam-credit-backed. Keep the MCP-mounted copy from
  // accepting transcription calls so local BYOK cannot bypass credit billing.
  if (!c.req.path.startsWith("/api/web/")) {
    return c.json(
      {
        error:
          "Voice transcription uses MCPJam credits and is only available on the /api/web audio endpoint.",
      },
      403
    );
  }

  const {
    model,
    projectId,
    selectedServerIds,
    chatboxId,
    accessVersion,
    inputAudio,
    language,
    temperature,
    provider,
    audioDurationSeconds,
  } = validation.value;

  let transcriptionSignal:
    | ReturnType<typeof createTranscriptionSignal>
    | undefined;
  try {
    transcriptionSignal = createTranscriptionSignal(c.req.raw.signal);
    const transcriptionPayload = {
      model,
      input_audio: {
        data: inputAudio.data,
        format: inputAudio.format,
      },
      ...(language ? { language } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(projectId ? { projectId } : {}),
      ...(selectedServerIds && selectedServerIds.length > 0
        ? { selectedServerIds }
        : {}),
      ...(chatboxId ? { chatboxId } : {}),
      ...(accessVersion !== undefined ? { accessVersion } : {}),
      ...(audioDurationSeconds !== undefined ? { audioDurationSeconds } : {}),
    };
    let authHeader = c.req.header("authorization");
    if (!authHeader) {
      try {
        authHeader = (await getProductionGuestAuthHeader()) ?? undefined;
      } catch {
        authHeader = undefined;
      }
      if (!authHeader) {
        return c.json(
          {
            error:
              "Unable to authenticate with MCPJam servers. Please try again or sign in.",
          },
          503
        );
      }
    }
    const originHeader = c.req.header("origin");
    const clientIp = getClientIp(c);
    const guestIpHash = clientIp ? await hashGuestSpendIp(clientIp) : null;
    const upstreamResponse = await fetch(getMcpjamTranscriptionUrl(), {
      method: "POST",
      signal: transcriptionSignal.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        ...(originHeader ? { Origin: originHeader } : {}),
        ...(guestIpHash ? { [GUEST_IP_HASH_HEADER]: guestIpHash } : {}),
      },
      body: JSON.stringify(transcriptionPayload),
    });

    const generationId = upstreamResponse.headers.get("X-Generation-Id");
    const responseText = await upstreamResponse.text();
    let payload: unknown = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    if (!upstreamResponse.ok) {
      const errorBody = readUpstreamError(
        payload,
        `Voice transcription failed with status ${upstreamResponse.status}`
      );
      return c.json(
        {
          ...errorBody,
          status: upstreamResponse.status,
        },
        upstreamResponse.status as ContentfulStatusCode
      );
    }

    if (!payload || typeof payload !== "object") {
      return c.json(
        { error: "MCPJam returned an invalid voice transcription response" },
        502
      );
    }

    return c.json({
      ...(payload as Record<string, unknown>),
      ...(generationId ? { generationId } : {}),
    });
  } catch (error) {
    if (transcriptionSignal?.timedOut()) {
      return c.json(
        {
          error: "Voice transcription timed out. Try a shorter recording.",
        },
        504
      );
    }
    logger.error(
      "[audio-transcriptions] Voice transcription request failed",
      error
    );
    const message =
      error instanceof Error
        ? error.message
        : "Voice transcription request failed";
    return c.json({ error: message }, 502);
  } finally {
    transcriptionSignal?.cleanup();
  }
});

export default audioTranscriptions;
