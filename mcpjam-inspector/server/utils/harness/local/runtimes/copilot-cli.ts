/**
 * GitHub Copilot CLI on the member's computer: `@github/copilot` and its SDK
 * from the verified pack, and MCPJam's bridge from the Inspector layer.
 *
 * The bridge starts the CLI with every built-in tool excluded and its own MCP
 * servers off. It can call only the host tools MCPJam registers for the turn,
 * which run in this Inspector under MCPJam's approval gate, so the CLI itself
 * never reads, writes or runs anything on the machine.
 */
import type { HarnessAuth } from "../../registry.js";
import type { LocalHarnessCompatibility } from "../compatibility.js";
import { PACK_TREE_DIGESTS } from "../pack-digests.generated.js";
import { conformanceVersionFor } from "../runtime-compat.js";
import {
  COPILOT_BOOTSTRAP_COMMANDS,
  COPILOT_BOOTSTRAP_DIR,
  COPILOT_VENDOR_VERSIONS,
} from "../../copilot-cli/bootstrap-recipe.js";
import type { LocalRuntime } from "./types.js";

/**
 * The vendor pins. The bridge a session runs is the Inspector layer's,
 * re-hashed before every exec and part of the launch identity, so this only
 * has to name what the pack carries.
 */
const ADAPTER_IDENTITY =
  `copilot-bridge+@github/copilot@${COPILOT_VENDOR_VERSIONS["@github/copilot"]}` +
  `+@github/copilot-sdk@${COPILOT_VENDOR_VERSIONS["@github/copilot-sdk"]}`;

const [INSTALL, VERSION_PROBE] = COPILOT_BOOTSTRAP_COMMANDS;

const manifest: LocalHarnessCompatibility & { harnessId: "copilot-cli" } = {
  harnessId: "copilot-cli",
  adapterVersion: ADAPTER_IDENTITY,
  runtime: {
    source: "managed-bundle",
    bundleName: "copilot-cli",
    bundleDigest: PACK_TREE_DIGESTS["copilot-cli"],
    // The pack is `bin/node`, `@github/copilot` with exactly one platform
    // build, the SDK and its JavaScript dependencies (and the Windows job
    // launcher). The bridge and launcher are the Inspector layer's; the
    // launcher resolves the bridge's one external import, the SDK, into it.
    launcherSource: "inspector-layer",
    launcherRelativePath: "launcher.mjs",
    nodeLauncherRelativePath: "bin/node",
    jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
    vendorPackages: { ...COPILOT_VENDOR_VERSIONS },
  },
  argvPolicy: { requiredFlags: [], deniedFlags: [] },
  // The bridge points the CLI's home at the session's own data directory.
  configStrategy: "synthetic-home",
  // Nothing runs without MCPJam's gate: the CLI has no built-in tools, and
  // the host tools it can call pause on MCPJam's approval like every other
  // runtime's.
  supportsBuiltinToolApprovals: true,
  permissionProfileMapping: {
    "read-only": "allow-reads",
    "workspace-edits": "allow-edits",
    unrestricted: "allow-all",
  },
  // `@github/copilot` publishes a build for every pack target. The published
  // pack and its lifecycle conformance still gate each one.
  nativePlatforms: ["darwin", "linux", "win32"],
  isolatedBackends: {},
  lifecycleConformanceVersion: conformanceVersionFor("copilot-cli"),
  adapterBootstrapDir: COPILOT_BOOTSTRAP_DIR,
  // A local session's recipe is the Inspector layer's bridge alone; the
  // hosted recipe's package manifest and lockfile install a vendor graph the
  // pack already is.
  adapterBootstrapFiles: ["bridge.mjs"],
  // Informational for a layer runtime, as for Claude Code: the layer digest
  // pins the bridge a session runs.
  bridgeBundleDigest: `sha256:${"0".repeat(64)}`,
};

export const copilotCliLocalRuntime: LocalRuntime<"copilot-cli"> = {
  harnessId: "copilot-cli",
  manifest,
  // Compiled into this server with the bridge, like Codex's.
  installedAdapterVersion: () => ADAPTER_IDENTITY,
  commands: {
    // The retained-bridge harness Codex also runs on, so the same shapes.
    shapes: [
      INSTALL,
      VERSION_PROBE,
      "mkdir -p '<workDir>' '<bridgeStateDir>' '<sessionDataDir>'",
      "node '<bootstrapDir>/bridge.mjs' --workdir '<workDir>' --bridge-state-dir " +
        "'<bridgeStateDir>' --session-data-dir '<sessionDataDir>' --bootstrap-dir " +
        "'<bootstrapDir>'",
    ],
    install: INSTALL,
    versionProbe: VERSION_PROBE,
    bridgeFlags: [
      "--workdir",
      "--bridge-state-dir",
      "--session-data-dir",
      "--bootstrap-dir",
    ],
    // The CLI's home, its sessions and the bridge's state stay in the
    // session's own directory, never in the user's checkout.
    sessionStateFlags: ["--bridge-state-dir", "--session-data-dir"],
  },
  layerFiles: ["bridge.mjs"],
  rehash: {
    // The SDK the layer's bridge imports in-process.
    always: ["node_modules/@github/copilot-sdk/dist/index.js"],
    strict: [
      /^bin\/node(\.exe)?$/,
      // `@github/copilot-<platform>-<arch>/copilot`: the CLI itself.
      /(^|\/)@github\/copilot-[a-z0-9]+-[a-z0-9]+\/copilot(\.exe)?$/,
    ],
  },
  vendorProbe: () => ({
    // The loader runs the platform build the pack carries.
    run: { node: ["node_modules", "@github", "copilot", "npm-loader.js"] },
    args: ["--version"],
    version: { from: "package-json", path: ["node_modules", "@github", "copilot", "package.json"] },
  }),
  reservedSecretEnv: /^(OPENAI_|COPILOT_|AI_GATEWAY_|BRIDGE_)/i,
  bridgeEnv: ["OPENAI_BASE_URL", "COPILOT_MODEL_PROXY_PLACEHOLDER"],
  // The CLI's OpenAI Responses provider: the gateway's bare origin (it appends
  // `/responses`) and the capability as its key, exactly where the hosted
  // broker puts its URL and placeholder.
  credential: {
    kind: "gateway",
    childAuth: (gateway) =>
      ({
        OPENAI_BASE_URL: gateway.baseUrl,
        COPILOT_MODEL_PROXY_PLACEHOLDER: gateway.sessionCapability,
      }) as HarnessAuth,
  },
  // No built-in tools, so no shell to look up.
  gitBashOnWindows: false,
};
