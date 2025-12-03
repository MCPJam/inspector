import { ModelDefinition } from "@/shared/types";
import { UIMessage } from "@ai-sdk/react";
import {
  UIActionResult,
  UIResourceRenderer,
  basicComponentLibrary,
  remoteButtonDefinition,
  remoteCardDefinition,
  remoteImageDefinition,
  remoteStackDefinition,
  remoteTextDefinition,
} from "@mcp-ui/client";
import { UITools, ToolUIPart, DynamicToolUIPart } from "ai";
import { useState } from "react";
import { ChevronDown, MessageCircle } from "lucide-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { OpenAIAppRenderer } from "./openai-app-renderer";
import { MCPAppsRenderer } from "./mcp-apps-renderer";
import {
  callTool,
  getToolServerId,
  ToolServerMap,
} from "@/lib/apis/mcp-tools-api";
import { MemoizedMarkdown } from "./memomized-markdown";
import { getProviderLogoFromModel } from "./chat-helpers";
import {
  detectUIType,
  getUIResourceUri,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmbeddedResource } from "@modelcontextprotocol/sdk/types.js";
import {
  AnyPart,
  ToolState,
  extractUIResource,
  getDataLabel,
  getToolInfo,
  getToolNameFromType,
  getToolStateMeta,
  groupAssistantPartsIntoSteps,
  isDataPart,
  isDynamicTool,
  isToolPart,
  safeStringify,
  type McpResource,
} from "./thread-helpers";

interface ThreadProps {
  messages: UIMessage[];
  sendFollowUpMessage: (text: string) => void;
  model: ModelDefinition;
  isLoading: boolean;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
}

export function Thread({
  messages,
  sendFollowUpMessage,
  model,
  isLoading,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
}: ThreadProps) {
  const [pipWidgetId, setPipWidgetId] = useState<string | null>(null);

  const handleRequestPip = (toolCallId: string) => {
    setPipWidgetId(toolCallId);
  };

  const handleExitPip = (toolCallId: string) => {
    if (pipWidgetId === toolCallId) {
      setPipWidgetId(null);
    }
  };

  return (
    <div className="flex-1 min-h-0 pb-4">
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16 space-y-8">
        {messages.map((message, idx) => (
          <MessageView
            key={idx}
            message={message}
            model={model}
            onSendFollowUp={sendFollowUpMessage}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
            onWidgetStateChange={onWidgetStateChange}
            pipWidgetId={pipWidgetId}
            onRequestPip={handleRequestPip}
            onExitPip={handleExitPip}
          />
        ))}
        {isLoading && <ThinkingIndicator model={model} />}
      </div>
    </div>
  );
}

