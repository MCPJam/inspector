import type { ModelMessage } from "ai";
import { resolveToolUiResourceUri } from "@mcpjam/sdk/widget-runtime";
import { isMcpAppTool, type MCPClientManager } from "@mcpjam/sdk";
import { uploadBlob } from "@/shared/blob-upload";
import type { EvalTraceWidgetSnapshot } from "@/shared/eval-trace";
import { WIDGET_HTML_STORAGE_CONTENT_TYPE } from "@/shared/widget-snapshot";
import { HOSTED_MODE } from "../config.js";
import {
  getConfiguredInspectorServiceToken,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../middleware/internal-service-auth.js";
import { logger } from "./logger";
import {
  snapshotScenarioScope,
  type SnapshotUploadTarget,
} from "./snapshot-upload-target.js";
import { isUsableStorageDestination } from "./storage-destination.js";
import { injectOpenAICompat } from "./widget-helpers.js";

const LOG_PREFIX = "[mcp-app-widget-capture]";

type ToolSnapshotSource = {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  serverId: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readRecordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : undefined;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function unwrapToolResultPayload(part: Record<string, unknown>): unknown {
  const output = part.output;
  if (
    isRecord(output) &&
    typeof output.type === "string" &&
    Object.hasOwn(output, "value")
  ) {
    return output.value;
  }

  if (output !== undefined) {
    return output;
  }

  return part.result;
}

function readServerIdFromToolOutput(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value._serverId === "string") {
    return value._serverId;
  }

  if (isRecord(value._meta) && typeof value._meta._serverId === "string") {
    return value._meta._serverId;
  }

  return undefined;
}

export function extractHtmlFromResourceContent(content: unknown): string {
  if (!isRecord(content)) {
    return "";
  }

  if (typeof content.text === "string") {
    return content.text;
  }

  if (typeof content.blob === "string") {
    return Buffer.from(content.blob, "base64").toString("utf-8");
  }

  return "";
}

function normalizeWidgetCsp(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const normalized: Record<string, unknown> = {};
  const connectDomains = Array.isArray(value.connectDomains)
    ? value.connectDomains.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  const resourceDomains = Array.isArray(value.resourceDomains)
    ? value.resourceDomains.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  const frameDomains = Array.isArray(value.frameDomains)
    ? value.frameDomains.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  const baseUriDomains = Array.isArray(value.baseUriDomains)
    ? value.baseUriDomains.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;

  if (connectDomains && connectDomains.length > 0) {
    normalized.connectDomains = connectDomains;
  }
  if (resourceDomains && resourceDomains.length > 0) {
    normalized.resourceDomains = resourceDomains;
  }
  if (frameDomains && frameDomains.length > 0) {
    normalized.frameDomains = frameDomains;
  }
  if (baseUriDomains && baseUriDomains.length > 0) {
    normalized.baseUriDomains = baseUriDomains;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function normalizeWidgetPermissions(
  value: unknown,
): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function collectToolSnapshotSources(
  messages: ModelMessage[],
): ToolSnapshotSource[] {
  const toolInputsByCallId = new Map<
    string,
    { toolName: string; toolInput: Record<string, unknown> }
  >();

  for (const message of messages) {
    if (message?.role !== "assistant") {
      continue;
    }

    const content = Array.isArray((message as any).content)
      ? ((message as any).content as unknown[])
      : [];
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool-call") {
        continue;
      }
      const toolCallId = readRecordString(part, "toolCallId");
      const toolName =
        readRecordString(part, "toolName") ?? readRecordString(part, "name");
      if (!toolCallId || !toolName) {
        continue;
      }
      toolInputsByCallId.set(toolCallId, {
        toolName,
        toolInput: normalizeToolInput(
          part.input ?? part.parameters ?? part.args ?? {},
        ),
      });
    }

    const toolCalls = Array.isArray((message as any).toolCalls)
      ? ((message as any).toolCalls as unknown[])
      : [];
    for (const call of toolCalls) {
      if (!isRecord(call)) {
        continue;
      }
      const toolCallId =
        readRecordString(call, "toolCallId") ?? readRecordString(call, "id");
      const toolName =
        readRecordString(call, "toolName") ?? readRecordString(call, "name");
      if (!toolCallId || !toolName) {
        continue;
      }
      toolInputsByCallId.set(toolCallId, {
        toolName,
        toolInput: normalizeToolInput(
          call.args ?? call.input ?? call.parameters ?? {},
        ),
      });
    }
  }

  const sources: ToolSnapshotSource[] = [];
  const seenToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message?.role !== "tool") {
      continue;
    }
    const content = Array.isArray((message as any).content)
      ? ((message as any).content as unknown[])
      : [];
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool-result") {
        continue;
      }

      const toolCallId = readRecordString(part, "toolCallId");
      if (!toolCallId || seenToolCallIds.has(toolCallId)) {
        continue;
      }

      const toolOutput = unwrapToolResultPayload(part);
      const serverId =
        readRecordString(part, "serverId") ??
        readServerIdFromToolOutput(toolOutput);
      const sourceFromCall = toolInputsByCallId.get(toolCallId);
      const toolName =
        readRecordString(part, "toolName") ??
        readRecordString(part, "name") ??
        sourceFromCall?.toolName;

      if (!serverId || !toolName) {
        continue;
      }

      seenToolCallIds.add(toolCallId);
      sources.push({
        toolCallId,
        toolName,
        toolInput: sourceFromCall?.toolInput ?? {},
        toolOutput,
        serverId,
      });
    }
  }

  return sources;
}

