import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalSuiteFile } from "@mcpjam/sdk";
import { runCli } from "./support/cli-run.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills/mcpjam-eval-import/examples/promptfoo"
);
const sourcePath = path.join(fixtureDir, "promptfooconfig.yaml");
const reportPath = path.join(fixtureDir, "mapping-report.md");
const suitePath = path.join(fixtureDir, "suite.yaml");

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("the promptfoo import example passes the real offline validator", async () => {
  const [source, report, suite] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(suitePath, "utf8"),
  ]);

  const run = await runCli([
    "cloud",
    "eval",
    "validate",
    "--file",
    suitePath,
    "--format",
    "json",
  ]);

  assert.equal(run.exitCode, 0, `${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.valid, true);
  assert.deepEqual(result.suite, {
    id: "s_billing_promptfoo_import",
    name: "Billing assistant (imported from promptfoo)",
    cases: 4,
    enabledCases: 1,
  });
  assert.deepEqual(result.findings, []);

  const loaded = loadEvalSuiteFile(suite);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    return;
  }

  assert.equal(loaded.authored.provenance?.sourceHash, sha256(source));
  assert.equal(loaded.authored.provenance?.reportHash, sha256(report));
  assert.deepEqual(
    loaded.authored.cases.map((entry) => ({
      status: entry.import?.status,
      disabled: entry.disabled ?? false,
    })),
    [
      { status: "exact", disabled: false },
      { status: "approximated", disabled: true },
      { status: "unresolved", disabled: true },
      { status: "unsupported", disabled: true },
    ]
  );

  for (const sourceCaseKey of loaded.authored.cases.map(
    (entry) => entry.import?.sourceCaseKey
  )) {
    assert.ok(sourceCaseKey);
    assert.ok(
      source.includes(sourceCaseKey.replace(/^tests\[\d+\] /, "")),
      sourceCaseKey
    );
  }
});
