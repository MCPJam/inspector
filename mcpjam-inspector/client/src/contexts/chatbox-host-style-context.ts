import { createContext, useContext } from "react";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";

const ChatboxHostStyleContext = createContext<ChatboxHostStyle | null>(null);
const ChatboxHostThemeContext = createContext<"light" | "dark" | null>(null);

export const ChatboxHostStyleProvider = ChatboxHostStyleContext.Provider;
export const ChatboxHostThemeProvider = ChatboxHostThemeContext.Provider;

export function useChatboxHostStyle(): ChatboxHostStyle | null {
  return useContext(ChatboxHostStyleContext);
}

export function useChatboxHostTheme(): "light" | "dark" | null {
  return useContext(ChatboxHostThemeContext);
}
