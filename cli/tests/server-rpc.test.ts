import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMockHttpServer } from "../../sdk/tests/mock-servers/index.js";
import { runCli } from "./support/task-cli-harness.js";

test("server export keeps raw --rpc output inspectable while stable output stays clean", async () => {
  const server = await startMockHttpServer();

  try {
    const rawRun = await runCli([
      "--rpc",
      "--format",
      "json",
      "server",
      "export",
      "--url",
      server.url,
    ]);
    assert.equal(rawRun.exitCode, 0, rawRun.stderr);

    const rawPayload = JSON.parse(rawRun.stdout);
    assert.equal(typeof rawPayload.exportedAt, "string");
    assert.equal(Array.isArray(rawPayload._rpcLogs), true);
    assert.equal(rawPayload._rpcLogs.length > 0, true);

    const stableRun = await runCli([
      "--rpc",
      "--format",
      "json",
      "server",
      "export",
      "--url",
      server.url,
      "--stable",
    ]);
    assert.equal(stableRun.exitCode, 0, stableRun.stderr);

    const stablePayload = JSON.parse(stableRun.stdout);
    assert.equal(stablePayload.kind, "server-snapshot");
    assert.equal(stablePayload.schemaVersion, 1);
    assert.equal("exportedAt" in stablePayload, false);
    assert.equal("_rpcLogs" in stablePayload, false);
  } finally {
    await server.stop();
  }
});

test("server diff keeps raw stdout inspectable and reporter/out artifacts contract-clean", async () => {
  const server = await startMockHttpServer();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-server-rpc-"));
  const baselinePath = path.join(tempDir, "baseline.json");
  const diffOutPath = path.join(tempDir, "diff.json");

  try {
    const baselineRun = await runCli([
      "--format",
      "json",
      "server",
      "export",
      "--url",
      server.url,
      "--stable",
    ]);
    assert.equal(baselineRun.exitCode, 0, baselineRun.stderr);
    await writeFile(baselinePath, baselineRun.stdout, "utf8");

    const rawDiffRun = await runCli([
      "--rpc",
      "--format",
      "json",
      "server",
      "diff",
      "--baseline",
      baselinePath,
      "--url",
      server.url,
    ]);
    assert.equal(rawDiffRun.exitCode, 0, rawDiffRun.stderr);

    const rawDiffPayload = JSON.parse(rawDiffRun.stdout);
    assert.equal(Array.isArray(rawDiffPayload._rpcLogs), true);
    assert.equal(rawDiffPayload._rpcLogs.length > 0, true);
    assert.equal(rawDiffPayload.summary.totalChanges, 0);

    const reporterRun = await runCli([
      "--rpc",
      "--format",
      "json",
      "server",
      "diff",
      "--baseline",
      baselinePath,
      "--url",
      server.url,
      "--reporter",
      "json-summary",
      "--out",
      diffOutPath,
    ]);
    assert.equal(reporterRun.exitCode, 0, reporterRun.stderr);

    const reporterPayload = JSON.parse(reporterRun.stdout);
    assert.equal(reporterPayload.kind, "server-diff");
    assert.equal(reporterPayload.schemaVersion, 1);
    assert.equal("_rpcLogs" in reporterPayload, false);

    const diffArtifact = JSON.parse(await readFile(diffOutPath, "utf8"));
    assert.equal(diffArtifact.summary.totalChanges, 0);
    assert.equal("_rpcLogs" in diffArtifact, false);
  } finally {
    await server.stop();
  }
});
