import type { UIMessage } from "@ai-sdk/react";

// Minimal UIMessage factories for tests. We cast through `unknown` because the
// renderer only reads `id`, `role`, and `parts` — building the full AI SDK
// message shape in every test would be noise.

export function userText(text: string, id = "u1"): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as unknown as UIMessage;
}

export function assistantParts(
  parts: Array<Record<string, unknown>>,
  id = "a1",
): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage;
}

export function toolPart(opts: {
  toolName: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): Record<string, unknown> {
  return {
    type: `tool-${opts.toolName}`,
    toolCallId: opts.toolCallId ?? "call-1",
    state: opts.state ?? "output-available",
    input: opts.input,
    output: opts.output,
    errorText: opts.errorText,
  };
}
