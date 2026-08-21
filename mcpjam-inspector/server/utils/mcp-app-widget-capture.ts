import type { ModelMessage } from "ai";
import { resolveToolUiResourceUri } from "@mcpjam/sdk/widget-runtime";
import { isMcpAppTool, type MCPClientManager } from "@mcpjam/sdk";
import type { ConvexHttpClient } from "convex/browser";
import type { EvalTraceWidgetSnapshot } from "@/shared/eval-trace";
import { logger } from "./logger";
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

async function uploadWidgetHtmlBlob(
  convexClient: ConvexHttpClient,
  html: string,
): Promise<string | undefined> {
  const uploadUrl = await convexClient.mutation(
    "chatSessions:generateSnapshotUploadUrl" as any,
    {},
  );

  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    return undefined;
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: new Blob([html], { type: "text/html" }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload widget HTML (${response.status})`);
  }

  const body = (await response.json().catch(() => null)) as
    | { storageId?: string }
    | null;
  return typeof body?.storageId === "string" ? body.storageId : undefined;
}

/**
 * PR 6b sibling to `uploadWidgetHtmlBlob`. Same content-agnostic upload mutation
 * (`chatSessions:generateSnapshotUploadUrl` → `ctx.storage.generateUploadUrl()`);
 * only the Blob mime type changes. The caller hands base64 from the harness —
 * decode → Blob → POST → return the storageId. Exported (unlike its HTML
 * sibling) because `finalize-iteration.ts` serializes browser artifacts.
 */
export async function uploadScreenshotBlob(
  convexClient: ConvexHttpClient,
  base64: string,
): Promise<string | undefined> {
  const uploadUrl = await convexClient.mutation(
    "chatSessions:generateSnapshotUploadUrl" as any,
    {},
  );

  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    return undefined;
  }

  const mediaType = detectScreenshotMediaType(base64);
  const bytes = Buffer.from(base64, "base64");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": mediaType },
    body: new Blob([bytes], { type: mediaType }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload screenshot (${response.status})`);
  }

  const body = (await response.json().catch(() => null)) as
    | { storageId?: string }
    | null;
  return typeof body?.storageId === "string" ? body.storageId : undefined;
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
 * Wall-clock bound on the whole upload (URL mint + POST). Video upload happens
 * on a TERMINAL path, after the run has already produced its result, so a
 * stalled upload must never hold the caller open — for a session run it would
 * pin the browser and the MCP manager alive behind it.
 */
export const VIDEO_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Upload one run's Playwright replay `.webm` to Convex storage and return its
 * storageId. Same path as {@link uploadScreenshotBlob} (generate URL → POST
 * bytes → storageId); only the mime type differs. One video per run, so this
 * runs at most once per finalize.
 *
 * Bounded on both axes — size ({@link MAX_REPLAY_VIDEO_BYTES}, matching the
 * backend's write-boundary check) and time ({@link VIDEO_UPLOAD_TIMEOUT_MS}).
 * Throws on transport failure, oversize, or timeout; callers wrap it
 * best-effort so a missing replay never fails the run it came from.
 */
export async function uploadVideoBlob(
  convexClient: ConvexHttpClient,
  bytes: Buffer,
): Promise<string | undefined> {
  if (bytes.length > MAX_REPLAY_VIDEO_BYTES) {
    throw new Error(
      `Replay video is too large to upload (${bytes.length} bytes; max ${MAX_REPLAY_VIDEO_BYTES})`,
    );
  }

  const timeout = AbortSignal.timeout(VIDEO_UPLOAD_TIMEOUT_MS);
  const uploadUrl = await Promise.race([
    convexClient.mutation("chatSessions:generateSnapshotUploadUrl" as any, {}),
    abortRejection(timeout, "replay video upload url"),
  ]);

  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    return undefined;
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "video/webm" },
    // `new Uint8Array(bytes)` so a Node `Buffer` is a valid `BlobPart`
    // regardless of its backing-buffer type.
    body: new Blob([new Uint8Array(bytes)], { type: "video/webm" }),
    signal: timeout,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload replay video (${response.status})`);
  }

  // A timeout mid-body rejects `response.json()`. Swallowing that into
  // `undefined` would report a TIMED-OUT upload as an ordinary absent video,
  // which is the one thing a terminal caller can't distinguish. Surface it.
  let body: { storageId?: string } | null = null;
  try {
    body = (await response.json()) as { storageId?: string } | null;
  } catch (err) {
    if (timeout.aborted) {
      throw new Error("Timed out: replay video upload response");
    }
    // Anything else: a malformed body is genuinely "no storage id".
    void err;
  }
  return typeof body?.storageId === "string" ? body.storageId : undefined;
}

/**
 * A promise that never resolves and rejects when `signal` aborts. Used to bound
 * a call that takes no signal of its own (the Convex client's `mutation`).
 */
function abortRejection(signal: AbortSignal, label: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`Timed out: ${label}`));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error(`Timed out: ${label}`)),
      { once: true },
    );
  });
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
  convexClient: ConvexHttpClient;
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
          const widgetHtmlBlobId = await uploadWidgetHtmlBlob(
            params.convexClient,
            widgetHtml,
          );
          if (widgetHtmlBlobId) {
            snapshot.widgetHtmlBlobId = widgetHtmlBlobId;
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
