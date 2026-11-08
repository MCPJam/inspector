/**
 * Hosted OpenCode adapter: published `@ai-sdk/harness-opencode` with MCPJam
 * host-executed tools and a platform-brokered Anthropic lease.
 *
 * Title and compaction agents are pinned to the same model the turn leases, so
 * OpenCode cannot reach for a second Anthropic model the broker will refuse.
 */
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import type { HarnessCreateArgs } from "./registry.js";
import { toOpenCodeNativeModel } from "./runtime-model-ids.js";

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
    ...(nativeModel
      ? {
          openCodeConfig: {
            agent: {
              title: { model: nativeModel },
              compaction: { model: nativeModel },
            },
          },
        }
      : {}),
  }) as HarnessAgentAdapter;
}
