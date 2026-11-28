/**
 * OpenCode on the member's computer: the pinned OpenCode build, its SDK and
 * ripgrep from the verified pack, and the adapter's bridge, with the local
 * launch changes (`opencode-local-bridge.ts`), from the Inspector layer.
 *
 * Its model calls go through the local gateway on a session capability, on
 * the Anthropic Messages protocol hosted OpenCode speaks to MCPJam's broker.
 * Its built-ins ask through the bridge's permission requests under Tool
 * Approval, and MCPJam's tools reach it through the bridge's relay, gated by
 * MCPJam, as on hosted OpenCode.
 */
import { VERSION as OPENCODE_ADAPTER_VERSION } from "@ai-sdk/harness-opencode";
import type { HarnessAuth } from "../../registry.js";
import type { LocalHarnessCompatibility } from "../compatibility.js";
import { PACK_TREE_DIGESTS } from "../pack-digests.generated.js";
import { conformanceVersionFor } from "../runtime-compat.js";
import type { LocalPackTarget } from "../targets.js";
import type { LocalRuntime } from "./types.js";

/** The CLI build the pack recipe pins (`local-harness-pack-recipes/opencode-vendor/`). */
const OPENCODE_CLI_VERSION = "1.18.34";

/** The package that carries a target's OpenCode build: npm names Windows `windows`. */
function opencodeBuild(target: LocalPackTarget): string {
  return `opencode-${target.replace(/^win32-/, "windows-")}`;
}

const INSTALL = "pnpm install --frozen-lockfile --store-dir .pnpm-store";
const VERSION_PROBE = "./node_modules/.bin/opencode --version";

const manifest: LocalHarnessCompatibility & { harnessId: "opencode" } = {
  harnessId: "opencode",
  // The adapter whose bridge the layer bundles, and the CLI build the pack
  // carries. A change to either needs this manifest reviewed again.
  adapterVersion: `@ai-sdk/harness-opencode@1.0.160+opencode@${OPENCODE_CLI_VERSION}`,
  runtime: {
    source: "managed-bundle",
    bundleName: "opencode",
    bundleDigest: PACK_TREE_DIGESTS.opencode,
    // The pack is `bin/node`, one OpenCode build, the SDK, ripgrep and their
    // JavaScript dependencies (and the Windows job launcher). The bridge, its
    // host-tool MCP entrypoint and the launcher are the layer's; the launcher
    // resolves the bridge's two externals, the SDK and ripgrep, into the pack.
    launcherSource: "inspector-layer",
    launcherRelativePath: "launcher.mjs",
    nodeLauncherRelativePath: "bin/node",
    jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
    vendorPackages: { "opencode-ai": OPENCODE_CLI_VERSION, "@opencode-ai/sdk": OPENCODE_CLI_VERSION, "@vscode/ripgrep": "1.18.0" },
  },
  argvPolicy: { requiredFlags: [], deniedFlags: [] },
  // The CLI keeps its config, sessions and caches under HOME's XDG
  // directories, the session's synthetic home.
  configStrategy: "synthetic-home",
  // The bridge raises a permission request for every built-in its mode does
  // not allow, and the host tools it relays pause on MCPJam's approval.
  supportsBuiltinToolApprovals: true,
  permissionProfileMapping: {
    "read-only": "allow-reads",
    "workspace-edits": "allow-edits",
    unrestricted: "allow-all",
  },
  // OpenCode publishes a build for every pack target. The published pack and
  // its lifecycle conformance still gate each one.
  nativePlatforms: ["darwin", "linux", "win32"],
  isolatedBackends: {},
  lifecycleConformanceVersion: conformanceVersionFor("opencode"),
  adapterBootstrapDir: ".harness-bootstrap/opencode",
  // A local session's recipe is the layer's bridge and host-tool entrypoint.
  // The hosted recipe's manifest, lockfile and workspace file install a
  // vendor graph the pack already is.
  adapterBootstrapFiles: ["bridge.mjs", "host-tool-mcp.mjs"],
  // Informational for a layer runtime: the layer digest pins the bridge.
  bridgeBundleDigest: `sha256:${"0".repeat(64)}`,
};

