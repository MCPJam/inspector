import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostedMrtrTerminalError,
  driveHostedDirectMrtr,
  isHostedDirectMrtrPending,
  webPostWithMrtr,
  type HostedDirectMrtrPending,
} from "../mrtr-api";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
import { executeHostedTool } from "../tools-api";

const mocks = vi.hoisted(() => ({
  webPost: vi.fn(),
}));

vi.mock("../base", async () => {
  const actual = await vi.importActual<typeof import("../base")>("../base");
  return { ...actual, webPost: mocks.webPost };
});

vi.mock("../context", () => ({
  buildServerRequest: (serverNameOrId: string) => ({
    serverId: serverNameOrId,
  }),
}));

function pending(
  overrides: Partial<HostedDirectMrtrPending> = {}
): HostedDirectMrtrPending {
  return {
    status: "input_required",
    continuationId: "cont-1",
    version: 1,
    serverId: "srv-1",
    serverName: "GitHub",
    method: "tools/call",
    operationLabel: "create_issue",
    round: 0,
    inputRequests: [
      {
        key: "branch",
        mode: "form",
        message: "Pick a branch",
        requestedSchema: { type: "object", properties: {} },
      },
    ],
    expiresAt: Date.now() + 300_000,
    negotiatedEra: "2026-07-28",
    ...overrides,
  };
}

/** Answer whatever round is currently on the rail. */
async function answerActiveRound(): Promise<void> {
  const active = useHostedMrtrStore.getState().rounds[0];
  if (!active) throw new Error("expected a queued MRTR round");
  await useHostedMrtrStore.getState().submit(active.key, {
    branch: { action: "accept", content: { branch: "main" } },
  });
}

/** Wait for a round to land on the rail (the driver queues it asynchronously). */
async function waitForRound(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (useHostedMrtrStore.getState().rounds.length > 0) return;
    await Promise.resolve();
  }
  throw new Error("no MRTR round was queued");
}

describe("hosted MRTR direct-op client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHostedMrtrStore.getState().__reset();
  });

  it("carries the hostedMrtrVersion handshake on a hosted direct request", async () => {
    // Without it the server never registers the suspending collector, so a
    // modern `input_required` tool would fail closed instead of prompting.
    mocks.webPost.mockResolvedValue({ status: "completed", result: { ok: 1 } });

    await executeHostedTool({
      serverNameOrId: "srv-1",
      toolName: "create_issue",
      parameters: {},
    });

    expect(mocks.webPost).toHaveBeenCalledWith(
      "/api/web/tools/execute",
      expect.objectContaining({ hostedMrtrVersion: 1 })
    );
  });

  it("returns a completed direct result untouched", async () => {
    mocks.webPost.mockResolvedValue({ status: "completed", result: { ok: 1 } });

    await expect(
      executeHostedTool({
        serverNameOrId: "srv-1",
        toolName: "create_issue",
        parameters: {},
      })
    ).resolves.toEqual({ status: "completed", result: { ok: 1 } });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("renders the round, resumes with the ElicitResult, and completes", async () => {
    mocks.webPost.mockResolvedValueOnce(pending()).mockResolvedValueOnce({
      ok: true,
      outcome: "completed",
      result: { content: [{ type: "text", text: "created" }] },
    });

    const call = webPostWithMrtr(
      "/api/web/tools/execute",
      { toolName: "create_issue" },
      {
        serverNameOrId: "srv-1",
        wrapResult: (result) => ({ status: "completed", result }),
      }
    );

    await waitForRound();
    expect(useHostedMrtrStore.getState().rounds[0]).toMatchObject({
      continuationId: "cont-1",
      round: 0,
      serverId: "srv-1",
    });

    await answerActiveRound();

    await expect(call).resolves.toEqual({
      status: "completed",
      result: { content: [{ type: "text", text: "created" }] },
    });
    expect(mocks.webPost).toHaveBeenLastCalledWith("/api/web/mrtr/resume", {
      serverId: "srv-1",
      continuationId: "cont-1",
      round: 0,
      responses: { branch: { action: "accept", content: { branch: "main" } } },
      negotiatedEra: "2026-07-28",
    });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("advances to a further round before completing", async () => {
    mocks.webPost
      .mockResolvedValueOnce({
        ok: true,
        outcome: "input_required",
        round: 1,
        displays: [{ key: "confirm", mode: "form", message: "Confirm?" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        outcome: "completed",
        result: "done",
      });

    const call = driveHostedDirectMrtr(pending(), { serverNameOrId: "srv-1" });

    await waitForRound();
    await answerActiveRound();

    await waitForRound();
    expect(useHostedMrtrStore.getState().rounds[0]).toMatchObject({ round: 1 });
    await answerActiveRound();

    await expect(call).resolves.toBe("done");
    expect(mocks.webPost).toHaveBeenLastCalledWith(
      "/api/web/mrtr/resume",
      expect.objectContaining({ round: 1 })
    );
  });

  it("fails fast on a version this bundle does not speak", async () => {
    // A half-understood multi-step protocol is worse than none: withdraw the
    // continuation instead of rendering a round we could never resume.
    mocks.webPost.mockResolvedValue({
      ok: true,
      continuationStatus: "cancelled",
    });

    await expect(
      driveHostedDirectMrtr(pending({ version: 99 }), {
        serverNameOrId: "srv-1",
      })
    ).rejects.toThrow(HostedMrtrTerminalError);

    expect(mocks.webPost).toHaveBeenCalledWith("/api/web/mrtr/cancel", {
      continuationId: "cont-1",
      reason: "client version mismatch",
    });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("withdraws the continuation when the user cancels the round", async () => {
    mocks.webPost.mockResolvedValue({
      ok: true,
      continuationStatus: "cancelled",
    });

    const call = driveHostedDirectMrtr(pending(), { serverNameOrId: "srv-1" });
    await waitForRound();

    const key = useHostedMrtrStore.getState().rounds[0]!.key;
    await useHostedMrtrStore.getState().cancel(key);

    await expect(call).rejects.toMatchObject({ outcome: "cancelled" });
    expect(mocks.webPost).toHaveBeenCalledWith("/api/web/mrtr/cancel", {
      continuationId: "cont-1",
      reason: "cancelled by user",
    });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("surfaces a terminal outcome and clears the rail", async () => {
    mocks.webPost.mockResolvedValueOnce({
      ok: true,
      outcome: "indeterminate",
      reason: "the operation may or may not have run",
    });

    const call = driveHostedDirectMrtr(pending(), { serverNameOrId: "srv-1" });
    await waitForRound();
    await answerActiveRound();

    await expect(call).rejects.toMatchObject({
      outcome: "indeterminate",
      continuationId: "cont-1",
    });
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("rejects a malformed pending envelope as a normal result", () => {
    expect(isHostedDirectMrtrPending({ status: "input_required" })).toBe(false);
    expect(isHostedDirectMrtrPending({ ...pending(), inputRequests: [] })).toBe(
      false
    );
    expect(isHostedDirectMrtrPending({ status: "completed" })).toBe(false);
  });
});
