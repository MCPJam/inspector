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

describe("the ledger's durable half", () => {
  // THE FINDING THESE LOCK: the ledger was a bare in-process `Map`. Nothing
  // was ever written to `/internal/v1/bench/artifacts`, so a worker that died
  // after a create call took the ids with it — and the resumed worker reported
  // a clean empty ledger while the artifacts stayed in the target's tenant.

  it("writes every recorded id through to the sink", async () => {
    const written: string[][] = [];
    const ledger = createBenchmarkArtifactLedger({
      persist: async (entries) => {
        written.push(entries.map((entry) => entry.createdId));
      },
    });

    ledger.record({
      tool: "create_page",
      artifactName: "mcpjam-benchmark-run-0-a",
      createdId: "a",
      caseId: "case-1",
      iteration: 0,
      cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
    });
    await ledger.flush();

    expect(written.flat()).toEqual(["a"]);
    expect(ledger.unpersisted()).toEqual([]);
  });

  it("does not resolve flush until the write has landed", async () => {
    let release!: () => void;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ledger = createBenchmarkArtifactLedger({
      persist: async () => {
        await landed;
      },
    });
    ledger.record({
      tool: "create_page",
      artifactName: "n",
      createdId: "a",
      cleanupSteps: [],
    });

    let flushed = false;
    void ledger.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    // The whole point: the next mutation must not be allowed to start yet.
    expect(flushed).toBe(false);

    release();
    await ledger.flush();
    expect(flushed).toBe(true);
  });

  it("names the ids a failed write left undurable, and keeps them locally", async () => {
    const ledger = createBenchmarkArtifactLedger({
      persist: async () => {
        throw new Error("convex unreachable");
      },
    });
    ledger.record({
      tool: "create_page",
      artifactName: "n",
      createdId: "a",
      cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
    });
    // Never rethrown: `flush` is awaited on the hot path, and a durable-write
    // blip must not turn into a failed tool call against the target.
    await expect(ledger.flush()).resolves.toBeUndefined();

    expect(ledger.unpersisted()).toEqual(["a"]);
    // Still cleanable by THIS process, which is the only mitigation left.
    expect(ledger.has("a")).toBe(true);
  });

  it("hydrates a resumed run's artifacts, so cleanup reconciles against them", async () => {
    const ledger = createBenchmarkArtifactLedger({
      initial: [
        {
          tool: "create_page",
          artifactName: "mcpjam-benchmark-run-0-old",
          createdId: "old",
          caseId: "case-1",
          cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
        },
      ],
    });

    // A mutation aimed at the previous attempt's artifact is OURS, and the
    // gate must be able to tell.
    expect(ledger.has("old")).toBe(true);

    const calls: string[] = [];
    const report = await cleanupBenchmarkArtifacts({
      ledger,
      callTool: async ({ args }) => {
        calls.push(String(args.page_id));
        return { content: [] };
      },
    });

    expect(calls).toEqual(["old"]);
    expect(report).toMatchObject({ status: "clean", attempted: 1, removed: 1 });
  });

  it("does not re-write a hydrated row it did not create", async () => {
    const written: string[] = [];
    const ledger = createBenchmarkArtifactLedger({
      initial: [
        { tool: "t", artifactName: "n", createdId: "old", cleanupSteps: [] },
      ],
      persist: async (entries) => {
        written.push(...entries.map((entry) => entry.createdId));
      },
    });
    await ledger.flush();
    expect(written).toEqual([]);
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

  it("counts a REFUSED delete as residue, not as a removal", async () => {
    // THE FINDING THIS LOCKS: `executeTool` resolves normally with
    // `{ isError: true }` — it does not reject — so every resolved call was
    // counted as done. A refused delete was reported as a successful cleanup:
    // the scorecard said `clean` while the artifact stayed in the operator's
    // tenant.
    const errors: string[] = [];
    const report = await cleanupBenchmarkArtifacts({
      ledger: ledgerWith(["p1"]),
      // RESOLVED, not thrown. A test that only threw would pass against the
      // defect.
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "permission denied" }],
      }),
      attempts: 2,
      onStepError: (error) =>
        errors.push(error instanceof Error ? error.message : String(error)),
    });

    expect(report).toMatchObject({
      status: "residual",
      attempted: 1,
      removed: 0,
      residue: 1,
      residualIds: ["p1"],
    });
    // Retried like any other failure before being called residue.
    expect(errors).toHaveLength(2);
  });

  it("counts a call that resolves without isError as removed", async () => {
    const report = await cleanupBenchmarkArtifacts({
      ledger: ledgerWith(["p1"]),
      callTool: async () => ({ isError: false, content: [] }),
    });
    expect(report).toMatchObject({ status: "clean", removed: 1, residue: 0 });
  });

  it("recovers when a later attempt is accepted after a refusal", async () => {
    let call = 0;
    const report = await cleanupBenchmarkArtifacts({
      ledger: ledgerWith(["p1"]),
      callTool: async () => {
        call += 1;
        return call === 1 ? { isError: true, content: [] } : { content: [] };
      },
    });
    expect(report).toMatchObject({ status: "clean", removed: 1 });
    expect(call).toBe(2);
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
