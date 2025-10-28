import { ModelDefinition } from "@/shared/types";
import { UIMessage } from "@ai-sdk/react";
import {
  UIDataTypes,
  UIMessagePart,
  UITools,
  ToolUIPart,
  DynamicToolUIPart,
} from "ai";
import { useState, type ReactNode } from "react";
import { ChevronDown, MessageCircle } from "lucide-react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getProviderLogoFromModel } from "../chat/chat-helpers";

type AnyPart = UIMessagePart<UIDataTypes, UITools>;

interface ThreadProps {
  messages: UIMessage[];
  model: ModelDefinition;
}

export function Thread({ messages, model }: ThreadProps) {
  return (
    <div className="flex-1 overflow-y-auto pb-4">
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-8 space-y-4">
        {messages.map((message, idx) => (
          <MessageView key={idx} message={message} model={model} />
        ))}
      </div>
    </div>
  );
}

function MessageView({
  message,
  model,
}: {
  message: UIMessage;
  model: ModelDefinition;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromModel(model, themeMode);
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    return (
      <Bubble align="right" variant="primary">
        <div className="space-y-2">
          {message.parts?.map((part, i) => (
            <PartSwitch key={i} part={part} role={role} />
          ))}
        </div>
      </Bubble>
    );
  }

  const steps = groupAssistantPartsIntoSteps(message.parts ?? []);
  return (
    <div className="flex gap-4 w-full">
      <div className="size-8 flex items-center rounded-full justify-center shrink-0 bg-muted/50">
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

      <div className="flex-1 min-w-0 space-y-2">
        {steps.map((stepParts, sIdx) => (
          <Bubble key={sIdx} align="left" variant="muted">
            <div className="space-y-2">
              {stepParts.map((part, pIdx) => (
                <PartSwitch key={`${sIdx}-${pIdx}`} part={part} role={role} />
              ))}
            </div>
          </Bubble>
        ))}
      </div>
    </div>
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
}: {
  part: AnyPart;
  role: UIMessage["role"];
}) {
  if (isToolPart(part) || part.type === "dynamic-tool") {
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

function TextPart({ text }: { text: string; role: UIMessage["role"] }) {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

function ToolPart({ part }: { part: ToolUIPart<UITools> | DynamicToolUIPart }) {
  const label = isDynamicTool(part)
    ? part.toolName
    : getToolNameFromType((part as any).type);

  const state = part.state;
  const [isExpanded, setIsExpanded] = useState(false);
  const statusLabel = state ? state.replace(/-/g, " ") : null;
  const inputData = (part as any).input;
  const outputData = (part as any).output;
  const errorText = (part as any).errorText ?? (part as any).error;
  const hasInput = inputData !== undefined && inputData !== null;
  const hasOutput = outputData !== undefined && outputData !== null;
  const hasError = state === "output-error" && !!errorText;

  return (
    <div className="mt-2 text-xs rounded-md border border-border/40 bg-muted/40">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-medium"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
      >
        <span className="inline-flex items-center gap-2 text-sm">
          <span aria-hidden>🔧</span>
          {label}
        </span>
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          {statusLabel && (
            <span className="text-[10px] uppercase tracking-wide">
              {statusLabel}
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
        <div className="space-y-3 border-t border-border/40 px-3 py-3">
          {hasInput && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Input
              </div>
              <pre className="whitespace-pre-wrap break-words rounded border border-border/30 bg-background/70 p-2 text-[11px] leading-relaxed">
                {safeStringify(inputData)}
              </pre>
            </div>
          )}

          {hasOutput && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Result
              </div>
              <pre className="whitespace-pre-wrap break-words rounded border border-border/30 bg-background/70 p-2 text-[11px] leading-relaxed">
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
    <div className="mt-2 text-xs opacity-80">
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
}

function FilePart({ part }: { part: Extract<AnyPart, { type: "file" }> }) {
  const name = part.filename ?? part.url ?? "file";
  return (
    <div className="mt-2 text-xs">
      <div className="font-medium">📎 {name}</div>
      <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
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
    <div className="mt-2 text-xs">
      <div className="font-medium">🔗 {part.title ?? part.url}</div>
      <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
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
    <div className="mt-2 text-xs">
      <div className="font-medium">📄 {part.title}</div>
      <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
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
    <div className="mt-2 text-xs">
      <div className="font-medium">{label}</div>
      <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
        {safeStringify(value)}
      </pre>
    </div>
  );
}

function Bubble({
  children,
  align,
  variant,
}: {
  children: ReactNode;
  align: "left" | "right";
  variant: "primary" | "muted";
}) {
  const alignClass = align === "right" ? "justify-end" : "justify-start";
  const bgClass =
    variant === "primary"
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-foreground";

  return (
    <div className={`flex w-full ${alignClass}`}>
      <div className={`max-w-xl rounded-lg px-3 py-2 text-sm ${bgClass}`}>
        {children}
      </div>
    </div>
  );
}

function isToolPart(part: AnyPart): part is ToolUIPart<UITools> {
  const t = (part as any).type;
  return typeof t === "string" && t.startsWith("tool-");
}

function isDynamicTool(part: unknown): part is DynamicToolUIPart {
  return (
    !!part &&
    typeof (part as any).type === "string" &&
    (part as any).type === "dynamic-tool"
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
