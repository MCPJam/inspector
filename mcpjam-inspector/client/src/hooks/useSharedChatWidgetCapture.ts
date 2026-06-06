import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import type { UIMessage } from "@ai-sdk/react";
import type { DisplayContext, WidgetCsp } from "./useViews";
import { detectUIType, getUIResourceUri } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  readToolResultMeta,
  readToolResultServerId,
} from "@/lib/tool-result-utils";
import {
  useWidgetDebugStore,
  type WidgetDebugInfo,
} from "@/stores/widget-debug-store";
import {
  sanitizeWidgetForBackend,
  type SharedChatWidgetSnapshotPayload,
} from "@/shared/widget-snapshot";

interface UseSharedChatWidgetCaptureOptions {
  enabled: boolean;
  readyToPersist?: boolean;
  chatSessionId: string;
  // Resolved chatbox identity (post-redeem). Snapshot mutations key on
  // these — never on the link token.
  hostedChatboxId?: string;
  hostedAccessVersion?: number;
  persistedSnapshotToolCallIds?: string[];
  messages: UIMessage[];
  // Called when the backend reports `chatbox_access_stale` — the owner
  // (typically ChatboxChatPage via use-chat-session) should re-run the
  // /web/chatbox/redeem fetch so a fresh `hostedAccessVersion` flows back
  // into this hook and the capture loop re-fires.
  onStaleHostedAccess?: () => void;
}

const MAX_PENDING_SESSION_RETRIES = 5;
const SNAPSHOT_CAPTURE_DELAY_MS = 500;
// Bounded backoff for re-asking the parent to redeem when the previous
// redeem appears to have failed (queue still non-empty, accessVersion
// hasn't advanced). 1s, 2s, 4s, 8s, 16s — capped at 30s.
const MAX_STALE_REFRESH_ATTEMPTS = 5;
const STALE_REFRESH_BACKOFF_CEILING_MS = 30_000;

interface ToolSnapshotSource {
  toolName: string;
  input: unknown;
  rawOutput: unknown;
  resourceUri?: string;
  serverId?: string;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return `${hash >>> 0}`;
}

function isToolLikePart(part: unknown): part is {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
} {
  if (!part || typeof part !== "object") {
    return false;
  }

  const type = (part as { type?: unknown }).type;
  return (
    type === "dynamic-tool" ||
    (typeof type === "string" && type.startsWith("tool-"))
  );
}

function getToolNameFromPart(part: {
  type: string;
  toolName?: string;
}): string {
  if (part.type === "dynamic-tool" && part.toolName) {
    return part.toolName;
  }
  return part.type.replace(/^tool-/, "") || "unknown";
}

function buildToolSourceMap(
  messages: UIMessage[],
): Map<string, ToolSnapshotSource> {
  const toolSources = new Map<string, ToolSnapshotSource>();

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolLikePart(part) || typeof part.toolCallId !== "string") {
        continue;
      }

      const rawOutput = part.output;
      const toolMeta = readToolResultMeta(rawOutput);
      toolSources.set(part.toolCallId, {
        toolName: getToolNameFromPart(part),
        input: part.input ?? null,
        rawOutput,
        resourceUri:
          getUIResourceUri(detectUIType(toolMeta, rawOutput), toolMeta) ??
          undefined,
        serverId: readToolResultServerId(rawOutput),
      });
    }
  }

  return toolSources;
}

function toDisplayContext(
  globals: WidgetDebugInfo["globals"],
): DisplayContext | undefined {
  if (!globals) {
    return undefined;
  }

  const deviceType = globals.userAgent?.device?.type;
  const capabilities =
    globals.userAgent?.capabilities ?? globals.deviceCapabilities;
  const safeAreaInsets = globals.safeAreaInsets ?? globals.safeArea?.insets;

  return {
    theme: globals.theme,
    displayMode: globals.displayMode,
    deviceType:
      deviceType === "mobile" ||
      deviceType === "tablet" ||
      deviceType === "desktop"
        ? deviceType
        : undefined,
    viewport:
      typeof globals.maxWidth === "number" &&
      typeof globals.maxHeight === "number"
        ? { width: globals.maxWidth, height: globals.maxHeight }
        : undefined,
    locale: globals.locale,
    timeZone: globals.timeZone,
    capabilities: capabilities
      ? {
          hover: capabilities.hover,
          touch: capabilities.touch,
        }
      : undefined,
    safeAreaInsets: safeAreaInsets
      ? {
          top: safeAreaInsets.top,
          right: safeAreaInsets.right,
          bottom: safeAreaInsets.bottom,
          left: safeAreaInsets.left,
        }
      : undefined,
  };
}