/**
 * Send captured bytes to the backend's upload route (`@/shared/blob-upload`,
 * MJ-006) as `target`, scoped to its chat (and, for a hosted scenario, its
 * grant), and return the storage id.
 */
async function uploadSnapshotBytes(
  target: SnapshotUploadTarget,
  body: Blob,
  contentType: string,
  signal?: AbortSignal,
): Promise<string> {
  const siteUrl = process.env.CONVEX_HTTP_URL;
  if (!siteUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  return await uploadBlob({
    siteUrl,
    bearerToken: target.convexAuthToken,
    scope: {
      purpose: "widget-snapshot",
      chatSessionId: target.chatSessionId,
      ...snapshotScenarioScope(target),
    },
    body,
    contentType,
    ...(signal ? { signal } : {}),
  });
}

async function uploadWidgetHtmlBlob(
  target: SnapshotUploadTarget,
  html: string,
): Promise<string> {
  // Text, not `text/html` — see WIDGET_HTML_STORAGE_CONTENT_TYPE.
  return await uploadSnapshotBytes(
    target,
    new Blob([html], { type: WIDGET_HTML_STORAGE_CONTENT_TYPE }),
    WIDGET_HTML_STORAGE_CONTENT_TYPE,
  );
}

/**
 * PR 6b sibling to `uploadWidgetHtmlBlob`. Same upload route and scope; only
 * the Blob mime type changes. The caller hands base64 from the harness —
 * decode → Blob → POST → return the storageId. Exported (unlike its HTML
 * sibling) because `finalize-iteration.ts` serializes browser artifacts.
 */
export async function uploadScreenshotBlob(
  target: SnapshotUploadTarget,
  base64: string,
): Promise<string | undefined> {
  const mediaType = detectScreenshotMediaType(base64);
  const bytes = Buffer.from(base64, "base64");
  return await uploadSnapshotBytes(
    target,
    new Blob([new Uint8Array(bytes)], { type: mediaType }),
    mediaType,
  );
}

// Mirrors `detectImageMediaType` in computer-use-tool.ts but kept local so
// widget-capture stays the single owner of screenshot upload concerns. The
// harness emits PNG by default and JPEG only after re-encoding to fit the byte
// budget; JPEG base64 begins with "/9j/".
function detectScreenshotMediaType(base64: string): "image/jpeg" | "image/png" {
  return base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
}

/**
 * Ceiling on a replay `.webm` this process will even attempt to upload. The
 * backend enforces the same 64 MiB ceiling when the blob is attached to a
 * session (it is the first place the byte count is knowable there), so checking
 * here means we don't push tens of MB across the wire just to have it refused.
 * Keep the two in step if either moves.
 */
export const MAX_REPLAY_VIDEO_BYTES = 64 * 1024 * 1024;

/**
 * Wall-clock bound on the whole upload (destination request + POST). Video
 * upload happens on a TERMINAL path, after the run has already produced its
 * result, so a stalled upload must never hold the caller open — for a session
 * run it would pin the browser and the MCP manager alive behind it.
 */
export const VIDEO_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * The container a replay is in unless the caller says otherwise.
 *
 * `webm` because that is what the local widget harness's Playwright recording
 * has always been, and every caller that predates a second recorder is one of
 * those. A hosted daemon's recording is `video/mp4` and MUST say so: Convex
 * serves back exactly the content type the bytes were posted with, so an MP4
 * announced as webm is a file the browser refuses to play — and the only
 * symptom is an empty player on the trace page.
 */
export const DEFAULT_REPLAY_VIDEO_MIME = "video/webm";

/** The backend's replay destination issuer; service credential only. */
const REPLAY_VIDEO_DESTINATION_PATH =
  "/internal/v1/chat-sessions/replay-video/upload-url";

/**
 * Where to store one replay, asked for on the launching user's behalf with the
 * inspector service credential. The backend checks the user's bearer and chat
 * the way it does for snapshots; this process uploads the bytes and keeps
 * only the storage id (MJ-006).
 */
async function requestReplayVideoDestination(
  target: SnapshotUploadTarget,
  serviceToken: string,
  signal: AbortSignal,
): Promise<string> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  const response = await fetch(`${convexUrl}${REPLAY_VIDEO_DESTINATION_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.convexAuthToken}`,
      "Content-Type": "application/json",
      [INSPECTOR_SERVICE_TOKEN_HEADER]: serviceToken,
    },
    body: JSON.stringify({
      chatSessionId: target.chatSessionId,
      ...snapshotScenarioScope(target),
    }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as {
    uploadUrl?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      `Replay video upload was refused (${response.status})${
        typeof body?.error === "string" ? `: ${body.error}` : ""
      }`,
    );
  }
  if (!isUsableStorageDestination(body?.uploadUrl)) {
    throw new Error("Replay video upload got no usable destination");
  }
  return body.uploadUrl;
}

