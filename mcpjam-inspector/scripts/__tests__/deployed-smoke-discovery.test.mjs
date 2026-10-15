import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

test("deployed smoke discovers every spec without local server build artifacts", () => {
  const checkout = mkdtempSync(join(tmpdir(), "mcpjam-deployed-smoke-"));
  try {
    const inspector = join(checkout, "mcpjam-inspector");
    mkdirSync(inspector);
    // Exclude local server sources so a built checkout cannot hide eager imports.
    for (const entry of [
      "e2e",
      "shared",
      "package.json",
      "playwright.config.ts",
    ])
      cpSync(join(packageRoot, entry), join(inspector, entry), {
        recursive: true,
      });
    symlinkSync(
      join(packageRoot, "../node_modules"),
      join(checkout, "node_modules"),
      "junction",
    );
    symlinkSync(
      join(packageRoot, "node_modules"),
      join(inspector, "node_modules"),
      "junction",
    );
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        "--list",
        "--reporter=json",
      ],
      {
        cwd: inspector,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          PLAYWRIGHT_BASE_URL: "https://staging.mcpjam.com",
          MCPJAM_GUEST_SESSION_SHARED_SECRET: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.errors, []);
    const expected = readdirSync(join(packageRoot, "e2e"))
      .filter((file) => file.endsWith(".spec.ts"))
      .filter(
        (file) => !/^(oauth-debugger|local-access)\.spec\.ts$/.test(file),
      );
    assert.deepEqual(
      report.suites.map((suite) => basename(suite.file)).sort(),
      expected.sort(),
    );
    assert.equal(report.config.globalSetup, null);
    assert.equal(report.config.webServer, null);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
