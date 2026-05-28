import { Hono } from "hono";
import { logger } from "../../utils/logger.js";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { getClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";

const OPENROUTER_STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const DEFAULT_STT_MODEL = "openai/whisper-1";
const STT_TIMEOUT_MS = 55_000;
const GUEST_IP_HASH_HEADER = "x-mcpjam-guest-ip-hash";
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
  apiKey?: unknown;
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

function validateRequest(body: TranscriptionRequestBody):
  | {
      ok: true;
      value: {
        apiKey?: string;
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
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
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
      apiKey,
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
      ...(audioDurationSeconds !== undefined
        ? { audioDurationSeconds }
        : {}),
    },
  };
}

function resolveLocalOpenRouterApiKey(apiKey?: string): string {
  if (apiKey) return apiKey;
  throw new Error("OpenRouter API key is required");
}

function getMcpjamTranscriptionUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  return `${convexHttpUrl.replace(/\/$/, "")}/audio/transcriptions`;
}

const audioTranscriptions = new Hono();

function createOpenRouterSignal(inboundSignal?: AbortSignal): {
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

  const {
    apiKey,
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

  let openRouterSignal: ReturnType<typeof createOpenRouterSignal> | undefined;
  try {
    openRouterSignal = createOpenRouterSignal(c.req.raw.signal);
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
      ...(audioDurationSeconds !== undefined
        ? { audioDurationSeconds }
        : {}),
    };
    let authHeader = c.req.header("authorization");
    if (projectId && !authHeader) {
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
    const clientIp = projectId ? getClientIp(c) : null;
    const guestIpHash = clientIp ? await hashGuestSpendIp(clientIp) : null;
    const upstreamResponse = await fetch(
      projectId ? getMcpjamTranscriptionUrl() : OPENROUTER_STT_URL,
      {
        method: "POST",
        signal: openRouterSignal.signal,
        headers: projectId
          ? {
              "Content-Type": "application/json",
              ...(authHeader ? { Authorization: authHeader } : {}),
              ...(originHeader ? { Origin: originHeader } : {}),
              ...(guestIpHash ? { [GUEST_IP_HASH_HEADER]: guestIpHash } : {}),
            }
          : {
              Authorization: `Bearer ${resolveLocalOpenRouterApiKey(apiKey)}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://www.mcpjam.com/",
              "X-Title": "MCPJam",
            },
        body: JSON.stringify(transcriptionPayload),
      }
    );

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
      const message = readErrorMessage(
        payload,
        `OpenRouter transcription failed with status ${upstreamResponse.status}`
      );
      return c.json(
        {
          error: message,
          status: upstreamResponse.status,
        },
        502
      );
    }

    if (!payload || typeof payload !== "object") {
      return c.json({ error: "OpenRouter returned an invalid response" }, 502);
    }

    return c.json({
      ...(payload as Record<string, unknown>),
      ...(generationId ? { generationId } : {}),
    });
  } catch (error) {
    if (openRouterSignal?.timedOut()) {
      return c.json(
        {
          error: "OpenRouter transcription timed out. Try a shorter recording.",
        },
        504
      );
    }
    logger.error("[audio-transcriptions] OpenRouter STT request failed", error);
    const message =
      error instanceof Error
        ? error.message
        : "OpenRouter transcription request failed";
    const status =
      message === "OpenRouter API key is required" ||
      message.startsWith("OpenRouter is not configured")
        ? 400
        : 502;
    return c.json({ error: message }, status);
  } finally {
    openRouterSignal?.cleanup();
  }
});

export default audioTranscriptions;
