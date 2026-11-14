/**
 * Cursor CLI on the member's computer: Cursor's own package from the verified
 * pack, and the AI SDK's ACP bridge, patched as hosted Cursor runs it, from
 * the Inspector layer (`cursor-local-bridge.ts`).
 *
 * Cursor talks to Cursor's servers itself, so no gateway stands in front of
 * it. It runs on a login the backend exchanges from the organization's key
 * for each turn (`runtime-login.ts`), held in the CLI's memory and never
 * written to disk or the keychain. Every tool call it makes goes through the
 * ACP bridge's permission request, the same pause and resume Claude Code
 * offers, so the attended profiles ask before anything runs.
 */
import { VERSION as CURSOR_ADAPTER_VERSION } from "@ai-sdk/harness-cursor";
import { HARNESS_PINNED_VERSIONS } from "../../../../../shared/harness-model-support.js";
import type { HarnessAuth } from "../../registry.js";
import type { LocalHarnessCompatibility } from "../compatibility.js";
import { PACK_TREE_DIGESTS } from "../pack-digests.generated.js";
import { conformanceVersionFor } from "../runtime-compat.js";
import type { LocalRuntime } from "./types.js";

/** Where the pack recipe puts Cursor's package (`local-harness-pack-recipes/cursor.mjs`). */
const VENDOR_DIR = ["node_modules", "@anysphere", "agent-cli-runtime"] as const;

const manifest: LocalHarnessCompatibility & { harnessId: "cursor" } = {
  harnessId: "cursor",
  // The adapter whose bridge the layer bundles, and the CLI build the pack
  // carries. A change to either needs this manifest reviewed again.
  adapterVersion: "@ai-sdk/harness-cursor@1.0.72+cursor-agent@2026.11.05-86047df",
  runtime: {
    source: "managed-bundle",
    bundleName: "cursor",
    bundleDigest: PACK_TREE_DIGESTS.cursor,
    // The pack is `bin/node`, Cursor's package and the Windows job launcher.
    // The bridge, its host-tool MCP entrypoint and the launcher are the
    // layer's, with every dependency compiled in.
    launcherSource: "inspector-layer",
    launcherRelativePath: "launcher.mjs",
    nodeLauncherRelativePath: "bin/node",
    jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
    // Not an npm package: its version is checked by the vendor probe below.
    vendorPackages: {},
  },
  argvPolicy: { requiredFlags: [], deniedFlags: [] },
  // The CLI keeps its config and state in HOME, the session's synthetic home.
  configStrategy: "synthetic-home",
  // The ACP bridge raises a permission request for every tool call it does
  // not auto-approve, as on hosted Cursor.
  supportsBuiltinToolApprovals: true,
  permissionProfileMapping: {
    "read-only": "allow-reads",
    "workspace-edits": "allow-edits",
    unrestricted: "allow-all",
  },
  // Cursor publishes the package for every pack target. The published pack
  // and its lifecycle conformance still gate each one.
  nativePlatforms: ["darwin", "linux", "win32"],
  isolatedBackends: {},
  lifecycleConformanceVersion: conformanceVersionFor("cursor"),
  adapterBootstrapDir: ".harness-bootstrap/cursor",
  // A local session's recipe is the layer's bridge and MCP entrypoint. The
  // hosted recipe's manifest, lockfile, install script and implementation
  // descriptor install a CLI the pack already is; the runner writes the
  // session's own descriptor (`acp` below).
  adapterBootstrapFiles: ["bridge.mjs", "host-tool-mcp.mjs"],
  // Informational for a layer runtime: the layer digest pins the bridge.
  bridgeBundleDigest: `sha256:${"0".repeat(64)}`,
};