function MessageView({
  message,
  model,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  pipWidgetId,
  onRequestPip,
  onExitPip,
}: {
  message: UIMessage;
  model: ModelDefinition;
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  pipWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromModel(model, themeMode);
  // Hide widget-state messages from UI (they're sent to model but not displayed)
  if (message.id?.startsWith("widget-state-")) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-3xl max-h-[70vh] space-y-3 overflow-auto overscroll-contain rounded-xl border border-[#e5e7ec] bg-[#f9fafc] px-4 py-3 text-sm leading-6 text-[#1f2733] shadow-sm dark:border-[#4a5261] dark:bg-[#2f343e] dark:text-[#e6e8ed]">
          {message.parts?.map((part, i) => (
            <PartSwitch
              key={i}
              part={part}
              role={role}
              onSendFollowUp={onSendFollowUp}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
              onWidgetStateChange={onWidgetStateChange}
              pipWidgetId={pipWidgetId}
              onRequestPip={onRequestPip}
              onExitPip={onExitPip}
            />
          ))}
        </div>
      </div>
    );
  }

  const steps = groupAssistantPartsIntoSteps(message.parts ?? []);
  return (
    <article className="flex gap-4 w-full">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/40">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={`${model.id} logo`}
            className="h-4 w-4 object-contain"
          />
        ) : (
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-6 text-sm leading-6">
        {steps.map((stepParts, sIdx) => (
          <div key={sIdx} className="space-y-3">
            {stepParts.map((part, pIdx) => (
              <PartSwitch
                key={`${sIdx}-${pIdx}`}
                part={part}
                role={role}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                pipWidgetId={pipWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
              />
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}

function PartSwitch({
  part,
  role,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  pipWidgetId,
  onRequestPip,
  onExitPip,
}: {
  part: AnyPart;
  role: UIMessage["role"];
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  pipWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
}) {
  if (isToolPart(part) || isDynamicTool(part)) {
    const toolPart = part as ToolUIPart<UITools> | DynamicToolUIPart;
    const toolInfo = getToolInfo(toolPart);
    const partToolMeta = toolsMetadata[toolInfo.toolName];
    const uiType = detectUIType(partToolMeta, toolInfo.rawOutput);
    const uiResourceUri = getUIResourceUri(uiType, partToolMeta);
    const uiResource =
      uiType === UIType.MCP_UI ? extractUIResource(toolInfo.rawOutput) : null;
    const serverId = getToolServerId(toolInfo.toolName, toolServerMap);

    if (uiResource) {
      return (
        <>
          <ToolPart part={toolPart} />
          <MCPUIResourcePart
            resource={uiResource.resource}
            onSendFollowUp={onSendFollowUp}
          />
        </>
      );
    }

    if (uiType === UIType.MCP_APPS) {
      if (!serverId || !uiResourceUri || !toolInfo.toolCallId) {
        return (
          <>
            <ToolPart part={toolPart} />
            <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
              Failed to load server id or resource uri for MCP App.
            </div>
          </>
        );
      }

      return (
        <>
          <ToolPart part={toolPart} />
          <MCPAppsRenderer
            serverId={serverId}
            toolCallId={toolInfo.toolCallId}
            toolName={toolInfo.toolName}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input}
            toolOutput={toolInfo.output}
            resourceUri={uiResourceUri}
            toolMetadata={partToolMeta}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId, toolName, params)
            }
            onWidgetStateChange={onWidgetStateChange}
            pipWidgetId={pipWidgetId}
            onRequestPip={onRequestPip}
            onExitPip={onExitPip}
          />
        </>
      );
    }

    if (uiType === UIType.OPENAI_SDK) {
      if (toolInfo.toolState !== "output-available") {
        return (
          <>
            <ToolPart part={toolPart} />
            <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
              Waiting for tool to finish executing...
            </div>
          </>
        );
      }

      if (!serverId) {
        return (
          <>
            <ToolPart part={toolPart} />
            <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
              Failed to load tool server id.
            </div>
          </>
        );
      }

      return (
        <>
          <ToolPart part={toolPart} />
          <OpenAIAppRenderer
            serverId={serverId}
            toolCallId={toolInfo.toolCallId}
            toolName={toolInfo.toolName}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input ?? null}
            toolOutput={toolInfo.output ?? null}
            toolMetadata={toolsMetadata[toolInfo.toolName] ?? undefined}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId, toolName, params)
            }
            onWidgetStateChange={onWidgetStateChange}
            pipWidgetId={pipWidgetId}
            onRequestPip={onRequestPip}
            onExitPip={onExitPip}
          />
        </>
      );
    }

    return <ToolPart part={toolPart} />;
  }

  if (isDataPart(part)) {
    return (
      <JsonPart label={getDataLabel(part.type)} value={(part as any).data} />
    );
  }

  switch (part.type) {
    case "text":
      return <TextPart text={part.text} role={role} />;
    case "reasoning":
      return <ReasoningPart text={part.text} state={part.state} />;
    case "file":
      return <FilePart part={part} />;
    case "source-url":
      return <SourceUrlPart part={part} />;
    case "source-document":
      return <SourceDocumentPart part={part} />;
    case "step-start":
      return null; // do not display step-start
    default:
      return <JsonPart label="Unknown part" value={part} />;
  }
}

function TextPart({ text, role }: { text: string; role: UIMessage["role"] }) {
  const textColorClass =
    role === "user" ? "text-foreground" : "text-foreground";
  return (
    <MemoizedMarkdown
      content={text}
      className={`max-w-full break-words overflow-auto ${textColorClass}`}
    />
  );
}

function ToolPart({ part }: { part: ToolUIPart<UITools> | DynamicToolUIPart }) {
  const label = isDynamicTool(part)
    ? part.toolName
    : getToolNameFromType((part as any).type);

  const toolCallId = (part as any).toolCallId as string | undefined;
  const state = part.state as ToolState | undefined;
  const toolState = getToolStateMeta(state);
  const StatusIcon = toolState?.Icon;
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const mcpIconClassName =
    themeMode === "dark" ? "h-3 w-3 filter invert" : "h-3 w-3";
  const [isExpanded, setIsExpanded] = useState(false);
  const inputData = (part as any).input;
  const outputData = (part as any).output;
  const errorText = (part as any).errorText ?? (part as any).error;
  const hasInput = inputData !== undefined && inputData !== null;
  const hasOutput = outputData !== undefined && outputData !== null;
  const hasError = state === "output-error" && !!errorText;

  // Get widget debug info if this is an OpenAI/MCP App
  const widgetDebugInfo = useWidgetDebugStore((s) =>
    toolCallId ? s.widgets.get(toolCallId) : undefined,
  );
  const hasWidgetDebug = !!widgetDebugInfo;

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
              {label}
            </span>
          </span>
        </span>
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          {hasWidgetDebug && !isExpanded && (
            <span className="text-[10px] text-muted-foreground/60 font-normal normal-case">
              Click to debug
            </span>
          )}
          {toolState && StatusIcon && (
            <span
              className="inline-flex h-5 w-5 items-center justify-center"
              title={toolState.label}
            >
              <StatusIcon className={toolState.className} />
              <span className="sr-only">{toolState.label}</span>
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-150 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-border/40 px-3 py-3">
          {hasWidgetDebug ? (
            <Tabs defaultValue="data" className="w-full">
              <TabsList className="mb-3 h-7">
                <TabsTrigger value="data" className="text-[10px] px-2 py-1">
                  Data
                </TabsTrigger>
                <TabsTrigger value="state" className="text-[10px] px-2 py-1">
                  Widget State
                </TabsTrigger>
                <TabsTrigger value="globals" className="text-[10px] px-2 py-1">
                  Globals
                </TabsTrigger>
              </TabsList>

              <TabsContent value="data" className="space-y-4">
                {hasInput && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      Input
                    </div>
                    <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed max-h-[300px] overflow-auto">
                      {safeStringify(inputData)}
                    </pre>
                  </div>
                )}
                {hasOutput && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      Result
                    </div>
                    <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed max-h-[300px] overflow-auto">
                      {safeStringify(outputData)}
                    </pre>
                  </div>
                )}
                {hasError && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      Error
                    </div>
                    <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                      {errorText}
                    </div>
                  </div>
                )}
                {!hasInput && !hasOutput && !hasError && (
                  <div className="text-muted-foreground/70">
                    No tool details available.
                  </div>
                )}
              </TabsContent>

              <TabsContent value="state" className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Widget State
                  </div>
                  <div className="text-[9px] text-muted-foreground/50">
                    Updated:{" "}
                    {new Date(widgetDebugInfo.updatedAt).toLocaleTimeString()}
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed max-h-[300px] overflow-auto">
                  {widgetDebugInfo.widgetState
                    ? safeStringify(widgetDebugInfo.widgetState)
                    : "null (no state set)"}
                </pre>
                <div className="text-[9px] text-muted-foreground/50 mt-2">
                  Tip: Widget state persists across follow-up turns. Keep under
                  4k tokens.
                </div>
              </TabsContent>

              <TabsContent value="globals" className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Globals ({widgetDebugInfo.protocol})
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed max-h-[300px] overflow-auto">
                  {safeStringify(widgetDebugInfo.globals)}
                </pre>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="space-y-4">
              {hasInput && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Input
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed">
                    {safeStringify(inputData)}
                  </pre>
                </div>
              )}

              {hasOutput && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Result
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded-md border border-border/30 bg-muted/20 p-2 text-[11px] leading-relaxed">
                    {safeStringify(outputData)}
                  </pre>
                </div>
              )}

              {hasError && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Error
                  </div>
                  <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                    {errorText}
                  </div>
                </div>
              )}

              {!hasInput && !hasOutput && !hasError && (
                <div className="text-muted-foreground/70">
                  No tool details available.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningPart({
  text,
}: {
  text: string;
  state?: "streaming" | "done";
}) {
  if (!text) return null;
  return (
    <div className="rounded-lg border border-border/30 bg-muted/10 p-3 text-xs text-muted-foreground">
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
}

function FilePart({ part }: { part: Extract<AnyPart, { type: "file" }> }) {
  const name = part.filename ?? part.url ?? "file";
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">📎 {name}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify({
          mediaType: part.mediaType,
          filename: part.filename,
          url: part.url,
        })}
      </pre>
    </div>
  );
}

