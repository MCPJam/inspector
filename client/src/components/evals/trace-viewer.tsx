import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  Code2,
  MessageSquare,
  MessageCircle,
} from "lucide-react";
import { useState } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getProviderLogo } from "@/lib/provider-logos";
import { ToolServerMap, getToolServerId } from "@/lib/mcp-tools-api";
import { OpenAIAppRenderer } from "@/components/chat-v2/openai-app-renderer";

interface ContentPart {
  type: string;
  text?: string;
  input?: Record<string, any>;
  output?: any;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface TraceMessage {
  role: string;
  content?: string | ContentPart[];
}

interface TraceData {
  messages?: TraceMessage[];
  [key: string]: any;
}

interface TraceViewerProps {
  trace: TraceData | TraceMessage | TraceMessage[] | null;
  modelProvider?: string;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
}

export function TraceViewer({
  trace,
  modelProvider = "openai",
  toolsMetadata = {},
  toolServerMap = {},
}: TraceViewerProps) {
  const [viewMode, setViewMode] = useState<"formatted" | "raw">("formatted");

  if (!trace) {
    return (
      <div className="text-xs text-muted-foreground">
        No trace data available
      </div>
    );
  }

  // Handle different trace formats
  let messages: TraceMessage[] = [];

  if (Array.isArray(trace)) {
    messages = trace;
  } else if (
    typeof trace === "object" &&
    "messages" in trace &&
    Array.isArray(trace.messages)
  ) {
    messages = trace.messages;
  } else if (typeof trace === "object" && "role" in trace) {
    messages = [trace as TraceMessage];
  }

  if (messages.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">No messages in trace</div>
    );
  }

  // Group messages to combine tool calls with their results
  const groupedMessages: Array<{
    type: "user" | "assistant" | "tool-group";
    messages: TraceMessage[];
  }> = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant") {
      // Check if next message is a tool result
      const nextMessage = messages[i + 1];
      if (nextMessage && nextMessage.role === "tool") {
        groupedMessages.push({
          type: "tool-group",
          messages: [message, nextMessage],
        });
        i++; // Skip the tool message
      } else {
        groupedMessages.push({
          type: "assistant",
          messages: [message],
        });
      }
    } else if (message.role === "user") {
      groupedMessages.push({
        type: "user",
        messages: [message],
      });
    } else {
      // Orphaned tool message
      groupedMessages.push({
        type: "tool-group",
        messages: [message],
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <div className="text-xs font-medium text-muted-foreground">
          {messages.length} message{messages.length !== 1 ? "s" : ""}
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
        <pre className="overflow-auto whitespace-pre-wrap break-words text-xs rounded-md border border-border/30 bg-muted/20 p-3">
          {JSON.stringify(trace, null, 2)}
        </pre>
      ) : (
        <div className="space-y-6">
          {groupedMessages.map((group, idx) => {
            if (group.type === "user") {
              return (
                <TraceMessage
                  key={idx}
                  message={group.messages[0]}
                  modelProvider={modelProvider}
                />
              );
            } else if (group.type === "tool-group") {
              return (
                <TraceMessageGroup
                  key={idx}
                  messages={group.messages}
                  modelProvider={modelProvider}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                />
              );
            } else {
              return (
                <TraceMessage
                  key={idx}
                  message={group.messages[0]}
                  modelProvider={modelProvider}
                />
              );
            }
          })}
        </div>
      )}
    </div>
  );
}