/**
 * Store the replay's bytes. With the inspector service credential they go to
 * the destination the backend names for them (replays can be larger than the
 * upload route takes). A local install holds no service credential and sends
 * them through the upload route instead, within that route's cap; a hosted
 * deployment without the credential is misconfigured and refuses.
 */
async function storeReplayVideo(
  target: SnapshotUploadTarget,
  body: Blob,
  contentType: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const serviceToken = getConfiguredInspectorServiceToken();
  if (!serviceToken) {
    if (HOSTED_MODE) {
      throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
    }
    return await uploadSnapshotBytes(target, body, contentType, signal);
  }

  const destination = await requestReplayVideoDestination(
    target,
    serviceToken,
    signal,
  );
  const response = await fetch(destination, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to upload replay video (${response.status})`);
  }
  let stored: { storageId?: unknown } | null = null;
  try {
    stored = (await response.json()) as { storageId?: unknown } | null;
  } catch (err) {
    // A deadline hit mid-answer is a timeout, and the caller reports it as
    // one; a malformed answer is genuinely "no storage id".
    if (signal.aborted) throw err;
  }
  return typeof stored?.storageId === "string" && stored.storageId
    ? stored.storageId
    : undefined;
}

/**
 * Upload one run's replay video to Convex storage and return its storageId.
 * Same identity and chat scope as {@link uploadScreenshotBlob}; see
 * {@link storeReplayVideo} for where the bytes go. One video per run, so this
 * runs at most once per finalize.
 *
 * Bounded on both axes — size ({@link MAX_REPLAY_VIDEO_BYTES}, matching the
 * backend's write-boundary check) and time ({@link VIDEO_UPLOAD_TIMEOUT_MS}).
 * Throws on transport failure, oversize, refusal or timeout; callers wrap it
 * best-effort so a missing replay never fails the run it came from.
 */
export async function uploadVideoBlob(
  target: SnapshotUploadTarget,
  bytes: Buffer,
  options: { contentType?: string } = {},
): Promise<string | undefined> {
  const contentType = options.contentType || DEFAULT_REPLAY_VIDEO_MIME;
  if (bytes.length > MAX_REPLAY_VIDEO_BYTES) {
    throw new Error(
      `Replay video is too large to upload (${bytes.length} bytes; max ${MAX_REPLAY_VIDEO_BYTES})`,
    );
  }

  const timeout = AbortSignal.timeout(VIDEO_UPLOAD_TIMEOUT_MS);
  try {
    return await storeReplayVideo(
      target,
      // `new Uint8Array(bytes)` so a Node `Buffer` is a valid `BlobPart`
      // regardless of its backing-buffer type.
      new Blob([new Uint8Array(bytes)], { type: contentType }),
      contentType,
      timeout,
    );
  } catch (err) {
    // A timeout (on the request or mid-answer) is reported as one, never as
    // an ordinary refusal: a terminal caller can't tell the two apart
    // otherwise.
    if (timeout.aborted) {
      throw new Error("Timed out: replay video upload");
    }
    throw err;
  }
}

/**
 * Walk an AI SDK message transcript, find every tool result whose tool
 * metadata identifies an MCP App, fetch the widget HTML via
 * `MCPClientManager.readResource()`, upload it to Convex, and return one
 * `EvalTraceWidgetSnapshot` per captured tool call.
 *
 * Despite living next to evals historically (and still typed with
 * `EvalTraceWidgetSnapshot` for now), the operation is generic: it doesn't
 * know about iterations, runs, or who consumes the snapshots downstream.
 * Both the evals runner and the synthetic-session runner call this; each
 * is responsible for persisting the returned snapshots in its own shape.
 *
 * Snapshot capture is best-effort: per-tool failures log a warning and are
 * skipped; the function never throws.
 */
export async function captureMcpAppWidgetSnapshots(params: {
  messages: ModelMessage[];
  mcpClientManager: MCPClientManager;
  /**
   * Who the widget HTML is uploaded as, and for which chat. `undefined` when
   * there is nothing to attach the snapshots to (an eval iteration that never
   * got an id): the snapshots are still built, just without their HTML blob.
   */
  uploadTarget: SnapshotUploadTarget | undefined;
  /**
   * Whether to inject the OpenAI Apps SDK `window.openai` shim into the
   * captured widget HTML. Resolved upstream from the host config
   * (preset + override). Default `false` — SEP-1865 honest behavior,
   * matching the rest of the widget injection paths.
   */
  injectOpenAiCompat?: boolean;
  /**
   * Tool-call ids already captured on a previous invocation over the same
   * (growing) transcript. Per-turn callers pass their session-scoped set so
   * an early widget isn't re-fetched and re-uploaded on every later turn —
   * without it the walk is quadratic in turns (readResource + blob upload
   * per prior widget, per turn).
   */
  skipToolCallIds?: ReadonlySet<string>;
}): Promise<EvalTraceWidgetSnapshot[] | undefined> {
  const skip = params.skipToolCallIds;
  const sources = collectToolSnapshotSources(params.messages).filter(
    (source) => !skip?.has(source.toolCallId),
  );
  if (sources.length === 0) {
    return undefined;
  }

  const snapshots = await Promise.all(
    sources.map(async (source) => {
      try {
        const toolMetadata =
          params.mcpClientManager.getAllToolsMetadata(source.serverId)?.[
            source.toolName
          ];
        if (!isRecord(toolMetadata) || !isMcpAppTool(toolMetadata)) {
          return null;
        }

        const resourceUri = resolveToolUiResourceUri(toolMetadata);
        if (!resourceUri) {
          return null;
        }

        const snapshot: EvalTraceWidgetSnapshot = {
          toolCallId: source.toolCallId,
          toolName: source.toolName,
          protocol: "mcp-apps",
          serverId: source.serverId,
          resourceUri,
          toolMetadata,
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: true,
          prefersBorder: true,
        };

        try {
          const resourceResult = await params.mcpClientManager.readResource(
            source.serverId,
            { uri: resourceUri },
          );
          const contents = Array.isArray((resourceResult as any)?.contents)
            ? ((resourceResult as any).contents as unknown[])
            : [];
          const content = contents[0];
          if (!isRecord(content)) {
            return snapshot;
          }

          const uiMeta =
            isRecord(content._meta) && isRecord(content._meta.ui)
              ? (content._meta.ui as Record<string, unknown>)
              : undefined;
          snapshot.widgetCsp = normalizeWidgetCsp(uiMeta?.csp);
          snapshot.widgetPermissions = normalizeWidgetPermissions(
            uiMeta?.permissions,
          );
          snapshot.prefersBorder =
            typeof uiMeta?.prefersBorder === "boolean"
              ? uiMeta.prefersBorder
              : true;

          const html = extractHtmlFromResourceContent(content);
          if (!html) {
            return snapshot;
          }

          const shouldInjectOpenAiCompat = params.injectOpenAiCompat === true;
          const widgetHtml = shouldInjectOpenAiCompat
            ? injectOpenAICompat(html, {
                toolId: source.toolCallId,
                toolName: source.toolName,
                toolInput: source.toolInput,
                toolOutput: source.toolOutput,
              })
            : html;
          if (params.uploadTarget) {
            snapshot.widgetHtmlBlobId = await uploadWidgetHtmlBlob(
              params.uploadTarget,
              widgetHtml,
            );
          }
          // Stamp the flag onto the snapshot so the replay viewer can
          // distinguish "captured with shim" from "captured without"
          // without re-reading the bytes.
          snapshot.injectedOpenAiCompat = shouldInjectOpenAiCompat;
        } catch (error) {
          logger.warn(`${LOG_PREFIX} Failed to capture MCP App widget snapshot`, {
            toolCallId: source.toolCallId,
            toolName: source.toolName,
            serverId: source.serverId,
            resourceUri,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        return snapshot;
      } catch (error) {
        // Snapshot capture must stay best-effort: throwing here would fail
        // the caller's downstream persistence step. Surface and skip.
        logger.warn(
          `${LOG_PREFIX} Skipped widget snapshot due to unexpected error`,
          {
            toolCallId: source.toolCallId,
            toolName: source.toolName,
            serverId: source.serverId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }
    }),
  );

  const filtered = snapshots.filter(
    (snapshot): snapshot is EvalTraceWidgetSnapshot => snapshot !== null,
  );
  return filtered.length > 0 ? filtered : undefined;
}
