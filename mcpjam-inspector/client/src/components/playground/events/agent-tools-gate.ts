import type { EventsSupportHost } from "@mcpjam/sdk/browser";
import { describeClientEvents } from "@/shared/client-events";

/**
 * Whether a Playground chat offers its agent the MCP Events tools: when the
 * chat's client has a delivery mode the agent can subscribe by in this
 * runtime, the way ChatGPT's model subscribes as the client the user is
 * chatting with. A study never does, and neither does a selected client
 * whose config is still loading, since it may turn out to run a vendor
 * harness. `config: null` is MCPJam (built-in), which receives every mode.
 */
export function chatOffersEventAgentTools(args: {
  config: EventsSupportHost | null;
  configUnresolved: boolean;
  study: boolean;
  hosted: boolean;
}): boolean {
  if (args.configUnresolved || args.study) return false;
  return describeClientEvents(args.config, {
    runtime: args.hosted ? "hosted" : "local",
  }).agentTools.available;
}
