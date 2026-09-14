import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MCPJAM_ACTION_RECEIPT_DIR,
  writeGithubActionReceipt,
} from "../src/github-action-receipt";

describe("GitHub Action eval receipts", () => {
  const original = process.env[MCPJAM_ACTION_RECEIPT_DIR];
  const directories: string[] = [];

  afterEach(async () => {
    if (original === undefined) delete process.env[MCPJAM_ACTION_RECEIPT_DIR];
    else process.env[MCPJAM_ACTION_RECEIPT_DIR] = original;
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });

  it("writes only the exact uploaded run reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpjam-action-receipt-"));
    directories.push(directory);
    process.env[MCPJAM_ACTION_RECEIPT_DIR] = directory;

    await writeGithubActionReceipt(
      { baseUrl: "https://app.mcpjam.com" },
      { suiteName: "Amazon smoke", framework: "vitest" },
      {
        projectId: "project-1",
        suiteId: "suite-1",
        runId: "run-1",
        status: "completed",
        result: "passed",
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
      }
    );

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, files[0]!), "utf8"))).toEqual({
      schemaVersion: 1,
      baseUrl: "https://app.mcpjam.com",
      projectId: "project-1",
      suiteId: "suite-1",
      suiteName: "Amazon smoke",
      framework: "vitest",
      runId: "run-1",
    });
  });

  it("does nothing outside the action", async () => {
    delete process.env[MCPJAM_ACTION_RECEIPT_DIR];
    await expect(
      writeGithubActionReceipt(
        { baseUrl: "https://app.mcpjam.com" },
        { suiteName: "Suite" },
        {
          suiteId: "suite",
          runId: "run",
          status: "completed",
          result: "passed",
          summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
        }
      )
    ).resolves.toBeUndefined();
  });
});
