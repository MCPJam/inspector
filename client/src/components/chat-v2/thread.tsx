import { ModelDefinition } from "@/shared/types";
import { UIMessage } from "@ai-sdk/react";
import {
  UIActionResult,
  UIResourceRenderer,
  isUIResource,
  basicComponentLibrary,
  remoteButtonDefinition,
  remoteCardDefinition,
  remoteImageDefinition,
  remoteStackDefinition,
  remoteTextDefinition,
} from "@mcp-ui/client";
import {
  UIDataTypes,
  UIMessagePart,
  UITools,
  ToolUIPart,
  DynamicToolUIPart,
} from "ai";
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getProviderLogoFromModel } from "../chat/chat-helpers";
import { OpenAIAppRenderer } from "./openai-app-renderer";
import { callTool, getToolServerId, ToolServerMap } from "@/lib/mcp-tools-api";
import { MemoizedMarkdown } from "./memomized-markdown";

type AnyPart = UIMessagePart<UIDataTypes, UITools>;
type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

interface ThreadProps {
  messages: UIMessage[];
  sendFollowUpMessage: (text: string) => void;
  model: ModelDefinition;
  isLoading: boolean;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
}

export function Thread({
  messages,
  sendFollowUpMessage,
  model,
  isLoading,
  toolsMetadata,
  toolServerMap,
}: ThreadProps) {
  return (
    <div className="flex-1 overflow-y-auto pb-4">
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16 space-y-8">
        {messages.map((message, idx) => (
          <MessageView
            key={idx}
            message={message}
            model={model}
            onSendFollowUp={sendFollowUpMessage}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
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
}: {
  message: UIMessage;
  model: ModelDefinition;
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromModel(model, themeMode);
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-3xl space-y-3 rounded-xl bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-sm">
          {message.parts?.map((part, i) => (
            <PartSwitch
              key={i}
              part={part}
              role={role}
              onSendFollowUp={onSendFollowUp}
              toolsMetadata={toolsMetadata}
              toolServerMap={toolServerMap}
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
              />
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}

function groupAssistantPartsIntoSteps(parts: AnyPart[]): AnyPart[][] {
  const groups: AnyPart[][] = [];
  let current: AnyPart[] = [];
  for (const part of parts) {
    if ((part as any).type === "step-start") {
      if (current.length > 0) groups.push(current);
      current = [];
      continue; // do not include the step-start part itself
    }
    current.push(part);
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0
    ? groups
    : [parts.filter((p) => (p as any).type !== "step-start")];
}

function PartSwitch({
  part,
  role,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
}: {
  part: AnyPart;
  role: UIMessage["role"];
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
}) {
  if (isToolPart(part) || isDynamicTool(part)) {
    let maybeUiResource: any;
    if (isToolPart(part)) {
      maybeUiResource = (part as any)?.output?.value?.content?.[0];
    } else {
      maybeUiResource = (part as any)?.output?.content?.[0];
    }
    if (maybeUiResource && isUIResource(maybeUiResource)) {
      return (
        <>
          <ToolPart part={part as ToolUIPart<UITools> | DynamicToolUIPart} />
          <MCPUIResourcePart
            resource={maybeUiResource.resource}
            onSendFollowUp={onSendFollowUp}
          />
        </>
      );
    }

    // TODO: Confirm that this is correct.
    if (
      (isDynamicTool(part) || isToolPart(part)) &&
      isPartOpenAIApp(part, toolsMetadata)
    ) {
      console.log("part", part);
      let toolInput: any = null;
      let toolOutput: any = null;
      let toolName: string | undefined;

      // Check free chat or BYOK. isDynamicTool(part) is true for BYOK.
      const toolState = (part as any).state ?? undefined;
      if (toolState === "output-available") {
        if (isDynamicTool(part)) {
          toolName = (part as DynamicToolUIPart).toolName;
          toolInput = (part as DynamicToolUIPart).input;
          toolOutput = (part as DynamicToolUIPart).output;
        } else {
          toolName = getToolNameFromType((part as any).type);
          toolInput = (part as any).input;
          toolOutput = (part as any).output.value;
        }
      }
      const serverId = toolName
        ? getToolServerId(toolName, toolServerMap)
        : undefined;

      if (toolState !== "output-available") {
        return (
          <>
            <ToolPart part={part as ToolUIPart<UITools> | DynamicToolUIPart} />
            <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
              Waiting for tool finish executing...
            </div>
          </>
        );
      }
      if (!toolName || !serverId) {
        return (
          <>
            <ToolPart part={part as ToolUIPart<UITools> | DynamicToolUIPart} />
            <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
              Failed to load tool name or server id.
            </div>
          </>
        );
      }

      return (
        <>
          <ToolPart part={part as ToolUIPart<UITools> | DynamicToolUIPart} />
          <OpenAIAppRenderer
            serverId={serverId}
            toolCallId={(part as any).toolCallId}
            toolName={toolName}
            toolState={(part as any).state as ToolState | undefined}
            toolInput={toolInput ?? null}
            toolOutput={toolOutput ?? null}
            toolMetadata={toolsMetadata[toolName] ?? undefined}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId, toolName, params)
            }
          />
        </>
      );
    }
    return <ToolPart part={part as ToolUIPart<UITools> | DynamicToolUIPart} />;
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
    role === "user" ? "text-primary-foreground" : "text-foreground";
  return (
    <MemoizedMarkdown
      content={text}
      className={`break-words ${textColorClass}`}
    />
  );
}

function ToolPart({ part }: { part: ToolUIPart<UITools> | DynamicToolUIPart }) {
  const label = isDynamicTool(part)
    ? part.toolName
    : getToolNameFromType((part as any).type);

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
        <div className="space-y-4 border-t border-border/40 px-3 py-3">
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
          <span
            className="inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-muted-foreground/60"
            aria-hidden="true"
          />
          <span className="text-sm italic">Thinking…</span>
        </div>
      </div>
    </article>
  );
}

function isToolPart(part: AnyPart): part is ToolUIPart<UITools> {
  const t = (part as any).type;
  return typeof t === "string" && t.startsWith("tool-");
}

type McpResource = {
  uri: string;
  [key: string]: unknown;
};

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
        resource={resource}
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

function isDynamicTool(part: unknown): part is DynamicToolUIPart {
  return (
    !!part &&
    typeof (part as any).type === "string" &&
    (part as any).type === "dynamic-tool"
  );
}

function isPartOpenAIApp(
  part: unknown,
  toolsMetadata: Record<string, Record<string, any>>,
): part is DynamicToolUIPart {
  const toolName = (part as DynamicToolUIPart).toolName;
  const toolNameFromType = getToolNameFromType((part as any).type);
  return (
    toolsMetadata[toolName]?.["openai/outputTemplate"] !== undefined ||
    toolsMetadata[toolNameFromType]?.["openai/outputTemplate"] !== undefined
  );
}

function isDataPart(part: AnyPart): boolean {
  const t = (part as any).type;
  return typeof t === "string" && t.startsWith("data-");
}

function getDataLabel(type: string): string {
  return type === "data-" ? "Data" : `Data (${type.replace(/^data-/, "")})`;
}

function getToolNameFromType(type: string | undefined): string {
  if (!type) return "Tool";
  return type.startsWith("tool-") ? type.replace(/^tool-/, "") : "Tool";
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ToolStateMeta = {
  Icon: LucideIcon;
  label: string;
  className: string;
};

function getToolStateMeta(state: ToolState | undefined): ToolStateMeta | null {
  if (!state) return null;
  switch (state) {
    case "input-streaming":
      return {
        Icon: Loader2,
        label: "Input streaming",
        className: "h-4 w-4 animate-spin text-muted-foreground",
      };
    case "input-available":
      return {
        Icon: CheckCircle2,
        label: "Input available",
        className: "h-4 w-4 text-muted-foreground",
      };
    case "output-available":
      return {
        Icon: CheckCircle2,
        label: "Output available",
        className: "h-4 w-4 text-emerald-500",
      };
    case "output-error":
      return {
        Icon: AlertTriangle,
        label: "Output error",
        className: "h-4 w-4 text-destructive",
      };
    default:
      return null;
  }
}
