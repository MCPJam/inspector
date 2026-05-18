import { createContext, useContext } from "react";
import type { ChatboxHostStyle } from "@/lib/chatbox-client-style";
import type { ChatUiOverride } from "@/lib/client-styles";

const ChatboxHostStyleContext = createContext<ChatboxHostStyle | null>(null);
const ChatboxHostThemeContext = createContext<"light" | "dark" | null>(null);
/**
 * Persisted chat-UI override for the active chatbox. Sister context to
 * {@link ChatboxHostStyleProvider}: hostStyle picks the preset, this
 * carries the user's per-host customizations on top of it (logo, palette,
 * indicator, etc.). `undefined` means "no override; preset wins" — same
 * semantics as `HostConfigInputV2.chatUiOverride`.
 */
const ChatboxChatUiOverrideContext = createContext<ChatUiOverride | undefined>(
  undefined,
);

export const ChatboxHostStyleProvider = ChatboxHostStyleContext.Provider;
export const ChatboxHostThemeProvider = ChatboxHostThemeContext.Provider;
export const ChatboxChatUiOverrideProvider =
  ChatboxChatUiOverrideContext.Provider;

export function useChatboxHostStyle(): ChatboxHostStyle | null {
  return useContext(ChatboxHostStyleContext);
}

export function useChatboxHostTheme(): "light" | "dark" | null {
  return useContext(ChatboxHostThemeContext);
}

export function useChatboxChatUiOverride(): ChatUiOverride | undefined {
  return useContext(ChatboxChatUiOverrideContext);
}
