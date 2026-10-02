/**
 * The BUILT CLI, run as a user runs it: `node cli/dist/index.js test …` in a
 * fresh directory with no login, discovering its server from `./.mcp.json`,
 * reaching a loopback Anthropic-compatible stub through the standard
 * `ANTHROPIC_BASE_URL`, and spawning a real stdio MCP server — the production
 * model factory, not an injected double. The packed-package release smoke
 * runs the same scenario against the installed tarballs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain ESM helper shared with the release smoke script.
import { runLocalTestSmoke } from "./support/local-test-smoke.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./fixtures/policy-target-server.mjs", import.meta.url)
);

test("built CLI: account-free local run, config discovery, single-case rerun, process cleanup", async (t) => {
  if (!existsSync(CLI_ENTRY)) {
    t.skip(
      "cli/dist is not built; run through `npm run test:fast`, which builds it first"
    );
    return;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "mcpjam-test-smoke-"));
  const outcome = await runLocalTestSmoke({
    cliEntry: CLI_ENTRY,
    fixturePath: FIXTURE,
    workDir,
  });
  assert.equal(outcome.full.exitCode, 1);
  assert.equal(outcome.rerun.exitCode, 0);
});
