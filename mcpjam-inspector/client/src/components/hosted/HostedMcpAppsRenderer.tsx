import type { ComponentProps } from "react";
import { MCPAppsRenderer } from "@/components/chat-v2/thread/mcp-apps/mcp-apps-renderer";

export function HostedMcpAppsRenderer(
  props: ComponentProps<typeof MCPAppsRenderer>,
) {
  return <MCPAppsRenderer {...props} />;
}
