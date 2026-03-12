import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, MessageSquare } from "lucide-react";
import type { ModelDefinition, ModelProvider } from "@/shared/types";
import { MessageView } from "@/components/chat-v2/thread/message-view";
import {
  adaptTraceToUiMessages,
  type TraceWidgetSnapshot,
} from "@/components/evals/trace-viewer-adapter";
import {
  useSharedChatThread,
  useSharedChatWidgetSnapshots,
} from "@/hooks/useSharedChatThreads";

const NOOP = (..._args: unknown[]) => {};

interface ShareUsageThreadDetailProps {
  threadId: string;
}

export function ShareUsageThreadDetail({
  threadId,
}: ShareUsageThreadDetailProps) {
  const { thread } = useSharedChatThread({ threadId });
  const { snapshots } = useSharedChatWidgetSnapshots({ threadId });
  const [messages, setMessages] = useState<unknown[] | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch messages from blob URL
  useEffect(() => {
    if (!thread?.messagesBlobUrl) {
      setMessages(null);
      return;
    }

    let isActive = true;
    const controller = new AbortController();

    async function fetchMessages() {
      setIsLoadingMessages(true);
      setError(null);
      try {
        const response = await fetch(thread!.messagesBlobUrl!, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.status}`);
        }
        const data = await response.json();
        if (isActive) {
          setMessages(data);
        }
      } catch (err) {
        if (!isActive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load thread messages:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load messages",
        );
      } finally {
        if (isActive) {
          setIsLoadingMessages(false);
        }
      }
    }

    void fetchMessages();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [thread?.messagesBlobUrl]);

  // Transform snapshots to TraceWidgetSnapshot format
  const widgetSnapshots: TraceWidgetSnapshot[] = useMemo(() => {
    if (!snapshots || !thread) return [];
    return snapshots.map((snap) => {
      // Reconstruct toolMetadata so detectUIType returns the correct widget type.
      // Without this, PartSwitch won't enter the widget rendering path.
      const toolMetadata: Record<string, unknown> =
        snap.uiType === "mcp-apps" && snap.resourceUri
          ? { ui: { resourceUri: snap.resourceUri } }
          : snap.uiType === "openai-apps"
            ? { "openai/outputTemplate": "__cached__" }
            : {};

      return {
        toolCallId: snap.toolCallId,
        toolName: snap.toolName,
        protocol: snap.uiType,
        serverId: snap.serverId,
        resourceUri: snap.resourceUri ?? "",
        toolMetadata,
        widgetCsp: snap.widgetCsp,
        widgetPermissions: snap.widgetPermissions,
        widgetPermissive: snap.widgetPermissive,
        prefersBorder: snap.prefersBorder,
        widgetHtmlUrl: snap.widgetHtmlUrl,
      };
    });
  }, [snapshots, thread]);

  // Adapt trace to UI messages
  const adaptedTrace = useMemo(() => {
    if (!messages) return null;
    return adaptTraceToUiMessages({
      trace: { messages: messages as any, widgetSnapshots },
      toolResultDisplay:
        thread?.sourceType === "sandbox" ? "attached-to-tool" : "sibling-text",
    });
  }, [messages, thread?.sourceType, widgetSnapshots]);

  const resolvedModel: ModelDefinition = useMemo(
    () => ({
      id: thread?.modelId ?? "unknown",
      name: thread?.modelId ?? "Unknown",
      provider: "custom" as ModelProvider,
    }),
    [thread?.modelId],
  );

  // Loading state: thread query or messages fetch
  if (thread === undefined || isLoadingMessages) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (thread === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Thread not found</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!adaptedTrace || adaptedTrace.messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No messages in thread</p>
      </div>
    );
  }

  const duration =
    thread.lastActivityAt && thread.startedAt
      ? thread.lastActivityAt - thread.startedAt
      : 0;
  const durationStr =
    duration > 0
      ? duration < 60000
        ? `${Math.round(duration / 1000)}s`
        : `${Math.round(duration / 60000)}m`
      : null;
  const isSandboxThread = thread.sourceType === "sandbox";
  const reasoningDisplayMode = isSandboxThread ? "collapsible" : "collapsed";

  return (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">
              {thread.visitorDisplayName}
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{thread.modelId}</span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                {thread.messageCount} messages
              </span>
              {durationStr && (
                <>
                  <span>·</span>
                  <span>{durationStr}</span>
                </>
              )}
              <span>·</span>
              <span>
                {formatDistanceToNow(new Date(thread.startedAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl space-y-8 px-4 py-4">
          {adaptedTrace.messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              model={resolvedModel}
              onSendFollowUp={NOOP}
              toolsMetadata={{}}
              toolServerMap={{}}
              pipWidgetId={null}
              fullscreenWidgetId={null}
              onRequestPip={NOOP}
              onExitPip={NOOP}
              onRequestFullscreen={NOOP}
              onExitFullscreen={NOOP}
              toolRenderOverrides={adaptedTrace.toolRenderOverrides}
              showSaveViewButton={false}
              minimalMode={!isSandboxThread}
              interactive={false}
              reasoningDisplayMode={reasoningDisplayMode}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
