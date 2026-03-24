import { useMemo, useState } from "react";
import { Code2, MessageSquare } from "lucide-react";
import type { ModelDefinition, ModelProvider } from "@/shared/types";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { JsonEditor } from "@/components/ui/json-editor";
import { MessageView } from "@/components/chat-v2/thread/message-view";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
  type TraceMessage,
} from "./trace-viewer-adapter";

const NOOP = (..._args: unknown[]) => {};

interface TraceViewerProps {
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null;
  model?: ModelDefinition;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
  connectedServerIds?: string[];
}

function getTraceMessages(
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
) {
  if (!trace) return [];

  if (Array.isArray(trace)) {
    return trace;
  }

  if (
    typeof trace === "object" &&
    trace !== null &&
    "messages" in trace &&
    Array.isArray(trace.messages)
  ) {
    return trace.messages;
  }

  if (
    typeof trace === "object" &&
    trace !== null &&
    "role" in trace &&
    typeof trace.role === "string"
  ) {
    return [trace as TraceMessage];
  }

  return [];
}

export function TraceViewer({
  trace,
  model,
  toolsMetadata = {},
  toolServerMap = {},
  connectedServerIds = [],
}: TraceViewerProps) {
  const [viewMode, setViewMode] = useState<"formatted" | "raw">("formatted");
  const resolvedModel: ModelDefinition = model ?? {
    id: "unknown",
    name: "Unknown",
    provider: "custom" as ModelProvider,
  };
  const traceMessages = getTraceMessages(trace);
  const adaptedTrace = useMemo(
    () =>
      adaptTraceToUiMessages({
        trace,
        toolsMetadata,
        toolServerMap,
        connectedServerIds,
      }),
    [trace, toolsMetadata, toolServerMap, connectedServerIds],
  );

  if (!trace) {
    return (
      <div className="text-xs text-muted-foreground">
        No trace data available
      </div>
    );
  }

  if (traceMessages.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">No messages in trace</div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <div className="text-xs font-medium text-muted-foreground">
          {traceMessages.length} message{traceMessages.length !== 1 ? "s" : ""}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background p-0.5">
          <button
            type="button"
            onClick={() => setViewMode("formatted")}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
              viewMode === "formatted"
                ? "bg-primary/10 text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Formatted view"
          >
            <MessageSquare className="h-3 w-3" />
            Formatted
          </button>
          <button
            type="button"
            onClick={() => setViewMode("raw")}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
              viewMode === "raw"
                ? "bg-primary/10 text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Raw JSON view"
          >
            <Code2 className="h-3 w-3" />
            Raw
          </button>
        </div>
      </div>

      {viewMode === "raw" ? (
        <JsonEditor height="100%" viewOnly value={trace} />
      ) : (
        <div className="max-w-4xl space-y-8 px-4 pt-2">
          {adaptedTrace.messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              model={resolvedModel}
              onSendFollowUp={NOOP}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
              pipWidgetId={null}
              fullscreenWidgetId={null}
              onRequestPip={NOOP}
              onExitPip={NOOP}
              onRequestFullscreen={NOOP}
              onExitFullscreen={NOOP}
              toolRenderOverrides={adaptedTrace.toolRenderOverrides}
              showSaveViewButton={false}
              minimalMode={true}
              interactive={false}
              reasoningDisplayMode="collapsed"
            />
          ))}
        </div>
      )}
    </div>
  );
}