export const opencodeLocalRuntime: LocalRuntime<"opencode"> = {
  harnessId: "opencode",
  manifest,
  // Read from the adapter compiled into this server and the pinned build.
  installedAdapterVersion: () => `@ai-sdk/harness-opencode@${OPENCODE_ADAPTER_VERSION}+opencode@${OPENCODE_CLI_VERSION}`,
  commands: {
    shapes: [
      INSTALL,
      VERSION_PROBE,
      "mkdir -p '<workDir>' '<bridgeStateDir>'",
      "node '<bootstrapDir>/bridge.mjs' --workdir '<workDir>' --bridge-state-dir '<bridgeStateDir>' " +
        "--bootstrap-dir '<bootstrapDir>' --skills-dir '<skillsDir>'",
    ],
    install: INSTALL,
    versionProbe: VERSION_PROBE,
    bridgeFlags: ["--workdir", "--bridge-state-dir", "--bootstrap-dir", "--skills-dir"],
    // The bridge's state and the skills folder OpenCode reads stay in the
    // session's own directory, never in the user's checkout.
    sessionStateFlags: ["--bridge-state-dir", "--skills-dir"],
  },
  layerFiles: ["bridge.mjs", "host-tool-mcp.mjs"],
  rehash: {
    // The SDK entry and the module that starts the CLI, and ripgrep's
    // wrapper: what the layer's bridge imports in-process.
    always: [
      "node_modules/@opencode-ai/sdk/dist/v2/index.js",
      "node_modules/@opencode-ai/sdk/dist/v2/server.js",
      "node_modules/@vscode/ripgrep/lib/index.js",
    ],
    strict: [
      /^bin\/node(\.exe)?$/,
      // `opencode-<os>-<arch>/bin/opencode`: the CLI itself.
      /^node_modules\/opencode-[a-z0-9]+-[a-z0-9]+\/bin\/opencode(\.exe)?$/,
      /^node_modules\/@vscode\/ripgrep-[a-z0-9]+-[a-z0-9]+\/bin\/rg(\.exe)?$/,
    ],
  },
  vendorProbe: ({ target, platform }) => ({
    run: { binary: ["node_modules", opencodeBuild(target), "bin", platform === "win32" ? "opencode.exe" : "opencode"] },
    args: ["--version"],
    version: { from: "package-json", path: ["node_modules", opencodeBuild(target), "package.json"] },
  }),
  // Where OpenCode and its bridge read a model endpoint, credential,
  // configuration or permission override.
  reservedSecretEnv: /^(ANTHROPIC_|OPENAI_|OPENCODE_|AI_GATEWAY_|AI_SDK_|BRIDGE_)/i,
  // The Anthropic pair the bridge configures OpenCode's provider from, and
  // the setting that keeps OpenCode to the skills folder the adapter writes.
  bridgeEnv: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENCODE_DISABLE_EXTERNAL_SKILLS"],
  // OpenCode's Anthropic provider, exactly where the hosted broker puts its
  // URL and placeholder: the capability as the bearer token, and the
  // gateway's origin with `/v1`, which OpenCode appends `/messages` to.
  credential: {
    kind: "gateway",
    childAuth: (gateway) =>
      ({
        ANTHROPIC_AUTH_TOKEN: gateway.sessionCapability,
        ANTHROPIC_BASE_URL: `${gateway.baseUrl.replace(/\/+$/, "")}/v1`,
      }) as HarnessAuth,
  },
  // OpenCode runs shell commands, through Git for Windows on Windows.
  gitBashOnWindows: true,
  // Not kept between turns yet: Codex goes first.
  keptBetweenTurns: null,
};
