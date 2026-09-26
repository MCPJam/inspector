// Run from the inspector directory: node scripts/smoke-electron-oauth.cjs
// Uses a fresh temporary profile and a hidden window; no account or MCP tokens.
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildSync } = require("esbuild");
const directory = mkdtempSync(path.join(tmpdir(), "mcpjam-oauth-smoke-"));
const root = path.resolve(__dirname, "..");
try {
  for (const [entry, output] of [
    ["preload.ts", "preload.cjs"],
    ["oauth-callback-delivery.ts", "delivery.cjs"],
  ]) {
    buildSync({
      entryPoints: [path.join(root, "src", entry)],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: path.join(directory, output),
    });
  }
  writeFileSync(
    path.join(directory, "main.cjs"),
    readFileSync(path.join(__dirname, "fixtures/oauth-smoke-main.cjs")),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    require("electron"),
    [path.join(directory, "main.cjs")],
    { env, stdio: "inherit", timeout: 20000 },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
