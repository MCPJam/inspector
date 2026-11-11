import type { HarnessV1 } from "@ai-sdk/harness";
import { createRetainedBridgeHarness } from "../codex-appserver/codex-appserver-harness.js";
import type { HarnessMcpJson } from "../mcp-config.js";
import { bootstrapFiles } from "./generated/bootstrap.js";

const harnessId = "copilot-cli";
const bootstrapDir = ".harness-bootstrap/copilot-cli";

export function createCopilotCli(settings: {
  model: string;
  startupTimeoutMs?: number;
  auth: Readonly<Record<string, string>>;
  /** Forwarded servers the CLI's own MCP client dials. */
  nativeMcpServers?: HarnessMcpJson["mcpServers"];
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
      commands: [
        {
          command:
            "pnpm install --frozen-lockfile --ignore-scripts --store-dir .pnpm-store",
        },
        {
          command: "node node_modules/@github/copilot/npm-loader.js --version",
        },
      ],
    }),
  });
}

/**
 * A live Copilot session keeps the MCP headers it started with (measured on
 * 1.0.92: restarting a server with a new config reuses the old headers), so a
 * paused forwarded turn cannot take the grant its continuation mints. New
 * turns resume the session with fresh headers and are unaffected.
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