export const cursorLocalRuntime: LocalRuntime<"cursor"> = {
  harnessId: "cursor",
  manifest,
  // Read from the adapter compiled into this server and the pinned build.
  installedAdapterVersion: () =>
    `@ai-sdk/harness-cursor@${CURSOR_ADAPTER_VERSION}+cursor-agent@${HARNESS_PINNED_VERSIONS.cursor}`,
  commands: {
    shapes: [
      "pnpm install --frozen-lockfile --store-dir .pnpm-store",
      "bash implementation/install.sh",
      "mkdir -p '<workDir>' '<bridgeStateDir>'",
      "node '<bootstrapDir>/bridge.mjs' --workdir '<workDir>' --bridge-state-dir '<bridgeStateDir>' " +
        "--implementation-dir '<bootstrapDir>/implementation' --bridge-type 'cursor'",
    ],
    // The bridge's dependency install.
    install: "pnpm install --frozen-lockfile --store-dir .pnpm-store",
    // The adapter's second bootstrap step installs the CLI itself. Locally
    // the pack is that CLI, so it is the same no-op.
    versionProbe: "bash implementation/install.sh",
    bridgeFlags: ["--workdir", "--bridge-state-dir", "--implementation-dir", "--bridge-type"],
    // The bridge's own state stays in the session's directory.
    sessionStateFlags: ["--bridge-state-dir"],
    literalFlags: { "--bridge-type": "cursor" },
  },
  layerFiles: ["bridge.mjs", "host-tool-mcp.mjs"],
  rehash: {
    // The CLI's own entrypoint, which its Node runs.
    always: [[...VENDOR_DIR, "index.js"].join("/")],
    strict: [/^bin\/node(\.exe)?$/, /^node_modules\/@anysphere\/agent-cli-runtime\/(node|node\.exe|rg|rg\.exe)$/],
  },
  vendorProbe: () => ({
    run: { node: [...VENDOR_DIR, "index.js"] },
    args: ["--version"],
    version: { from: "stdout" },
  }),
  reservedSecretEnv: /^(CURSOR_|AGENT_CLI_|AI_SDK_ACP_|BRIDGE_|NO_OPEN_BROWSER$)/i,
  // The bridge's configuration, which carries the login method and the
  // permission settings, and the client name and version it introduces
  // itself to the CLI with. The adapter's empty `CURSOR_API_KEY` and its AI
  // Gateway variables are dropped.
  bridgeEnv: ["AI_SDK_ACP_BRIDGE_CONFIGURATION", "AI_SDK_ACP_CLIENT_APP_NAME", "AI_SDK_ACP_CLIENT_APP_VERSION"],
  credential: {
    kind: "runtime-login",
    // An explicit environment with no key: the adapter, which runs in this
    // Inspector, never reads a Cursor login of the member's own from their
    // home directory or keychain.
    adapterAuth: {} as HarnessAuth,
    // In memory only: nothing is written to disk or the keychain. A login the
    // CLI can't use (unreadable, or under five minutes from expiring) would
    // otherwise send it to the member's browser to sign in to an account of
    // their own; `NO_OPEN_BROWSER` makes it refuse instead, on every
    // platform's build.
    childEnv: (login) => ({
      CURSOR_AUTH_TOKEN: login.accessToken,
      AGENT_CLI_CREDENTIAL_STORE: "memory",
      NO_OPEN_BROWSER: "1",
    }),
  },
  // Cursor runs shell commands, and on Windows its installer requires Git for
  // Windows for them.
  gitBashOnWindows: true,
  acp: {
    implementationDirFlag: "--implementation-dir",
    // As Cursor's own launchers run it: its Node with `index.js`, and on
    // macOS and Linux the system certificate store.
    agent: (inPack, platform) => ({
      executable: inPack(...VENDOR_DIR, platform === "win32" ? "node.exe" : "node"),
      args: [
        ...(platform === "win32" ? [] : ["--use-system-ca"]),
        inPack(...VENDOR_DIR, "index.js"),
        "--disable-auto-update",
        "acp",
      ],
    }),
  },
};