function SourceUrlPart({
  part,
}: {
  part: Extract<AnyPart, { type: "source-url" }>;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">🔗 {part.title ?? part.url}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify({ sourceId: part.sourceId, url: part.url })}
      </pre>
    </div>
  );
}

function SourceDocumentPart({
  part,
}: {
  part: Extract<AnyPart, { type: "source-document" }>;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">📄 {part.title}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify({
          sourceId: part.sourceId,
          mediaType: part.mediaType,
          filename: part.filename,
        })}
      </pre>
    </div>
  );
}

function JsonPart({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify(value)}
      </pre>
    </div>
  );
}

function ThinkingIndicator({ model }: { model: ModelDefinition }) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromModel(model, themeMode);

  return (
    <article
      className="flex w-full gap-4 text-sm leading-6 text-muted-foreground"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/40">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={`${model.id} logo`}
            className="h-4 w-4 object-contain"
          />
        ) : (
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="inline-flex items-center gap-2 text-muted-foreground/80">
          <span className="text-sm italic">
            Thinking
            <span className="inline-flex">
              <span className="animate-[blink_1.4s_ease-in-out_infinite]">
                .
              </span>
              <span className="animate-[blink_1.4s_ease-in-out_0.2s_infinite]">
                .
              </span>
              <span className="animate-[blink_1.4s_ease-in-out_0.4s_infinite]">
                .
              </span>
            </span>
          </span>
        </div>
      </div>
    </article>
  );
}

