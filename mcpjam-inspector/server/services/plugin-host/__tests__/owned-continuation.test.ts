import { describe, expect, it, vi } from "vitest";
import { RequestOwnedToolInvoker } from "../request-invoker";
import {
  PluginContinuationRefused,
  PluginInvocationSuspension,
  type PluginInvocationPorts,
  type TrustedInvocationOwner,
} from "../invocation";

const owner: TrustedInvocationOwner = {
  actorId: "disposable-actor",
  projectId: "disposable-project",
  workspaceId: "disposable-workspace",
  instanceId: "disposable-instance",
  generation: 1,
  serverId: "disposable-server",
  bindingId: "disposable-binding",
  placement: "interactive",
};
const params = {
  name: "fixture",
  arguments: { intact: [false, 0] },
  _meta: { "fixture/unknown": true },
};
const suspension = (round = 1) =>
  new PluginInvocationSuspension({
    continuationId: "disposable-continuation",
    round,
    status: "input_required",
  });
function fixture() {
  let revision = "revision-1",
    live = true;
  const ports: PluginInvocationPorts = {
    authorize: vi.fn(async () => ({
      owner,
      revision,
      enabled: live,
      tool: { name: "fixture" },
      allowedOrigins: ["app" as const],
      requiresApproval: true,
    })),
    approve: vi.fn(async () => true),
    admit: vi.fn(async () => {}),
    metadata: vi.fn(async () => ({})),
    execute: vi.fn(async () => suspension()),
    classifyFailure: () => "unknown",
  };
  const observe = vi.fn();
  const invoker = new RequestOwnedToolInvoker(owner, () => {}, observe);
  const resume = (
    round: number,
    receipt: string,
    run: () => Promise<unknown> = async () => ({ content: [] }),
  ) => ({
    ...ports,
    continuation: {
      submission: {
        continuationId: "disposable-continuation",
        round,
        responsesBlobId: receipt,
      },
      resume: vi.fn(run),
    },
  });
  return {
    ports,
    invoker,
    observe,
    resume,
    revoke: () => {
      live = false;
    },
    change: () => {
      revision = "revision-2";
    },
    invoke: (p = ports, signal?: AbortSignal) =>
      invoker.invoke(p, "app", "original", params, signal),
  };
}
describe("owned invocation suspension receipts", () => {
  it("resumes two rounds with fresh ports and one original approval/admission/effect", async () => {
    const f = fixture();
    expect(await f.invoke()).toBeInstanceOf(PluginInvocationSuspension);
    const first = f.resume(1, "receipt-1", async () => suspension(2));
    const output = await f.invoke(first);
    expect(output).toBeInstanceOf(PluginInvocationSuspension);
    expect(await f.invoke(first)).toBe(output);
    const second = f.resume(2, "receipt-2");
    const final = await f.invoke(second);
    expect(await f.invoke(second)).toBe(final);
    expect(await f.invoke()).toBe(final);
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
    expect(f.ports.admit).toHaveBeenCalledTimes(1);
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
    expect(first.continuation.resume).toHaveBeenCalledTimes(1);
    expect(second.continuation.resume).toHaveBeenCalledTimes(1);
    expect(f.observe.mock.calls.map((call) => call[1])).toEqual([
      "call-started",
      "call-suspended",
      "call-continued",
      "call-suspended",
      "call-continued",
      "call-completed",
    ]);
  });
  it("rejects fabricated suspension JSON and missing/cross-round/mutated input receipts", async () => {
    const f = fixture();
    await expect(f.invoke(f.resume(1, "fake"))).rejects.toThrow(
      "RECEIPT_MISSING",
    );
    await f.invoke();
    await expect(f.invoke(f.resume(2, "wrong-round"))).rejects.toThrow(
      "DENIED",
    );
    const first = f.resume(1, "first");
    await f.invoke(first);
    await expect(f.invoke(f.resume(1, "changed"))).rejects.toThrow(
      "INPUT_REUSED",
    );
    expect(first.continuation.resume).toHaveBeenCalledTimes(1);
    const json = fixture();
    vi.mocked(json.ports.execute).mockResolvedValue(suspension().pending);
    await json.invoke();
    await expect(json.invoke(json.resume(1, "fake"))).rejects.toThrow("DENIED");
  });
  it.each(["revoke", "change"] as const)(
    "fresh %s prevents the continuation wire",
    async (mutation) => {
      const f = fixture();
      await f.invoke();
      f[mutation]();
      const next = f.resume(1, "receipt");
      await expect(f.invoke(next)).rejects.toThrow(
        mutation === "change" ? "AUTHORIZATION_CHANGED" : "DENIED",
      );
      expect(next.continuation.resume).not.toHaveBeenCalled();
    },
  );
  it("deduplicates concurrent legs and refuses changed invocation arguments", async () => {
    const f = fixture();
    await f.invoke();
    let done!: (value: unknown) => void;
    const next = f.resume(
      1,
      "receipt",
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const one = f.invoke(next),
      two = f.invoke(next);
    await vi.waitFor(() =>
      expect(next.continuation.resume).toHaveBeenCalledTimes(1),
    );
    await expect(
      f.invoker.invoke(next, "app", "original", {
        ...params,
        arguments: { changed: true },
      }),
    ).rejects.toThrow("ID_REUSED");
    done({ content: [] });
    expect(await one).toBe(await two);
  });
  it("keeps a proven pre-wire refusal retryable but never repeats an uncertain leg", async () => {
    const f = fixture();
    await f.invoke();
    const refused = f.resume(1, "receipt", async () => {
      throw new PluginContinuationRefused();
    });
    await expect(f.invoke(refused)).rejects.toThrow("REFUSED");
    const uncertain = f.resume(1, "receipt", async () => {
      throw new Error("lost wire");
    });
    await expect(f.invoke(uncertain)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    await expect(f.invoke(uncertain)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(uncertain.continuation.resume).toHaveBeenCalledTimes(1);
  });
  it("closes a resumed owner without accepting a late result or retaining request ports", async () => {
    const f = fixture();
    await f.invoke();
    let done!: (value: unknown) => void;
    const next = f.resume(
      1,
      "receipt",
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const running = f.invoke(next);
    await vi.waitFor(() =>
      expect(next.continuation.resume).toHaveBeenCalledTimes(1),
    );
    f.invoker.close();
    await expect(running).rejects.toMatchObject({ outcomeUnknown: true });
    done({ content: [] });
    await expect(f.invoke(next)).rejects.toThrow("INSTANCE_CLOSED");
  });
});
