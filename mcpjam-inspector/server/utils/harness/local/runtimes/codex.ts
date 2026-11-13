/**
 * Codex on the member's computer: `@openai/codex` from the verified pack and
 * the app-server bridge from the Inspector layer.
 *
 * ── A different adapter, the same rules ────────────────────────────────────
 * The published `@ai-sdk/harness-codex` drives `codex exec`, declares
 * `supportsBuiltinToolApprovals: false` and refuses every permission mode but
 * `allow-all` — an unrestricted agent with no approval gate, which on a host
 * with no outer boundary is exactly what the compatibility gate refuses. So the
 * LOCAL Codex entry is MCPJam's own app-server adapter
 * (`codex-appserver/`), whatever transport hosted Codex uses: real approval
 * requests (attended Playground: `allow-reads` / `allow-edits` → Codex
 * `untrusted`), and, for unattended evals and swarms, `allow-all` ONLY inside
 * Codex's own OS command sandbox with an explicit workspace-write policy
 * (`codex-appserver/shared/sandbox-policy.ts`) on targets where that sandbox
 * was measured to hold (`unattendedSandboxTargets`). A target whose probe
 * failed refuses unattended local Codex; it never runs it unrestricted.
 */
import type { HarnessAuth } from "../../registry.js";
import type { LocalHarnessCompatibility } from "../compatibility.js";
import { PACK_TREE_DIGESTS } from "../pack-digests.generated.js";
import { conformanceVersionFor } from "../runtime-compat.js";
import {
  CODEX_BRIDGE_BUNDLE_DIGEST,
  CODEX_LOCAL_ADAPTER_IDENTITY,
  PINNED_CODEX_VERSION,
} from "../../codex-appserver/local-identity.js";
import { LOCAL_UNATTENDED_SANDBOX_POLICY } from "../../codex-appserver/shared/sandbox-policy.js";
import type { LocalRuntime } from "./types.js";

const manifest: LocalHarnessCompatibility & { harnessId: "codex" } = {
  harnessId: "codex",
  // MCPJam's app-server adapter, not an npm package: the bridge bundle hash
  // plus the exact CLI (see `codex-appserver/local-identity.ts`). The
  // Inspector layer — compiled in, re-hashed before every exec, part of the
  // launch identity — is what actually enforces it.
  adapterVersion: CODEX_LOCAL_ADAPTER_IDENTITY,
  runtime: {
    source: "managed-bundle",
    bundleName: "codex",
    bundleDigest: PACK_TREE_DIGESTS.codex,
    // The bridge, its host-tools MCP entrypoint and the launcher are the
    // Inspector layer's; the pack is `bin/node`, `@openai/codex` and its
    // platform package (and the Windows job launcher). `ws` is compiled
    // into the layer's bridge, so it is not a vendor package any more.
    launcherSource: "inspector-layer",
    launcherRelativePath: "launcher.mjs",
    nodeLauncherRelativePath: "bin/node",
    jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
    vendorPackages: {
      "@openai/codex": PINNED_CODEX_VERSION,
    },
  },
  argvPolicy: { requiredFlags: [], deniedFlags: [] },
  configStrategy: "explicit-config-root",
  // The app-server adapter raises real approval requests.
  supportsBuiltinToolApprovals: true,
  // Attended profiles map to Codex `untrusted` (every command and file
  // change asks). `unrestricted` — unattended evals and swarms only, never
  // the Playground (`localPermissionModeFor` / `resolveLocalCompatibility`)
  // — is `allow-all` ONLY together with `unattendedSandboxPolicy` below, and
  // only on a target in `unattendedSandboxTargets`. The bridge refuses
  // `allow-all` without that policy when supervised locally, so it can
  // never become `danger-full-access` on a user's machine.
  permissionProfileMapping: {
    "read-only": "allow-reads",
    "workspace-edits": "allow-edits",
    unrestricted: "allow-all",
  },
  // The published pack and lifecycle-conformance checks below still gate
  // every target. Windows also initializes its sandbox before any thread.
  nativePlatforms: ["darwin", "linux", "win32"],
  nativeTargets: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
  // Unattended Codex is eligible only on Apple silicon. The published pack
  // and its lifecycle-conformance record must still pass the checks below.
  unattendedSandboxTargets: ["darwin-arm64"],
  unattendedSandboxPolicy: LOCAL_UNATTENDED_SANDBOX_POLICY,
  isolatedBackends: {},
  // From the generated record, like Claude Code's: dark until the Codex
  // lifecycle conformance legs pass and the pin records them.
  lifecycleConformanceVersion: conformanceVersionFor("codex"),
  adapterBootstrapDir: ".harness-bootstrap/codex-appserver",
  // A local session's recipe is the Inspector layer's (`pack-bootstrap.ts`),
  // so these are the only files it writes, and each is compared against the
  // layer's copy. The hosted recipe's `package.json` and lockfile install
  // the vendor graph in a sandbox; locally the pack already IS that graph,
  // and a recipe naming them fails closed.
  adapterBootstrapFiles: ["bridge.mjs", "host-tools-mcp.mjs"],
  bridgeBundleDigest: CODEX_BRIDGE_BUNDLE_DIGEST,
};

