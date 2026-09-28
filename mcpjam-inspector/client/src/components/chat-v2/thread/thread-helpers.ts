// Single-sourced from @mcpjam/chat-ui. These part/tool shape helpers were
// extracted into the package (Tier A); the inspector re-exports them here so the
// many existing `@/components/chat-v2/thread/thread-helpers` import sites keep
// working against one implementation (no drift). The `/thread-helpers` subpath
// avoids the package's renderer/markdown graph (not React-free — getToolStateMeta
// returns lucide icon components).
export * from "@mcpjam/chat-ui/thread-helpers";

import type { UIMessage } from "@ai-sdk/react";
import { isHiddenInternalMessage as isHiddenInternalMessageById } from "@mcpjam/chat-ui/thread-helpers";
import { isHiddenUserContextMessage } from "@/shared/user-context-message";

// The four helpers below extend the package's hidden-message rule for this
// app: the widget state the chat sends as user-role context (MJ-009) is hidden
// too, recognized by its header — a reopened conversation's messages come
// back without the `widget-state-` ids the package checks.

export function isHiddenInternalMessage(message: UIMessage): boolean {
  return (
    isHiddenInternalMessageById(message) || isHiddenUserContextMessage(message)
  );
}

export function isRenderableConversationMessage(message: UIMessage): boolean {
  if (isHiddenInternalMessage(message)) return false;
  return message.role === "user" || message.role === "assistant";
}

export function getRenderableConversationMessages(
  messages: UIMessage[],
): UIMessage[] {
  return messages.filter(isRenderableConversationMessage);
}

export function getLastRenderableConversationMessage(
  messages: UIMessage[],
): UIMessage | null {
  return getRenderableConversationMessages(messages).at(-1) ?? null;
}
