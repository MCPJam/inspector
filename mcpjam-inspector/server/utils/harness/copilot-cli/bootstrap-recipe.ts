/**
 * Where the GitHub Copilot CLI recipe lives and what it runs, with nothing
 * generated imported, so the Inspector layer bundler and the local runtime
 * definition can read them without the hosted bridge bundle being built.
 */
export const COPILOT_BOOTSTRAP_DIR = ".harness-bootstrap/copilot-cli";

/** In a sandbox: install the pinned vendor graph, then check the CLI answers.
 *  Locally the verified pack already is that graph, so both are no-ops. */
export const COPILOT_BOOTSTRAP_COMMANDS = [
  "pnpm install --frozen-lockfile --ignore-scripts --store-dir .pnpm-store",
  "node node_modules/@github/copilot/npm-loader.js --version",
] as const;

/** The vendor packages the recipe pins, read by the local pack and manifest. */
export const COPILOT_VENDOR_VERSIONS = {
  "@github/copilot": "1.0.92",
  "@github/copilot-sdk": "1.0.11",
} as const;
