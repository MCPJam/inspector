import { UIMessage } from "@ai-sdk/react";
import {
  DynamicToolUIPart,
  ToolUIPart,
  UIDataTypes,
  UIMessagePart,
  UITools,
} from "ai";

interface ThreadProps {
  messages: UIMessage[];
}

export function Thread({ messages }: ThreadProps) {
  console.log("messages", messages);
  return (
    <div className="flex-1 overflow-y-auto pb-4">
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-8 space-y-4">
        {messages.map((message) => {
          if (message.role === "user") {
            return <UserMessage key={message.id} message={message} />;
          }
          return <AssistantMessage key={message.id} message={message} />;
        })}
      </div>
    </div>
  );
}

function TextPart({ text }: { text: string }) {
  return <span>{text}</span>;
}

function DynamicToolPart({
  part,
  toolName,
}: {
  part: ToolUIPart<UITools> | DynamicToolUIPart;
  toolName?: string;
}) {
  const state = part.state;
  const displayToolName = toolName;

  return (
    <div className="mt-2 text-xs">
      <div className="font-medium">🔧 Tool: {displayToolName}</div>
      {state === "input-streaming" || state === "input-available" ? (
        <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">
          {JSON.stringify(part.input, null, 2)}
        </pre>
      ) : null}
      {state === "output-available" ? (
        <pre className="mt-1 whitespace-pre-wrap break-words">
          {JSON.stringify(part.output, null, 2)}
        </pre>
      ) : null}
      {state === "output-error" ? (
        <div className="mt-1 text-destructive">Error: {part.errorText}</div>
      ) : null}
    </div>
  );
}

function MessageParts({
  parts,
}: {
  parts: UIMessagePart<UIDataTypes, UITools>[];
}) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <TextPart key={index} text={part.text} />;
        }
        if (part.type === "dynamic-tool") {
          return (
            <DynamicToolPart key={index} part={part} toolName={part.toolName} />
          );
        }
        return null;
      })}
    </>
  );
}

function UserMessage({ message }: { message: UIMessage }) {
  return (
    <div className="flex w-full justify-end">
      <div className="max-w-xl rounded-lg px-3 py-2 text-sm bg-primary text-primary-foreground">
        <MessageParts parts={message.parts} />
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: UIMessage }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-xl rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        <MessageParts parts={message.parts} />
      </div>
    </div>
  );
}
