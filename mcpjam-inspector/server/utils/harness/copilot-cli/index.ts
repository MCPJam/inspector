import { createRetainedBridgeHarness } from "../codex-appserver/codex-appserver-harness.js";
import { bootstrapFiles } from "./generated/bootstrap.js";

const harnessId = "copilot-cli";
const bootstrapDir = ".harness-bootstrap/copilot-cli";

export function createCopilotCli(settings: {
  model: string;
  startupTimeoutMs?: number;
  auth: Readonly<Record<string, string>>;
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
