import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), "mcpjam-smoke-runner-"));
try {
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(directory, "node_modules"),
    "junction",
  );
  const outfile = join(directory, "smoke.cjs");
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("./local-browser-security-smoke.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    tsconfig: fileURLToPath(
      new URL("../server/tsconfig.json", import.meta.url),
    ),
    plugins: [
      {
        name: "synthetic-fixture-no-telemetry",
        setup(build) {
          // The driver reaches Playwright through `await import()`, and that
          // survives into the CJS bundle as a real dynamic import — so the
          // specifier it carries has to be one the ESM loader accepts. A bare
          // absolute path is not that on Windows: `D:\...` parses as a URL
          // whose protocol is `d:`, and the loader refuses it outright
          // (ERR_UNSUPPORTED_ESM_URL_SCHEME, "On Windows, absolute paths must
          // be valid file:// URLs"), so the whole smoke exited before its
          // first assertion. `file://` is the form every platform accepts,
          // which is why this converts rather than branching on the platform.
          build.onResolve({ filter: /^playwright$/ }, () => ({
            path: pathToFileURL(
              require.resolve("playwright").replace(/index\.js$/, "index.mjs"),
            ).href,
            external: true,
          }));
          build.onResolve({ filter: /utils\/logger(?:\.js)?$/ }, () => ({
            path: "logger",
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const logger={warn(){},info(){},error(){},debug(){}};",
            loader: "js",
          }));
        },
      },
    ],
  });
  const engines = process.argv.slice(2);
  for (const engine of engines.length ? engines : ["node", "electron"]) {
    const binary =
      engine === "electron" ? require("electron") : process.execPath;
    const result = spawnSync(binary, [outfile], {
      stdio: "inherit",
      timeout: 90000,
      env: {
        ...process.env,
        MCPJAM_SECURITY_SMOKE_DIR: mkdtempSync(join(directory, `${engine}-`)),
        NODE_PATH: fileURLToPath(
          new URL("../../node_modules", import.meta.url),
        ),
        MCPJAM_TELEMETRY_DISABLED: "1",
      },
    });
    if (result.status !== 0)
      throw new Error(
        `${engine} security smoke failed: ${result.error ?? result.status}`,
      );
  }
} finally {
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
