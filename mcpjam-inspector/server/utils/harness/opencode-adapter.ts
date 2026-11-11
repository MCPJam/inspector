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
import type { HarnessV1 } from "@ai-sdk/harness";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import type { HarnessCreateArgs } from "./registry.js";
import { toOpenCodeNativeModel } from "./runtime-model-ids.js";

// Host-tool MCP requests stay open across a human approval. The runtime's
// default timeout otherwise resumes its model loop after our lease is revoked.
const HOST_TOOL_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * OpenCode also loads skills from `~/.claude/skills`, `~/.agents/skills` and
 * those folders in its working directory and every parent, where other
 * clients' turns on the same box leave theirs. With this set it reads only
 * the folder the bridge names in `skills.paths` (the adapter's write folder)
 * and its own config folders: the read folders its skills descriptor lists.
 */
const OWN_SKILLS_ONLY = { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" };

export function createOpenCodeHarness(
  args: Pick<
    HarnessCreateArgs,
    "modelId" | "auth" | "upstream" | "startupTimeoutMs"
  >,
) {
  const nativeModel = toOpenCodeNativeModel(args.modelId, args.upstream);
  const harness = createOpenCode({
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
  return withOwnSkillsOnly(harness);
}

/** Every process the adapter spawns starts with {@link OWN_SKILLS_ONLY}: the
 *  bridge, which passes its environment on to the OpenCode server it starts. */
function withOwnSkillsOnly<T extends HarnessV1>(harness: T): T {
  return {
    ...harness,
    doStart(options) {
      return harness.doStart({
        ...options,
        sandboxSession: withSpawnEnv(options.sandboxSession),
      });
    },
  };
}

function withSpawnEnv<S extends object>(session: S): S {
  return new Proxy(session, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "restricted" && typeof value === "function")
        return () => withSpawnEnv(value.call(target));
      if (key === "spawn" && typeof value === "function")
        return (request: { env?: Record<string, string> }) =>
          value.call(target, {
            ...request,
            env: { ...request.env, ...OWN_SKILLS_ONLY },
          });
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
