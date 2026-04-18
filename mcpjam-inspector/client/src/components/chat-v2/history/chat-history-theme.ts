import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";

/**
 * Token sets keyed on the user's host-style preference. ChatGPT mimics use the
 * general `accent` family; Claude mimics tie into `sidebar-accent` so the
 * highlight feels like a continuation of the sidebar tab.
 */
export const CHAT_HISTORY_STRONG_BG_CLASS: Record<ChatboxHostStyle, string> = {
  chatgpt: "bg-accent text-accent-foreground",
  claude: "bg-sidebar-accent text-sidebar-accent-foreground",
};
