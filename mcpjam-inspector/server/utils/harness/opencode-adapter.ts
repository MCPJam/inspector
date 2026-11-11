/**
 * Hosted OpenCode adapter: published `@ai-sdk/harness-opencode` with MCPJam
 * host-executed tools and a brokered Anthropic Messages lease, paid by MCPJam
 * or by the organization (its Anthropic key, or a gateway that serves
 * Anthropic Messages).
 *
 * The provider is `anthropic` on every lease: it names the wire API, pointed
 * at MCPJam's model proxy, which holds whichever key pays. An org lease runs
 * the id it admits (`toOpenCodeNativeModel`: the vendor's native id, or the
 * gateway's own name as is). Title and compaction agents use that same model
 * so the broker never needs to admit a second model.
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