function MCPUIResourcePart({
  resource,
  onSendFollowUp,
}: {
  resource: McpResource;
  onSendFollowUp: (text: string) => void;
}) {
  const handleAction = async (action: UIActionResult) => {
    switch (action.type) {
      case "tool":
        console.info("MCP UI tool action received:", action.payload);
        onSendFollowUp(
          `Call tool ${action.payload.toolName} with parameters ${JSON.stringify(action.payload.params)}`,
        );
        break;
      case "link":
        if (action.payload?.url && typeof window !== "undefined") {
          window.open(action.payload.url, "_blank", "noopener,noreferrer");
          return { status: "handled" };
        }
        break;
      case "prompt":
        if (action.payload?.prompt) {
          onSendFollowUp(`Prompt: ${action.payload.prompt}`);
          return { status: "handled" };
        }
        break;
      case "intent":
        if (action.payload?.intent) {
          onSendFollowUp(`Intent: ${action.payload.intent}`);
          return { status: "handled" };
        }
        break;
      case "notify":
        if (action.payload?.message) {
          onSendFollowUp(`Notification: ${action.payload.message}`);
          return { status: "handled" };
        }
        break;
    }
    return { status: "unhandled" };
  };

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-border/40 bg-muted/20 shadow-sm">
      <UIResourceRenderer
        resource={resource as Partial<EmbeddedResource>}
        htmlProps={{
          style: {
            border: "2px",
            borderRadius: "4px",
            minHeight: "400px",
          },
          iframeProps: {
            title: "Custom MCP Resource",
            className: "mcp-resource-frame",
          },
        }}
        remoteDomProps={{
          library: basicComponentLibrary,
          remoteElements: [
            remoteButtonDefinition,
            remoteTextDefinition,
            remoteStackDefinition,
            remoteCardDefinition,
            remoteImageDefinition,
          ],
        }}
        onUIAction={handleAction}
      />
    </div>
  );
}
