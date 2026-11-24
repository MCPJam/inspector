import type { HarnessV1 } from "@ai-sdk/harness";
import { createRetainedBridgeHarness } from "../codex-appserver/codex-appserver-harness.js";
import type { HarnessMcpJson } from "../mcp-config.js";
import { bootstrapFiles } from "./generated/bootstrap.js";
import { COPILOT_BOOTSTRAP_COMMANDS, COPILOT_BOOTSTRAP_DIR } from "./bootstrap-recipe.js";

const harnessId = "copilot-cli";
const bootstrapDir = COPILOT_BOOTSTRAP_DIR;

export function createCopilotCli(settings: {
  model: string;
  startupTimeoutMs?: number;
  auth: Readonly<Record<string, string>>;
  /** MCPJam proxy or forwarder endpoints the CLI's own MCP client dials. */
  nativeMcpServers?: HarnessMcpJson["mcpServers"];
  /** The servers are forwarded, so each call carries the correlation id. */
  correlateNativeMcp?: boolean;
}) {
  return createRetainedBridgeHarness(settings, {
    id: harnessId,
    builtinTools: {},
    requiresLiveContinuation: true,
    bootstrapDir,
    getBootstrap: async () => ({
      harnessId,
      bootstrapDir,
      files: Object.entries(bootstrapFiles).map(([name, content]) => ({
        path: `${bootstrapDir}/${name}`,
        content,
      })),
      commands: COPILOT_BOOTSTRAP_COMMANDS.map((command) => ({ command })),
    }),
  });
}

/**
 * A live Copilot session keeps the MCP headers it started with (measured on
 * 1.0.92: restarting a server with a new config reuses the old headers), so a
 * paused turn cannot take credentials its continuation mints: a forwarded
 * turn's grant, or a proxy token bound to the paused turn's lease. A chat
 * lane's session configuration has none to take (`session-mcp-config.ts`), so
 * only a turn on per-turn credentials is refused. New turns resume the session
 * with the current configuration and are unaffected.
 */
export function refuseForwardedContinuation<T extends HarnessV1>(
  runtime: T,
): T {
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "doStart")
        return async (options: Parameters<T["doStart"]>[0]) => {
          if (options.continueFrom)
            throw new Error(
              "GitHub Copilot CLI cannot continue this turn after a pause. Send your message again to start a new turn.",
            );
          return target.doStart(options);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
