import React, { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector } from "@/components/chat/model-selector";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import type { DialogElicitation } from "@/components/ToolsTab";
import type { ModelDefinition } from "@/shared/types";
import type { UIMessage } from "ai";

export interface ThreadProps {
  messages: UIMessage[];
  input: string;
  status: string;
  isLoading: boolean;
  effectiveModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  elicitation: DialogElicitation | null;
  elicitationLoading: boolean;
  onElicitationResponse: (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>,
  ) => Promise<void> | void;
}

export function Thread(props: ThreadProps) {
  const {
    messages,
    input,
    status,
    isLoading,
    effectiveModel,
    availableModels,
    onModelChange,
    setInput,
    onSubmit,
    elicitation,
    elicitationLoading,
    onElicitationResponse,
  } = props;

  const threadChildren = [
    React.createElement(
      "div",
      { key: "scroll", className: "flex-1 overflow-y-auto pb-4" },
      React.createElement(
        "div",
        { className: "max-w-4xl mx-auto px-4 pt-8 pb-8 space-y-4" },
        messages.map((message) =>
          React.createElement(
            "div",
            {
              key: message.id,
              className: `flex w-full ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`,
            },
            React.createElement(
              "div",
              {
                className: `max-w-xl rounded-lg px-3 py-2 text-sm ${
                  message.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`,
              },
              message.parts.map((part, index) => {
                if (part.type === "text") {
                  return React.createElement("span", { key: index }, part.text);
                }
                if (part.type === "step-start") {
                  return React.createElement(
                    "div",
                    { key: index, className: "my-2 opacity-60" },
                    React.createElement("hr", { className: "border-border" }),
                  );
                }
                if (part.type === "dynamic-tool") {
                  const anyPart = part as any;
                  const state = anyPart.state as string | undefined;
                  return React.createElement(
                    "div",
                    { key: index, className: "mt-2 text-xs" },
                    React.createElement(
                      "div",
                      { className: "font-medium" },
                      `🔧 Tool: ${anyPart.toolName}`,
                    ),
                    state === "input-streaming" || state === "input-available"
                      ? React.createElement(
                          "pre",
                          {
                            className:
                              "mt-1 whitespace-pre-wrap break-words opacity-80",
                          },
                          JSON.stringify(anyPart.input, null, 2),
                        )
                      : null,
                    state === "output-available"
                      ? React.createElement(
                          "pre",
                          {
                            className:
                              "mt-1 whitespace-pre-wrap break-words",
                          },
                          JSON.stringify(anyPart.output, null, 2),
                        )
                      : null,
                    state === "output-error"
                      ? React.createElement(
                          "div",
                          { className: "mt-1 text-destructive" },
                          `Error: ${anyPart.errorText}`,
                        )
                      : null,
                  );
                }
                if (
                  typeof part.type === "string" &&
                  (part.type as string).startsWith("tool-")
                ) {
                  const anyPart = part as any;
                  const toolName = (part.type as string).slice(5);
                  const state = anyPart.state as string | undefined;
                  return React.createElement(
                    "div",
                    { key: index, className: "mt-2 text-xs" },
                    React.createElement(
                      "div",
                      { className: "font-medium" },
                      `🔧 Tool: ${toolName}`,
                    ),
                    state === "input-streaming" || state === "input-available"
                      ? React.createElement(
                          "pre",
                          {
                            className:
                              "mt-1 whitespace-pre-wrap break-words opacity-80",
                          },
                          JSON.stringify(anyPart.input, null, 2),
                        )
                      : null,
                    state === "output-available"
                      ? React.createElement(
                          "pre",
                          {
                            className:
                              "mt-1 whitespace-pre-wrap break-words",
                          },
                          JSON.stringify(anyPart.output, null, 2),
                        )
                      : null,
                    state === "output-error"
                      ? React.createElement(
                          "div",
                          { className: "mt-1 text-destructive" },
                          `Error: ${anyPart.errorText}`,
                        )
                      : null,
                  );
                }
                return null;
              }),
            ),
          ),
        ),
      ),
    ),
    React.createElement(
      "div",
      {
        key: "composer",
        className:
          "border-t border-border/50 bg-background/80 backdrop-blur-sm flex-shrink-0",
      },
      React.createElement(
        "div",
        { className: "max-w-4xl mx-auto p-4" },
        React.createElement(
          "form",
          { onSubmit: onSubmit, className: "" },
          React.createElement(Textarea as any, {
            value: input,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInput(e.target.value),
            placeholder: "Ask something…",
            rows: 4,
            disabled: status !== "ready",
            className: "mb-2",
          }),
          React.createElement(
            "div",
            { className: "flex items-center justify-between gap-2" },
            React.createElement(
              "div",
              { className: "flex items-center gap-2" },
              React.createElement(
                "span",
                { className: "text-sm text-muted-foreground" },
                "Model:",
              ),
              React.createElement(ModelSelector as any, {
                currentModel: effectiveModel,
                availableModels,
                onModelChange,
                isLoading,
              }),
            ),
            React.createElement(
              "div",
              { className: "flex justify-end gap-2" },
              isLoading
                ? React.createElement(
                    Button as any,
                    { type: "button", variant: "outline", onClick: () => {} },
                    "Stop",
                  )
                : null,
              React.createElement(
                Button as any,
                { type: "submit", disabled: !input.trim() || status !== "ready" },
                "Send",
              ),
            ),
          ),
        ),
      ),
    ),
    React.createElement(ElicitationDialog as any, {
      key: "elicitation",
      elicitationRequest: elicitation,
      onResponse: onElicitationResponse,
      loading: elicitationLoading,
    }),
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col bg-background h-full min-h-0 overflow-hidden" },
    ...threadChildren,
  );
}


