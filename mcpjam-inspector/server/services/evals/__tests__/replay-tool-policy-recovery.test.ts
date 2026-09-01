import { describe, expect, it, vi } from "vitest";
import {
  ReplayToolPolicyUnrecoverableError,
  recoverToolPolicyFromSourceRun,
} from "../replay-tool-policy.js";

// =============================================================================
// A replay is NOT recorded playback: `buildReplayManager` re-dials the source
// run's `url` with its stored `accessToken`/`refreshToken`. A replay that loses
// the tool policy therefore performs, for real, the destructive calls the
// source run refused. These cases pin the three outcomes that decision has.
// =============================================================================

function clientReturning(pages: Array<Record<string, unknown>>) {
  const query = vi.fn();
  for (const page of pages) query.mockResolvedValueOnce(page);
  return { query } as unknown as Parameters<
    typeof recoverToolPolicyFromSourceRun
  >[0]["convexClient"] & { query: ReturnType<typeof vi.fn> };
}

describe("recoverToolPolicyFromSourceRun", () => {
  it("recovers the policy the source run executed under", async () => {
    const convexClient = clientReturning([
      {
        page: [
          { metadata: { policyBlockCount: 1 } },
          { metadata: { toolPolicy: { mode: "readOnly", deny: ["write"] } } },
        ],
        isDone: true,
      },
    ]);

    await expect(
      recoverToolPolicyFromSourceRun({ convexClient, sourceRunId: "run-1" })
    ).resolves.toEqual({ mode: "readOnly", deny: ["write"] });
  });

  it("returns undefined for a run that never carried a policy", async () => {
    const convexClient = clientReturning([
      { page: [{ metadata: { stageResults: [] } }], isDone: true },
    ]);

    await expect(
      recoverToolPolicyFromSourceRun({ convexClient, sourceRunId: "run-1" })
    ).resolves.toBeUndefined();
  });

  it("refuses when the source shows policy activity but no recoverable snapshot", async () => {
    // A run recorded before the snapshot existed. Guessing "no policy" is the
    // one answer that cannot be safe, so the replay aborts instead.
    const convexClient = clientReturning([
      { page: [{ metadata: { policyBlockCount: 2 } }], isDone: true },
    ]);

    await expect(
      recoverToolPolicyFromSourceRun({ convexClient, sourceRunId: "run-9" })
    ).rejects.toBeInstanceOf(ReplayToolPolicyUnrecoverableError);
  });

  it("refuses on a snapshot that does not validate rather than re-applying it", async () => {
    const convexClient = clientReturning([
      { page: [{ metadata: { toolPolicy: { mode: "banana" } } }], isDone: true },
    ]);

    await expect(
      recoverToolPolicyFromSourceRun({ convexClient, sourceRunId: "run-3" })
    ).rejects.toBeInstanceOf(ReplayToolPolicyUnrecoverableError);
  });

  it("walks pages until the snapshot is found", async () => {
    const convexClient = clientReturning([
      { page: [{ metadata: {} }], isDone: false, continueCursor: "c1" },
      {
        page: [{ metadata: { toolPolicy: { mode: "default" } } }],
        isDone: true,
      },
    ]);

    await expect(
      recoverToolPolicyFromSourceRun({ convexClient, sourceRunId: "run-4" })
    ).resolves.toEqual({ mode: "default" });
    expect((convexClient as any).query).toHaveBeenCalledTimes(2);
    expect((convexClient as any).query.mock.calls[1][1].paginationOpts.cursor).toBe(
      "c1"
    );
  });
});
