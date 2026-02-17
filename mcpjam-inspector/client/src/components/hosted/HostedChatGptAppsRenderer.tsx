import type { ComponentProps } from "react";
import { ChatGPTAppRenderer } from "@/components/chat-v2/thread/chatgpt-app-renderer";

export function HostedChatGptAppsRenderer(
  props: ComponentProps<typeof ChatGPTAppRenderer>,
) {
  return <ChatGPTAppRenderer {...props} />;
}
