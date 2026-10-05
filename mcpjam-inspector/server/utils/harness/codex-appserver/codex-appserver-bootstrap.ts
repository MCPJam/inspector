/**
 * What gets installed into the sandbox before the bridge can run.
 *
 * The framework applies this recipe itself and hashes it into the bootstrap
 * identity, so two sessions with the same recipe reuse the same prepared box
 * and a change to any file here forks them.
 *
 * ONE INVARIANT ABOVE ALL: the output must be byte-identical regardless of
 * credentials. `registry.test.ts` asserts it across every adapter, and it is
 * why the model proxy's base URL — which differs per deployment and arrives per
 * turn — is NOT here. The bridge renders it into `CODEX_HOME/config.toml` at
 * session start instead (see `bridge/codex-home.ts`).
 */
import {
  CODEX_APPSERVER_BRIDGE_SOURCE,
  CODEX_APPSERVER_BUNDLE_VERSION,
  CODEX_APPSERVER_HOST_TOOLS_MCP_SOURCE,
  CODEX_APPSERVER_BOOTSTRAP_PACKAGE_JSON,
  CODEX_APPSERVER_BOOTSTRAP_PNPM_LOCK,
} from "./bootstrap/generated/codex-appserver-bridge.bundled.js";

/** Where the recipe lands, relative to the session working directory. */
export const CODEX_APPSERVER_BOOTSTRAP_DIR =
  ".harness-bootstrap/codex-appserver";

export type CodexAppServerBootstrap = {
  harnessId: string;
  bootstrapDir: string;
  files: Array<{ path: string; content: string }>;
  commands: Array<{ command: string }>;
};

let cached: CodexAppServerBootstrap | undefined;

export function getCodexAppServerBootstrap(): CodexAppServerBootstrap {
  if (cached) return cached;
  cached = {
    harnessId: "codex",
    bootstrapDir: CODEX_APPSERVER_BOOTSTRAP_DIR,
    files: [
      {
        path: `${CODEX_APPSERVER_BOOTSTRAP_DIR}/package.json`,
        content: CODEX_APPSERVER_BOOTSTRAP_PACKAGE_JSON,
      },
      {
        path: `${CODEX_APPSERVER_BOOTSTRAP_DIR}/pnpm-lock.yaml`,
        content: CODEX_APPSERVER_BOOTSTRAP_PNPM_LOCK,
      },
      {
        path: `${CODEX_APPSERVER_BOOTSTRAP_DIR}/bridge.mjs`,
        content: CODEX_APPSERVER_BRIDGE_SOURCE,
      },
      {
        // A SECOND entrypoint, not imported by the bridge: Codex spawns it as
        // an MCP server (see `bridge/codex-home.ts`).
        path: `${CODEX_APPSERVER_BOOTSTRAP_DIR}/host-tools-mcp.mjs`,
        content: CODEX_APPSERVER_HOST_TOOLS_MCP_SOURCE,
      },
    ],
    /*
     * The framework runs every command with `workingDirectory` set to the
     * resolved bootstrap directory (`applyBootstrapRecipe`), so paths here are
     * RELATIVE TO IT. The previous recipe repeated the bootstrap path
     * (`--dir .harness-bootstrap/codex-appserver`), which resolved to a nested
     * directory that did not exist and failed the first session on any box.
     */
    commands: [
      // The published adapters' literal, byte for byte: the lockfile is
      // committed, so the install is frozen, and the store stays inside the
      // bootstrap directory so a re-run reuses it. The local translator treats
      // exactly this string as a no-op (the verified pack already holds the
      // graph), so it must not drift.
      { command: "pnpm install --frozen-lockfile --store-dir .pnpm-store" },
      // Proves the platform-specific optional dependency actually landed. The
      // wrapper installs fine on its own and only fails at RUN time with
      // "Missing optional dependency", which would otherwise surface as an
      // opaque bridge startup failure minutes later.
      { command: "node node_modules/@openai/codex/bin/codex.js --version" },
    ],
  };
  return cached;
}

/** The bundle's content hash. Changes whenever the bridge source changes, which
 *  is what makes a bridge edit fork existing sessions. */
export { CODEX_APPSERVER_BUNDLE_VERSION };
