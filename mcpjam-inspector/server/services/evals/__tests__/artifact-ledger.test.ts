/**
 * Ledger-driven cleanup: idempotent, retried, and honest about what it left.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildCleanupArgs,
  cleanupBenchmarkArtifacts,
  createBenchmarkArtifactLedger,
} from "../artifact-ledger";

function ledgerWith(ids: string[]) {
  const ledger = createBenchmarkArtifactLedger();
  for (const createdId of ids) {
    ledger.record({
      tool: "create_page",
      artifactName: `mcpjam-benchmark-run-0-${createdId}`,
      createdId,
      cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
    });
  }
  return ledger;
}

describe("createBenchmarkArtifactLedger", () => {
  it("records one row per id, so a repeated id is not cleaned up twice", () => {
    const ledger = ledgerWith(["a", "a", "b"]);
    expect(ledger.entries().map((entry) => entry.createdId)).toEqual(["a", "b"]);
    expect(ledger.has("a")).toBe(true);
    expect(ledger.has("c")).toBe(false);
  });
});

describe("buildCleanupArgs", () => {
  it("places the id at its pinned path", () => {
    expect(buildCleanupArgs("page_id", "p1")).toEqual({ page_id: "p1" });
    expect(buildCleanupArgs("target.page.id", "p1")).toEqual({
      target: { page: { id: "p1" } },
    });
  });
});

describe("cleanupBenchmarkArtifacts", () => {
  it("removes every ledger entry through its pinned cleanup step", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const report = await cleanupBenchmarkArtifacts({
      ledger: ledgerWith(["p1", "p2"]),
      callTool,
    });

    expect(callTool.mock.calls.map((call) => call[0])).toEqual([
      { tool: "delete_page", args: { page_id: "p1" } },
      { tool: "delete_page", args: { page_id: "p2" } },
    ]);
    expect(report).toMatchObject({
      status: "clean",
      attempted: 2,
      removed: 2,
      residue: 0,
    });
  });

  it("retries a transient failure before calling an artifact residue", async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue({ content: [] });

    const report = await cleanupBenchmarkArtifacts({
      ledger: ledgerWith(["p1"]),
      callTool,
      attempts: 3,
    });

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(report.status).toBe("clean");
  });

  it("reports residue rather than swallowing it", async () => {
    // An operator whose server is holding our leftovers is entitled to know.
    const callTool = vi.fn().mockRejectedValue(new Error("permission denied"));
    const onStepError = vi.fn();

    const report = await cleanupBenchmarkArtifacts({
      ledger: ledgerWith(["p1", "p2"]),
      callTool,
      attempts: 2,
      onStepError,
    });

    expect(report).toMatchObject({
      status: "residual",
      attempted: 2,
      removed: 0,
      residue: 2,
      residualIds: ["p1", "p2"],
    });
    expect(onStepError).toHaveBeenCalledTimes(4);
  });

  it("tries the next pinned step when the first one does not apply", async () => {
    const ledger = createBenchmarkArtifactLedger();
    ledger.record({
      tool: "create_folder",
      artifactName: "n",
      createdId: "f1",
      cleanupSteps: [
        { tool: "delete_page", idArgPath: "page_id" },
        { tool: "delete_folder", idArgPath: "folder_id" },
      ],
    });
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("no such page"))
      .mockResolvedValue({ content: [] });

    const report = await cleanupBenchmarkArtifacts({
      ledger,
      callTool,
      attempts: 1,
    });

    expect(callTool.mock.calls.map((call) => call[0].tool)).toEqual([
      "delete_page",
      "delete_folder",
    ]);
    expect(report.status).toBe("clean");
  });

  it("is a no-op for a run that created nothing", async () => {
    const callTool = vi.fn();
    const report = await cleanupBenchmarkArtifacts({
      ledger: createBenchmarkArtifactLedger(),
      callTool,
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(report).toEqual({
      status: "clean",
      attempted: 0,
      removed: 0,
      residue: 0,
      residualIds: [],
    });
  });
});