function toWidgetCsp(widget: WidgetDebugInfo): WidgetCsp | undefined {
  const csp = widget.csp;
  if (!csp) {
    return undefined;
  }

  return {
    connectDomains: csp.connectDomains,
    resourceDomains: csp.resourceDomains,
    frameDomains: csp.frameDomains,
    baseUriDomains: csp.baseUriDomains,
  };
}

function shouldRetryPendingSnapshot(result: unknown, error: unknown): boolean {
  if (result == null) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Session not found");
}

// Convex `ConvexError` payloads land on `err.data`. The backend throws
// `{ code: 'chatbox_access_stale', currentAccessVersion }` when the client's
// cached accessVersion no longer matches the chatbox doc — recovery is to
// re-redeem, not to back off and retry locally.
function isStaleHostedAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (
    (data as { code?: unknown }).code === "chatbox_access_stale"
  );
}

export function useSharedChatWidgetCapture({
  enabled,
  readyToPersist = true,
  chatSessionId,
  hostedChatboxId,
  hostedAccessVersion,
  persistedSnapshotToolCallIds = [],
  messages,
  onStaleHostedAccess,
}: UseSharedChatWidgetCaptureOptions): void {
  const widgets = useWidgetDebugStore((state) => state.widgets);
  const generateSnapshotUploadUrl = useMutation(
    "chatSessions:generateSnapshotUploadUrl" as any,
  );
  const createWidgetSnapshot = useMutation(
    "chatSessions:createWidgetSnapshot" as any,
  );

  const uploadedHashesRef = useRef(new Map<string, string>());
  const inFlightRef = useRef(new Set<string>());
  const pendingTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const cachedBlobsRef = useRef(
    new Map<
      string,
      {
        htmlHash: string;
        widgetHtmlBlobId: string;
        toolInputBlobId: string;
        toolOutputBlobId: string;
      }
    >(),
  );
  const retryCountRef = useRef(new Map<string, number>());
  const toolSourcesRef = useRef(buildToolSourceMap(messages));
  const widgetsRef = useRef(widgets);
  const sessionIdRef = useRef(chatSessionId);
  const chatboxIdRef = useRef(hostedChatboxId);
  const accessVersionRef = useRef(hostedAccessVersion);
  const persistedSnapshotToolCallIdsRef = useRef(
    new Set(persistedSnapshotToolCallIds),
  );
  const onStaleHostedAccessRef = useRef(onStaleHostedAccess);
  // ToolCallIds whose upload was abandoned mid-flight because the backend
  // reported `chatbox_access_stale`. Replayed once the next
  // `hostedAccessVersion` arrives — without this, the parent's re-redeem
  // silently changes a ref value and nothing re-fires the capture loop
  // until an unrelated widget/message change happens to retrigger the
  // debounced sweep.
  const pendingStaleRetryRef = useRef(new Set<string>());
  // Bounded backoff state for re-asking the parent to redeem. Tracks how
  // many times the timer has refired (without an accessVersion bump in
  // between) and the currently-scheduled timer. Reset to zero whenever
  // accessVersion actually advances or the chat identity changes.
  const staleRefreshAttemptsRef = useRef(0);
  const staleRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prevScopeRef = useRef({
    chatSessionId,
    hostedChatboxId,
  });
  // Identity generation. Bumped whenever `chatSessionId` or
  // `hostedChatboxId` changes. Each `uploadAttemptRef` invocation captures
  // its generation at start and bails before any state-mutating
  // continuation if the scope has moved — without this, an in-flight
  // upload for chat A can land its `createWidgetSnapshot` call in chat B
  // (refs are read lazily through the async function's awaits).
  const scopeGenerationRef = useRef(0);
  const uploadAttemptRef = useRef<(toolCallId: string) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    onStaleHostedAccessRef.current = onStaleHostedAccess;
  }, [onStaleHostedAccess]);

  // Re-fire the parent's refresh callback on a backoff while the queue is
  // non-empty and accessVersion hasn't advanced. The parent's redeem can
  // fail silently (network / 5xx / 4xx); without this, a single failed
  // redeem strands the queued snapshot until an unrelated stale event or
  // a page reload happens to retrigger the callback path.
  const schedulePendingStaleRefresh = () => {
    if (staleRefreshTimerRef.current) {
      clearTimeout(staleRefreshTimerRef.current);
      staleRefreshTimerRef.current = null;
    }
    if (pendingStaleRetryRef.current.size === 0) return;
    const attempts = staleRefreshAttemptsRef.current;
    if (attempts >= MAX_STALE_REFRESH_ATTEMPTS) {
      console.warn(
        "[useSharedChatWidgetCapture] Giving up on stale-access refresh after",
        attempts,
        "attempts; queued toolCallIds:",
        Array.from(pendingStaleRetryRef.current),
      );
      return;
    }
    const delayMs = Math.min(
      1000 * Math.pow(2, attempts),
      STALE_REFRESH_BACKOFF_CEILING_MS,
    );
    staleRefreshTimerRef.current = setTimeout(() => {
      staleRefreshTimerRef.current = null;
      if (pendingStaleRetryRef.current.size === 0) return;
      staleRefreshAttemptsRef.current += 1;
      onStaleHostedAccessRef.current?.();
      // Re-arm for the next backoff tick. If accessVersion bumps before
      // the next fire, the reset effect cancels this timer and resets
      // attempts to zero.
      schedulePendingStaleRefresh();
    }, delayMs);
  };
  const clearPendingStaleRefresh = () => {
    if (staleRefreshTimerRef.current) {
      clearTimeout(staleRefreshTimerRef.current);
      staleRefreshTimerRef.current = null;
    }
    staleRefreshAttemptsRef.current = 0;
  };

  useEffect(() => {
    toolSourcesRef.current = buildToolSourceMap(messages);
  }, [messages]);

  useEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);

  useEffect(() => {
    persistedSnapshotToolCallIdsRef.current = new Set(
      persistedSnapshotToolCallIds,
    );
  }, [persistedSnapshotToolCallIds]);

  useEffect(() => {
    const prev = prevScopeRef.current;
    const identityChanged =
      prev.chatSessionId !== chatSessionId ||
      prev.hostedChatboxId !== hostedChatboxId;

    sessionIdRef.current = chatSessionId;
    chatboxIdRef.current = hostedChatboxId;
    accessVersionRef.current = hostedAccessVersion;

    if (identityChanged) {
      // Different chat or different chatbox → previous per-toolCallId state
      // is no longer relevant. Drop everything, including the stale-retry
      // queue (those toolCallIds belong to the old scope). Bump the scope
      // generation so any in-flight upload bails at its next continuation
      // point rather than writing into the new scope.
      scopeGenerationRef.current += 1;
      uploadedHashesRef.current.clear();
      cachedBlobsRef.current.clear();
      retryCountRef.current.clear();
      pendingStaleRetryRef.current.clear();
      clearPendingStaleRefresh();
      for (const timer of pendingTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimersRef.current.clear();
      inFlightRef.current.clear();
    } else if (pendingStaleRetryRef.current.size > 0) {
      // accessVersion bumped on the same chatbox/session — the parent's
      // silent re-redeem has handed us a fresh version. Replay the
      // toolCallIds whose previous attempt died on `chatbox_access_stale`
      // so the capture loop self-heals without waiting for an unrelated
      // widget/message change. Cancel the bounded-backoff timer too —
      // we made progress, no further auto-refreshes needed.
      clearPendingStaleRefresh();
      const replay = Array.from(pendingStaleRetryRef.current);
      pendingStaleRetryRef.current.clear();
      for (const toolCallId of replay) {
        void uploadAttemptRef.current(toolCallId);
      }
    }

    prevScopeRef.current = { chatSessionId, hostedChatboxId };
  }, [chatSessionId, hostedChatboxId, hostedAccessVersion]);

  useEffect(() => {
    return () => {
      for (const timer of pendingTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimersRef.current.clear();
      inFlightRef.current.clear();
      if (staleRefreshTimerRef.current) {
        clearTimeout(staleRefreshTimerRef.current);
        staleRefreshTimerRef.current = null;
      }
    };
  }, []);

  uploadAttemptRef.current = async (toolCallId: string) => {
    const chatboxId = chatboxIdRef.current;
    const accessVersion = accessVersionRef.current;
    // Generation snapshot. Re-read against `scopeGenerationRef.current`
    // after every await to detect identity changes (chatSessionId /
    // chatboxId) and bail before mutating per-scope refs or calling
    // `createWidgetSnapshot` for the wrong chat.
    const attemptGeneration = scopeGenerationRef.current;
    const scopeStillValid = () =>
      scopeGenerationRef.current === attemptGeneration;
    if (!enabled || !readyToPersist || inFlightRef.current.has(toolCallId)) {
      return;
    }

    const widget = widgetsRef.current.get(toolCallId);
    const toolSource = toolSourcesRef.current.get(toolCallId);

    if (!widget?.widgetHtml || !toolSource) {
      return;
    }
    if (persistedSnapshotToolCallIdsRef.current.has(toolCallId)) {
      return;
    }
    if (!toolSource.serverId) {
      return;
    }

    const htmlHash = hashString(widget.widgetHtml);
    if (uploadedHashesRef.current.get(toolCallId) === htmlHash) {
      return;
    }

    inFlightRef.current.add(toolCallId);

    const uploadBlob = async (
      content: BlobPart,
      contentType: string,
    ): Promise<string> => {
      const isChatboxSession = Boolean(chatboxId);
      const uploadUrl = await generateSnapshotUploadUrl({
        ...(chatboxId ? { chatboxId } : {}),
        ...(chatboxId && Number.isFinite(accessVersion)
          ? { accessVersion }
          : {}),
        ...(!isChatboxSession
          ? { chatSessionId: sessionIdRef.current }
          : {}),
      });
      const response = await fetch(uploadUrl, {
        method: "POST",
        body: new Blob([content], { type: contentType }),
      });

      if (!response.ok) {
        throw new Error(`Failed to upload snapshot blob (${response.status})`);
      }

      const result = (await response.json()) as { storageId?: string };
      if (!result.storageId) {
        throw new Error("Snapshot upload did not return a storageId");
      }

      return result.storageId;
    };

    try {
      // Reuse cached blobs if the HTML hash matches (avoids orphaned blobs on retry)
      let cached = cachedBlobsRef.current.get(toolCallId);
      if (!cached || cached.htmlHash !== htmlHash) {
        const [widgetHtmlBlobId, toolInputBlobId, toolOutputBlobId] =
          await Promise.all([
            uploadBlob(widget.widgetHtml, "text/html"),
            uploadBlob(
              JSON.stringify(toolSource.input ?? null),
              "application/json",
            ),
            uploadBlob(
              JSON.stringify(toolSource.rawOutput ?? null),
              "application/json",
            ),
          ]);
        if (!scopeStillValid()) {
          // Scope moved while uploads were in flight. The blobs are
          // orphaned in storage, but writing the cache entry under the
          // new scope's refs would cause the next attempt to skip the
          // re-upload pass and reference stale storage IDs.
          return;
        }
        cached = {
          htmlHash,
          widgetHtmlBlobId,
          toolInputBlobId,
          toolOutputBlobId,
        };
        cachedBlobsRef.current.set(toolCallId, cached);
      }

      if (!scopeStillValid()) return;

      // Build the shared payload (the part every writer to
      // `sharedChatWidgetSnapshots` produces), sanitize for Convex
      // transport, then layer the playground/chatbox session context
      // (chatboxId / accessVersion / chatSessionId) on top. The shared
      // pipeline owns the $-key escaping inside `widgetPermissions`
      // (JSON Schema fragments routinely use `$ref` / `$schema` which
      // Convex's argument validator rejects raw) and any future
      // normalization the table wants from every caller.
      const widgetPayload: SharedChatWidgetSnapshotPayload = {
        ...(toolSource.serverId ? { serverId: toolSource.serverId } : {}),
        toolCallId,
        toolName: toolSource.toolName,
        widgetHtmlBlobId: cached.widgetHtmlBlobId,
        uiType: widget.protocol,
        resourceUri: toolSource.resourceUri,
        toolInputBlobId: cached.toolInputBlobId,
        toolOutputBlobId: cached.toolOutputBlobId,
        widgetCsp: toWidgetCsp(widget),
        widgetPermissions: widget.csp?.permissions,
        widgetPermissive: widget.csp?.mode === "permissive",
        prefersBorder: widget.prefersBorder,
        displayContext: toDisplayContext(widget.globals),
        // Persist the OpenAI Apps SDK shim provenance so replay can
        // reconstruct the same `window.openai` surface the widget was
        // captured against. Pulled from the widget-debug store (set by
        // the MCP-Apps renderer at fetch time).
        ...(typeof widget.injectedOpenAiCompat === "boolean"
          ? { injectedOpenAiCompat: widget.injectedOpenAiCompat }
          : {}),
        ...(widget.injectedOpenAiCompatCapabilities
          ? {
              injectedOpenAiCompatCapabilities:
                widget.injectedOpenAiCompatCapabilities,
            }
          : {}),
      };
      const snapshotPayload = {
        ...(chatboxId ? { chatboxId } : {}),
        ...(chatboxId && Number.isFinite(accessVersion)
          ? { accessVersion }
          : {}),
        chatSessionId: sessionIdRef.current,
        ...sanitizeWidgetForBackend(widgetPayload),
      };
      const snapshotResult = await createWidgetSnapshot(snapshotPayload);

      if (!scopeStillValid()) {
        // Scope changed across the mutation await. The snapshot row was
        // written for the previous chat — that's fine; the previous chat
        // is what it belongs to. But don't touch the new scope's
        // bookkeeping refs (uploadedHashesRef etc.), since the reset
        // effect just cleared them on our behalf.
        return;
      }

      if (shouldRetryPendingSnapshot(snapshotResult, null)) {
        throw new Error("Session not found for chat session");
      }

      uploadedHashesRef.current.set(toolCallId, htmlHash);
      cachedBlobsRef.current.delete(toolCallId);
      retryCountRef.current.delete(toolCallId);
    } catch (error) {
      if (!scopeStillValid()) {
        // Same as above — anything we do here would mutate refs that
        // belong to a different scope now.
        return;
      }
      if (isStaleHostedAccessError(error)) {
        // Drop cached blobs uploaded under the stale accessVersion, queue
        // this toolCallId for replay once the fresh accessVersion arrives,
        // and ask the owner to re-redeem. The reset effect drains the
        // queue so recovery doesn't depend on an unrelated widget/message
        // change re-triggering the debounced sweep.
        //
        // No hook-side latch: the parent's `requestRefreshAccessVersion`
        // gates re-entrancy with its own in-flight ref (cleared in
        // `finally`), so concurrent stale errors coalesce there. Latching
        // here would survive a failed `/api/web/chatboxes/redeem`
        // response (no accessVersion bump → no reset → latch stuck true)
        // and silently disable every future recovery attempt.
        cachedBlobsRef.current.delete(toolCallId);
        retryCountRef.current.delete(toolCallId);
        const existingTimer = pendingTimersRef.current.get(toolCallId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          pendingTimersRef.current.delete(toolCallId);
        }
        pendingStaleRetryRef.current.add(toolCallId);
        onStaleHostedAccessRef.current?.();
        // Arm/refresh the bounded-backoff timer. If the parent's redeem
        // succeeds, `hostedAccessVersion` will bump, the reset effect
        // drains the queue and cancels this timer. If the redeem fails,
        // the timer re-fires `onStaleHostedAccess` on a growing backoff
        // so the queued snapshot isn't stranded.
        schedulePendingStaleRefresh();
      } else if (shouldRetryPendingSnapshot(undefined, error)) {
        const retries = retryCountRef.current.get(toolCallId) ?? 0;
        if (retries >= MAX_PENDING_SESSION_RETRIES) {
          console.warn(
            "[useSharedChatWidgetCapture] Giving up on snapshot for",
            toolCallId,
            "after",
            retries,
            "retries",
          );
          cachedBlobsRef.current.delete(toolCallId);
          retryCountRef.current.delete(toolCallId);
        } else {
          retryCountRef.current.set(toolCallId, retries + 1);
          const existingTimer = pendingTimersRef.current.get(toolCallId);
          if (existingTimer) {
            clearTimeout(existingTimer);
          }
          const baseDelay = Math.min(1000 * Math.pow(1.5, retries), 10000);
          const delay = baseDelay + Math.random() * baseDelay * 0.5;
          const retryTimer = setTimeout(() => {
            pendingTimersRef.current.delete(toolCallId);
            void uploadAttemptRef.current(toolCallId);
          }, delay);
          pendingTimersRef.current.set(toolCallId, retryTimer);
        }
      } else {
        console.warn(
          "[useSharedChatWidgetCapture] Failed to save snapshot:",
          error,
        );
      }
    } finally {
      inFlightRef.current.delete(toolCallId);
    }
  };

  useEffect(() => {
    if (!enabled || !readyToPersist) {
      for (const timer of pendingTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimersRef.current.clear();
      return;
    }

    for (const [toolCallId, widget] of widgets) {
      const existingTimer = pendingTimersRef.current.get(toolCallId);
      if (persistedSnapshotToolCallIdsRef.current.has(toolCallId)) {
        if (existingTimer) {
          clearTimeout(existingTimer);
          pendingTimersRef.current.delete(toolCallId);
        }
        continue;
      }
      if (!widget.widgetHtml) {
        continue;
      }
      if (!toolSourcesRef.current.has(toolCallId)) {
        continue;
      }

      const htmlHash = hashString(widget.widgetHtml);
      if (uploadedHashesRef.current.get(toolCallId) === htmlHash) {
        continue;
      }

      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        pendingTimersRef.current.delete(toolCallId);
        void uploadAttemptRef.current(toolCallId);
      }, SNAPSHOT_CAPTURE_DELAY_MS);

      pendingTimersRef.current.set(toolCallId, timer);
    }
  }, [
    enabled,
    readyToPersist,
    hostedChatboxId,
    persistedSnapshotToolCallIds,
    widgets,
    messages,
  ]);
}