function TraceMessage({
  message,
  modelProvider,
}: {
  message: TraceMessage;
  modelProvider: string;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogo(modelProvider, themeMode);
  const isUser = message.role === "user";

  if (isUser) {
    // User messages can have content as string or array
    const userContent =
      typeof message.content === "string"
        ? message.content
        : message.content?.[0]?.text || "";

    return (
      <div className="flex justify-end">
        <div className="max-w-3xl rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
          <div className="whitespace-pre-wrap break-words leading-6">
            {userContent}
          </div>
        </div>
      </div>
    );
  }

  // For non-user messages without tool grouping
  const contentParts = Array.isArray(message.content) ? message.content : [];

  return (
    <article className="flex gap-4 w-full">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/40">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt="Model logo"
            className="h-4 w-4 object-contain"
          />
        ) : (
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-3 text-sm leading-6">
        {contentParts.map((part, i) => (
          <TracePart key={i} part={part} />
        ))}
      </div>
    </article>
  );
}

function TraceMessageGroup({
  messages,
  modelProvider,
  toolsMetadata = {},
  toolServerMap = {},
}: {
  messages: TraceMessage[];
  modelProvider: string;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogo(modelProvider, themeMode);

  // Extract tool calls from assistant message and results from tool message
  const toolCalls: ContentPart[] = [];
  const toolResults: ContentPart[] = [];
  const otherParts: ContentPart[] = [];

  for (const message of messages) {
    const contentParts = Array.isArray(message.content) ? message.content : [];
    for (const part of contentParts) {
      if (part.type === "tool-call") {
        toolCalls.push(part);
      } else if (part.type === "tool-result") {
        toolResults.push(part);
      } else {
        otherParts.push(part);
      }
    }
  }

  // Match tool calls with their results
  const combined = toolCalls.map((toolCall) => {
    const result = toolResults.find(
      (r) => r.toolCallId === toolCall.toolCallId,
    );
    return { toolCall, toolResult: result };
  });

  return (
    <article className="flex gap-4 w-full">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/40">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt="Model logo"
            className="h-4 w-4 object-contain"
          />
        ) : (
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-3 text-sm leading-6">
        {otherParts.map((part, i) => (
          <TracePart key={`other-${i}`} part={part} />
        ))}
        {combined.map((combo, i) => (
          <CombinedToolPart
            key={`tool-${i}`}
            toolCall={combo.toolCall}
            toolResult={combo.toolResult}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
          />
        ))}
      </div>
    </article>
  );
}

function TracePart({ part }: { part: ContentPart }) {
  if (part.type === "text" && part.text) {
    return (
      <div className="text-sm whitespace-pre-wrap break-words text-foreground">
        {part.text}
      </div>
    );
  }

  if (part.type === "reasoning") {
    // Reasoning parts may have empty text - they're just hidden reasoning tokens
    // OpenAI o1 models return these with encrypted/hidden content
    if (!part.text) {
      return (
        <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-xs text-muted-foreground italic flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-purple-500/60 animate-pulse" />
          Model used internal reasoning (content not visible)
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-3 text-xs">
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-block h-2 w-2 rounded-full bg-purple-500/60" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-400">
            Reasoning
          </span>
        </div>
        <pre className="whitespace-pre-wrap break-words text-muted-foreground leading-relaxed">
          {part.text}
        </pre>
      </div>
    );
  }

  // Unknown part type - show raw JSON
  return (
    <div className="rounded-md border border-border/40 bg-muted/20 p-2">
      <div className="text-xs font-semibold text-muted-foreground mb-1">
        Unknown part type: {part.type}
      </div>
      <pre className="text-xs whitespace-pre-wrap break-words">
        {JSON.stringify(part, null, 2)}
      </pre>
    </div>
  );
}

function CombinedToolPart({
  toolCall,
  toolResult,
  toolsMetadata = {},
  toolServerMap = {},
}: {
  toolCall?: ContentPart;
  toolResult?: ContentPart;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const mcpIconClassName =
    themeMode === "dark" ? "h-3 w-3 filter invert" : "h-3 w-3";
  const toolName = toolCall?.toolName || toolResult?.toolName || "Unknown tool";
  const hasInput = toolCall?.input !== undefined && toolCall?.input !== null;
  const hasOutput =
    toolResult?.output !== undefined && toolResult?.output !== null;
  const isError = toolResult?.isError === true;

  // Check if this tool has OpenAI App metadata
  const toolMetadata = toolName ? toolsMetadata[toolName] : undefined;
  const hasOpenAIApp = !!toolMetadata?.["openai/outputTemplate"];
  const serverId = toolName
    ? getToolServerId(toolName, toolServerMap)
    : undefined;

  // Unwrap the output if it has the { type: "json", value: {...} } structure
  const unwrappedOutput =
    toolResult?.output &&
    typeof toolResult.output === "object" &&
    "type" in toolResult.output &&
    "value" in toolResult.output
      ? toolResult.output.value
      : toolResult?.output;

  // Extract text from nested content structure if it exists
  let displayOutput = unwrappedOutput;
  if (
    hasOutput &&
    typeof toolResult?.output === "object" &&
    toolResult?.output !== null &&
    "content" in toolResult.output &&
    Array.isArray(toolResult.output.content)
  ) {
    const textContent = toolResult.output.content.find(
      (c: any) => c.type === "text",
    );
    if (textContent?.text) {
      displayOutput = textContent.text;
    }
  }

  return (
    <div className="rounded-lg border border-border/50 bg-background/70 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
      >
        <span className="inline-flex items-center gap-2 font-medium normal-case text-foreground">
          <span className="inline-flex items-center gap-2">
            <img
              src="/mcp.svg"
              alt=""
              role="presentation"
              aria-hidden="true"
              className={mcpIconClassName}
            />
            <span className="font-mono text-xs tracking-tight text-muted-foreground/80">
              {toolName}
            </span>
          </span>
        </span>
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <span className="inline-flex h-5 w-5 items-center justify-center">
            {isError ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : toolResult ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            )}
          </span>
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-150 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>

      {isExpanded && (
        <div className="space-y-4 border-t border-border/40 px-3 py-3">
          {hasInput && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Input
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed">
                {JSON.stringify(toolCall!.input, null, 2)}
              </pre>
            </div>
          )}

          {hasOutput && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {isError ? "Error" : "Result"}
              </div>
              <pre
                className={`whitespace-pre-wrap break-words rounded-md border p-2 text-[11px] leading-relaxed ${
                  isError
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-border/30 bg-muted/20"
                }`}
              >
                {typeof displayOutput === "string"
                  ? displayOutput
                  : JSON.stringify(displayOutput, null, 2)}
              </pre>
            </div>
          )}

          {!hasInput && !hasOutput && (
            <div className="text-muted-foreground/70">
              No tool details available.
            </div>
          )}
        </div>
      )}

      {/* Render OpenAI App widget if available */}
      {hasOpenAIApp &&
        serverId &&
        hasOutput &&
        !isError &&
        (() => {
          return (
            <OpenAIAppRenderer
              serverId={serverId}
              toolCallId={toolCall?.toolCallId}
              toolName={toolName}
              toolState="output-available"
              toolInput={toolCall?.input ?? null}
              toolOutput={unwrappedOutput ?? null}
              toolMetadata={toolMetadata}
              onSendFollowUp={undefined}
              onCallTool={undefined}
            />
          );
        })()}
    </div>
  );
}
