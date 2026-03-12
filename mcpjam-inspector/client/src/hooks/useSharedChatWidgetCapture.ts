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
  chatSessionId: string;
  hostedShareToken?: string;
  hostedSandboxToken?: string;
  messages: UIMessage[];
}

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

export function useSharedChatWidgetCapture({
  enabled,
  chatSessionId,
  hostedShareToken,
  hostedSandboxToken,
  messages,
}: UseSharedChatWidgetCaptureOptions): void {
  const widgets = useWidgetDebugStore((state) => state.widgets);
  const generateSnapshotUploadUrl = useMutation(
    "sharedChatThreads:generateSnapshotUploadUrl" as any,
  );
  const createWidgetSnapshot = useMutation(
    "sharedChatThreads:createWidgetSnapshot" as any,
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
  const shareTokenRef = useRef(hostedShareToken);
  const sandboxTokenRef = useRef(hostedSandboxToken);
  const uploadAttemptRef = useRef<(toolCallId: string) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    toolSourcesRef.current = buildToolSourceMap(messages);
  }, [messages]);

  useEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);

  useEffect(() => {
    sessionIdRef.current = chatSessionId;
    shareTokenRef.current = hostedShareToken;
    sandboxTokenRef.current = hostedSandboxToken;
    uploadedHashesRef.current.clear();
    cachedBlobsRef.current.clear();
    retryCountRef.current.clear();

    for (const timer of pendingTimersRef.current.values()) {
      clearTimeout(timer);
    }
    pendingTimersRef.current.clear();
    inFlightRef.current.clear();
  }, [chatSessionId, hostedSandboxToken, hostedShareToken]);

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
    const shareToken = shareTokenRef.current;
    const sandboxToken = sandboxTokenRef.current;
    if (
      !enabled ||
      (!shareToken && !sandboxToken) ||
      inFlightRef.current.has(toolCallId)
    ) {
      return;
    }

    const widget = widgetsRef.current.get(toolCallId);
    const toolSource = toolSourcesRef.current.get(toolCallId);

    if (!widget?.widgetHtml || !toolSource) {
      return;
    }
    if (sandboxToken && !toolSource.serverId) {
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
      const uploadUrl = await generateSnapshotUploadUrl({
        ...(shareToken ? { shareToken } : {}),
        ...(sandboxToken ? { sandboxToken } : {}),
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

      await createWidgetSnapshot({
        ...(shareToken ? { shareToken } : {}),
        ...(sandboxToken ? { sandboxToken } : {}),
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
      });

      uploadedHashesRef.current.set(toolCallId, htmlHash);
      cachedBlobsRef.current.delete(toolCallId);
      retryCountRef.current.delete(toolCallId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Thread not found")) {
        const retries = retryCountRef.current.get(toolCallId) ?? 0;
        if (retries >= 15) {
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
    if (!enabled || (!hostedShareToken && !hostedSandboxToken)) {
      return;
    }

    for (const [toolCallId, widget] of widgets) {
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

      const existingTimer = pendingTimersRef.current.get(toolCallId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        pendingTimersRef.current.delete(toolCallId);
        void uploadAttemptRef.current(toolCallId);
      }, 500);

      pendingTimersRef.current.set(toolCallId, timer);
    }
  }, [enabled, hostedSandboxToken, hostedShareToken, widgets, messages]);
}
