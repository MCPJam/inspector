import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHostedMrtrStore, type HostedMrtrRound } from "../hosted-mrtr-store";
import type { MrtrElicitationResponse } from "@/shared/mrtr-continuation";

function round(overrides: Partial<HostedMrtrRound> = {}): HostedMrtrRound {
  const continuationId = overrides.continuationId ?? "cont-1";
  const roundNumber = overrides.round ?? 0;
  return {
    key: `${continuationId}:${roundNumber}`,
    continuationId,
    round: roundNumber,
    serverId: "srv-1",
    serverName: "GitHub",
    method: "tools/call",
    operationLabel: "create_issue",
    requests: [
      {
        key: "branch",
        mode: "form",
        message: "Pick a branch",
        requestedSchema: { type: "object", properties: {} },
      },
    ],
    expiresAt: Date.now() + 300_000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const accept: Record<string, MrtrElicitationResponse> = {
  branch: { action: "accept", content: { branch: "main" } },
};

describe("hosted MRTR store", () => {
  beforeEach(() => {
    useHostedMrtrStore.getState().__reset();
  });

  it("queues a round and submits its answers through that round's own transport", async () => {
    // The submit path is per-round because a chat round resumes by re-driving a
    // turn while a direct op resumes over /api/web/mrtr/resume.
    const submit = vi.fn();
    useHostedMrtrStore.getState().enqueue(round(), { submit });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(1);

    await useHostedMrtrStore.getState().submit("cont-1:0", accept);

    expect(submit).toHaveBeenCalledWith(accept);
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("ignores a re-delivered round key", async () => {
    // A retried/replayed data part must not stack a second dialog over one
    // suspended operation.
    const first = vi.fn();
    const second = vi.fn();
    useHostedMrtrStore.getState().enqueue(round(), { submit: first });
    useHostedMrtrStore.getState().enqueue(round(), { submit: second });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(1);

    await useHostedMrtrStore.getState().submit("cont-1:0", accept);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("replaces the previous round of the same continuation", () => {
    useHostedMrtrStore.getState().enqueue(round(), { submit: vi.fn() });
    useHostedMrtrStore.getState().setCollection("cont-1:0", 1, accept);
    useHostedMrtrStore.getState().enqueue(round({ round: 1 }), {
      submit: vi.fn(),
    });

    const state = useHostedMrtrStore.getState();
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]?.round).toBe(1);
    // Answers belong to the round they were collected for — never carried over.
    expect(state.collection).toBeNull();
  });

  it("queues distinct continuations behind each other", () => {
    useHostedMrtrStore.getState().enqueue(round(), { submit: vi.fn() });
    useHostedMrtrStore
      .getState()
      .enqueue(round({ continuationId: "cont-2" }), { submit: vi.fn() });

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(2);
  });

  it("keeps the round mounted when its submit fails", async () => {
    // The continuation is still pending server-side; dropping the dialog would
    // strand it with no way to retry.
    const submit = vi.fn(async () => {
      throw new Error("network down");
    });
    useHostedMrtrStore.getState().enqueue(round(), { submit });

    await expect(
      useHostedMrtrStore.getState().submit("cont-1:0", accept),
    ).rejects.toThrow("network down");

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(1);
    expect(useHostedMrtrStore.getState().responding).toBe(false);
  });

  it("closes the dialog on cancel even when the withdrawal request fails", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("offline");
    });
    useHostedMrtrStore.getState().enqueue(round(), { submit: vi.fn(), cancel });

    await expect(
      useHostedMrtrStore.getState().cancel("cont-1:0"),
    ).rejects.toThrow("offline");

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });

  it("drops every round of a continuation the server resolved", () => {
    useHostedMrtrStore.getState().enqueue(round(), { submit: vi.fn() });
    useHostedMrtrStore
      .getState()
      .enqueue(round({ continuationId: "cont-2" }), { submit: vi.fn() });

    useHostedMrtrStore.getState().resolveContinuation("cont-1");

    const rounds = useHostedMrtrStore.getState().rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.continuationId).toBe("cont-2");
  });

  it("no-ops a submit for a round that was dropped underneath the dialog", async () => {
    useHostedMrtrStore.getState().enqueue(round(), { submit: vi.fn() });
    useHostedMrtrStore.getState().resolveContinuation("cont-1");

    await expect(
      useHostedMrtrStore.getState().submit("cont-1:0", accept),
    ).resolves.toBeUndefined();
  });

  it("clear() empties the rail without invoking any transport", async () => {
    const cancel = vi.fn();
    useHostedMrtrStore.getState().enqueue(round(), { submit: vi.fn(), cancel });

    useHostedMrtrStore.getState().clear();

    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
    // Handlers are dropped with the rounds, so a late submit cannot resurrect
    // a cleared round.
    await useHostedMrtrStore.getState().submit("cont-1:0", accept);
    expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
  });
});
