import { describe, expect, it, vi } from "vitest";
import type {
  HarnessV1,
  HarnessV1PromptControl,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";
import { withAutoApprovedNativeRequests } from "../auto-approve-harness.js";

const request = {
  type: "tool-approval-request",
  approvalId: "approval",
  toolCallId: "call",
} as HarnessV1StreamPart;
function fixture(beforeControl = false, failure?: Error) {
  let emit: (part: HarnessV1StreamPart) => void;
  const submitToolApproval = vi.fn(async () => {
    if (failure) throw failure;
  });
  let finish!: () => void;
  const control = {
    submitToolResult: vi.fn(async () => {}),
    submitToolApproval,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  } as HarnessV1PromptControl;
  const start = vi.fn(async (options: { emit: typeof emit }) => {
    emit = options.emit;
    if (beforeControl) emit(request);
    return control;
  });
  const session = {
    doPromptTurn: start,
    doContinueTurn: start,
    doStop: vi.fn(),
  };
  const harness = {
    doStart: vi.fn(async () => session),
  } as unknown as HarnessV1;
  return {
    harness,
    submitToolApproval,
    send: (part: HarnessV1StreamPart) => emit(part),
    finish,
    session,
  };
}
describe("native automatic approval", () => {
  it.each(["doPromptTurn", "doContinueTurn"] as const)(
    "approves and drops duplicate native requests in %s, preserving other parts",
    async (method) => {
      const f = fixture();
      const emit = vi.fn();
      const onApproval = vi.fn();
      const session = await withAutoApprovedNativeRequests(
        f.harness,
        onApproval,
      ).doStart({} as never);
      const control = await session[method]({ emit } as never);
      f.send(request);
      f.send(request);
      const part = {
        type: "text-delta",
        id: "text",
        delta: "hello",
      } as HarnessV1StreamPart;
      f.send(part);
      f.finish();
      await control.done;
      expect(f.submitToolApproval).toHaveBeenCalledExactlyOnceWith({
        approvalId: "approval",
        approved: true,
      });
      expect(emit.mock.calls).toEqual([[part]]);
      expect(onApproval).toHaveBeenCalledExactlyOnceWith("approval");
    },
  );
  it("queues requests emitted before control is returned", async () => {
    const f = fixture(true);
    const emit = vi.fn();
    const session = await withAutoApprovedNativeRequests(f.harness).doStart(
      {} as never,
    );
    const control = await session.doPromptTurn({ emit } as never);
    f.finish();
    await control.done;
    expect(f.submitToolApproval).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });
  it("propagates approval submission errors through done", async () => {
    const f = fixture(true, new Error("bridge unavailable"));
    const session = await withAutoApprovedNativeRequests(f.harness).doStart(
      {} as never,
    );
    const control = await session.doPromptTurn({ emit: vi.fn() } as never);
    await expect(control.done).rejects.toThrow("bridge unavailable");
  });
  it("leaves an already pending decision to the user's continuation", async () => {
    const f = fixture(true);
    const emit = vi.fn();
    const session = await withAutoApprovedNativeRequests(
      f.harness,
      undefined,
      new Set(["approval"]),
    ).doStart({} as never);
    const control = await session.doContinueTurn({ emit } as never);
    f.finish();
    await control.done;
    expect(emit).toHaveBeenCalledExactlyOnceWith(request);
    expect(f.submitToolApproval).not.toHaveBeenCalled();
  });
});
