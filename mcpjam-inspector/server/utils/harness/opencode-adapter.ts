/**
 * Hosted OpenCode adapter: published `@ai-sdk/harness-opencode` with MCPJam
 * host-executed tools and a platform-brokered Anthropic lease.
 *
 * Title and compaction agents are pinned to the same model the turn leases, so
 * OpenCode cannot reach for a second Anthropic model the broker will refuse.
 *
 * OpenCode stays on 1.0.119 (image input is a later pin). That adapter's
 * `doStart` still resolves `.harness-bootstrap/opencode` against the session
 * working directory, while harness 1.0.158 applies the recipe under
 * `$HOME/.ai-sdk-harness`. Pointing `defaultWorkingDirectory` at that state
 * directory is the remap: the CLI launch and `.agent-runs` land where the
 * bake wrote them, and `sessionWorkDir` stays the project.
 */
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { harnessStateDirectoryPath } from "@ai-sdk/harness";
import { resolveSandboxHomeDir } from "@ai-sdk/harness/utils";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import type { HarnessCreateArgs } from "./registry.js";
import { toOpenCodeNativeModel } from "./runtime-model-ids.js";

function withDefaultWorkingDirectory<T extends object>(
  session: T,
  defaultWorkingDirectory: string,
): T {
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === "defaultWorkingDirectory") return defaultWorkingDirectory;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, prop) {
      return prop === "defaultWorkingDirectory" || Reflect.has(target, prop);
    },
  });
}

export function createOpenCodeHarness(
  args: Pick<
    HarnessCreateArgs,
    "modelId" | "auth" | "upstream" | "startupTimeoutMs"
  >,
) {
  const nativeModel = toOpenCodeNativeModel(args.modelId, args.upstream);
  const inner = createOpenCode({
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
  return new Proxy(inner, {
    get(target, key, receiver) {
      if (key !== "doStart") {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (startOpts: Parameters<HarnessAgentAdapter["doStart"]>[0]) => {
        const sandboxHomeDir = await resolveSandboxHomeDir({
          sandbox: startOpts.sandboxSession,
          ...(startOpts.abortSignal
            ? { abortSignal: startOpts.abortSignal }
            : {}),
        });
        return target.doStart({
          ...startOpts,
          sandboxSession: withDefaultWorkingDirectory(
            startOpts.sandboxSession,
            harnessStateDirectoryPath({ sandboxHomeDir }),
          ),
        });
      };
    },
  });
}
