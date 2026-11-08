/**
 * Hosted OpenCode adapter: published `@ai-sdk/harness-opencode` with MCPJam
 * host-executed tools and a platform-brokered Anthropic lease.
 *
 * Title and compaction agents are pinned to the same model the turn leases, so
 * OpenCode cannot reach for a second Anthropic model the broker will refuse.
 */
import { createOpenCode } from "@ai-sdk/harness-opencode";
import type { HarnessCreateArgs } from "./registry.js";
import { toOpenCodeNativeModel } from "./runtime-model-ids.js";

// Host-tool MCP requests stay open across a human approval. The runtime's
// default timeout otherwise resumes its model loop after our lease is revoked.
const HOST_TOOL_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

export function createOpenCodeHarness(
  args: Pick<
    HarnessCreateArgs,
    "modelId" | "auth" | "upstream" | "startupTimeoutMs"
  >,
) {
  const nativeModel = toOpenCodeNativeModel(args.modelId, args.upstream);
  return createOpenCode({
    provider: "anthropic",
    auth: args.auth,
    ...(args.startupTimeoutMs
      ? { startupTimeoutMs: args.startupTimeoutMs }
      : {}),
    openCodeConfig: {
      experimental: { mcp_timeout: HOST_TOOL_APPROVAL_TIMEOUT_MS },
      ...(nativeModel
        ? {
            agent: {
              title: { model: nativeModel },
              compaction: { model: nativeModel },
            },
          }
        : {}),
    },
  });
}
