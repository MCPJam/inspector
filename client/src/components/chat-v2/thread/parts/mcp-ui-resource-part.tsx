import {
  UIActionResult,
  UIResourceRenderer,
  basicComponentLibrary,
  remoteButtonDefinition,
  remoteCardDefinition,
  remoteImageDefinition,
  remoteStackDefinition,
  remoteTextDefinition,
} from "@mcp-ui/client";
import { EmbeddedResource } from "@modelcontextprotocol/sdk/types.js";

import { McpResource } from "../thread-helpers";

export function MCPUIResourcePart({
  resource,
  onSendFollowUp,
}: {
  resource: McpResource;
  onSendFollowUp: (text: string) => void;
}) {
  const handleAction = async (action: UIActionResult) => {
    switch (action.type) {
      case "tool":
        console.info("MCP UI tool action received:", action.payload);
        onSendFollowUp(
          `Call tool ${action.payload.toolName} with parameters ${JSON.stringify(action.payload.params)}`,
        );
        break;
      case "link":
        if (action.payload?.url && typeof window !== "undefined") {
          window.open(action.payload.url, "_blank", "noopener,noreferrer");
          return { status: "handled" };
        }
        break;
      case "prompt":
        if (action.payload?.prompt) {
          onSendFollowUp(`Prompt: ${action.payload.prompt}`);
          return { status: "handled" };
        }
        break;
      case "intent":
        if (action.payload?.intent) {
          onSendFollowUp(`Intent: ${action.payload.intent}`);
          return { status: "handled" };
        }
        break;
      case "notify":
        if (action.payload?.message) {
          onSendFollowUp(`Notification: ${action.payload.message}`);
          return { status: "handled" };
        }
        break;
    }
    return { status: "unhandled" };
  };

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-border/40 bg-muted/20 shadow-sm">
      <UIResourceRenderer
        resource={resource as Partial<EmbeddedResource>}
        htmlProps={{
          style: {
            border: "2px",
            borderRadius: "4px",
            minHeight: "400px",
          },
          iframeProps: {
            title: "Custom MCP Resource",
            className: "mcp-resource-frame",
          },
        }}
        remoteDomProps={{
          library: basicComponentLibrary,
          remoteElements: [
            remoteButtonDefinition,
            remoteTextDefinition,
            remoteStackDefinition,
            remoteCardDefinition,
            remoteImageDefinition,
          ],
        }}
        onUIAction={handleAction}
      />
    </div>
  );
}
