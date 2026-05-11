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
  const staleRefreshRequestedRef = useRef(false);
  // ToolCallIds whose upload was abandoned mid-flight because the backend
  // reported `chatbox_access_stale`. Replayed once the next
  // `hostedAccessVersion` arrives — without this, the parent's re-redeem
  // silently changes a ref value and nothing re-fires the capture loop
  // until an unrelated widget/message change happens to retrigger the
  // debounced sweep.
  const pendingStaleRetryRef = useRef(new Set<string>());
  const prevScopeRef = useRef({
    chatSessionId,
    hostedChatboxId,
  });
  const uploadAttemptRef = useRef<(toolCallId: string) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    onStaleHostedAccessRef.current = onStaleHostedAccess;
  }, [onStaleHostedAccess]);

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
    // Re-arm the stale-access debounce so a subsequent divergence can
    // trigger another re-redeem.
    staleRefreshRequestedRef.current = false;

    if (identityChanged) {
      // Different chat or different chatbox → previous per-toolCallId state
      // is no longer relevant. Drop everything, including the stale-retry
      // queue (those toolCallIds belong to the old scope).
      uploadedHashesRef.current.clear();
      cachedBlobsRef.current.clear();
      retryCountRef.current.clear();
      pendingStaleRetryRef.current.clear();
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
      // widget/message change.
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
    };
  }, []);

  uploadAttemptRef.current = async (toolCallId: string) => {
    const chatboxId = chatboxIdRef.current;
    const accessVersion = accessVersionRef.current;
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
        cached = {
          htmlHash,
          widgetHtmlBlobId,
          toolInputBlobId,
          toolOutputBlobId,
        };
        cachedBlobsRef.current.set(toolCallId, cached);
      }

      const snapshotPayload = {
        ...(chatboxId ? { chatboxId } : {}),
        ...(chatboxId && Number.isFinite(accessVersion)
          ? { accessVersion }
          : {}),
        chatSessionId: sessionIdRef.current,
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
      };
      const snapshotResult = await createWidgetSnapshot(snapshotPayload);

      if (shouldRetryPendingSnapshot(snapshotResult, null)) {
        throw new Error("Session not found for chat session");
      }

      uploadedHashesRef.current.set(toolCallId, htmlHash);
      cachedBlobsRef.current.delete(toolCallId);
      retryCountRef.current.delete(toolCallId);
    } catch (error) {
      if (isStaleHostedAccessError(error)) {
        // Drop cached blobs uploaded under the stale accessVersion, queue
        // this toolCallId for replay once the fresh accessVersion arrives,
        // and ask the owner to re-redeem. The reset effect drains the
        // queue so recovery doesn't depend on an unrelated widget/message
        // change re-triggering the debounced sweep.
        cachedBlobsRef.current.delete(toolCallId);
        retryCountRef.current.delete(toolCallId);
        const existingTimer = pendingTimersRef.current.get(toolCallId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          pendingTimersRef.current.delete(toolCallId);
        }
        pendingStaleRetryRef.current.add(toolCallId);
        if (!staleRefreshRequestedRef.current) {
          staleRefreshRequestedRef.current = true;
          onStaleHostedAccessRef.current?.();
        }
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
