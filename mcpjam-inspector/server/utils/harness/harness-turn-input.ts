import type { ModelMessage } from "ai";
import { parseUserContextText } from "@/shared/user-context-message";
import type { EvalTraceSpan } from "@/shared/eval-trace";

/** Both CLI adapters consume the last user message; retain current App state there. */
export function withHarnessTurnContext(messages: ModelMessage[], context?: string): ModelMessage[] {
  const roles = messages.map(message => message.role);
  const lastUser = roles.lastIndexOf("user");
  if (lastUser < 0) return messages;
  const lastAssistant = roles.lastIndexOf("assistant");
  const states = new Map<string, string>();
  const pending: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") continue;
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const part of parts) {
      if (part.type !== "text") continue;
      const block = parseUserContextText(part.text);
      if (block?.kind === "widget-state") states.set(block.subject, part.text);
      else if (index > lastAssistant && index < lastUser) pending.push(part.text);
    }
  }
  const message = messages[lastUser]!;
  if (message.role !== "user") return messages;
  const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  const currentText = content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const prefix = [context, ...states.values(), ...pending]
    .filter((text): text is string => Boolean(text?.trim()) && !currentText.includes(text!)).join("\n\n");
  if (!prefix) return messages;
  const next = [...messages];
  next[lastUser] = { ...message, content: [{ type: "text", text: prefix }, ...content] };
  return next;
}

/** Recorded as discovery information, without pretending an unavailable tool ran. */
export function unavailableAppToolsSpan(): EvalTraceSpan {
  return { id: "unavailable-app-tools", category: "discovery", status: "ok", startMs: 0, endMs: 0,
    name: "App-provided and page tools are unavailable in this agent runtime." };
}