export const codexLocalRuntime: LocalRuntime<"codex"> = {
  harnessId: "codex",
  manifest,
  // MCPJam's bridge bundle plus the pinned CLI, compiled into this server (npx
  // and Electron alike): there is no npm package to read a version from. See
  // `codex-appserver/local-identity.ts`.
  installedAdapterVersion: () => CODEX_LOCAL_ADAPTER_IDENTITY,
  commands: {
    // The exec adapter's `--cli-shim-dir` launch is not a local shape and is
    // refused.
    shapes: [
      "pnpm install --frozen-lockfile --store-dir .pnpm-store",
      "node node_modules/@openai/codex/bin/codex.js --version",
      "mkdir -p '<workDir>' '<bridgeStateDir>' '<sessionDataDir>'",
      "node '<bootstrapDir>/bridge.mjs' --workdir '<workDir>' --bridge-state-dir " +
        "'<bridgeStateDir>' --session-data-dir '<sessionDataDir>' --bootstrap-dir " +
        "'<bootstrapDir>'",
    ],
    install: "pnpm install --frozen-lockfile --store-dir .pnpm-store",
    versionProbe: "node node_modules/@openai/codex/bin/codex.js --version",
    bridgeFlags: [
      "--workdir",
      "--bridge-state-dir",
      "--session-data-dir",
      "--bootstrap-dir",
    ],
    // Runtime state (rollouts, CODEX_HOME, the relay credential) stays in the
    // session's own directory, never in the user's checkout.
    sessionStateFlags: ["--bridge-state-dir", "--session-data-dir"],
  },
  layerFiles: ["bridge.mjs", "host-tools-mcp.mjs"],
  rehash: {
    // The wrapper the bridge runs with the pack's Node to find the CLI.
    always: ["node_modules/@openai/codex/bin/codex.js"],
    strict: [
      /^bin\/node(\.exe)?$/,
      // `@openai/codex-<platform>/vendor/<triple>/…`: the CLI and its
      // code-mode host, the bundled ripgrep, and the sandbox helpers Codex
      // execs (bubblewrap on Linux, the shell it wraps commands in).
      /(^|\/)@openai\/codex-[a-z0-9-]+\/vendor\/[^/]+\/(bin\/[^/]+|codex-path\/[^/]+|codex-resources\/bwrap|codex-resources\/zsh\/bin\/zsh|codex-resources\/[^/]+\.exe)$/,
      // The wrapper the bridge runs (`node …/bin/codex.js`) to find that CLI.
      /(^|\/)@openai\/codex\/bin\/codex\.js$/,
    ],
  },
  vendorProbe: () => ({
    run: { node: ["node_modules", "@openai", "codex", "bin", "codex.js"] },
    args: ["--version"],
    version: { from: "package-json", path: ["node_modules", "@openai", "codex", "package.json"] },
  }),
  reservedSecretEnv: /^(CODEX_|OPENAI_|AI_GATEWAY_|BRIDGE_)/i,
  bridgeEnv: ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  // `OPENAI_BASE_URL` is the gateway's BARE origin, no `/v1`: Codex appends
  // `/responses`, and the gateway forwards exactly `POST /responses` under the
  // broker's own OpenAI base path.
  childAuth: (gateway) =>
    ({
      CODEX_API_KEY: gateway.sessionCapability,
      OPENAI_BASE_URL: gateway.baseUrl,
    }) as HarnessAuth,
  // Codex runs its own shell, so Git Bash is neither looked up nor handed to it.
  gitBashOnWindows: false,
  // The bridge keeps its `app-server` and thread between turns.
  keepsRuntimeBetweenTurns: true,
};
