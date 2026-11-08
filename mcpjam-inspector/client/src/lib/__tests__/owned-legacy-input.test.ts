import { afterEach, expect, it, vi } from "vitest";
import { watchOwnedLegacyInput } from "../owned-legacy-input";
import {
  __resetComposerFormStore,
  registerComposerForm,
} from "@/components/elicitation/composer-form-store";
const identity = {
  projectId: "p",
  workspaceId: "w",
  instanceId: "i",
  generation: 1,
  serverId: "s",
  invocationId: "call",
};
afterEach(() => {
  __resetComposerFormStore();
  vi.useRealTimers();
});
it("ignores every foreign binding and follows only the exact legacy operation", () => {
  const notify = vi.fn();
  const stop = watchOwnedLegacyInput(
    identity,
    new AbortController().signal,
    notify,
  );
  for (const key of Object.keys(identity)) {
    const foreign = {
      ...identity,
      [key]: key === "generation" ? 2 : "foreign",
    };
    const clear = registerComposerForm({
      id: key,
      workspaceId: "w",
      serverName: "App",
      cancel: vi.fn(),
      operation: { ...foreign, expiresAt: Date.now() + 10000 },
    });
    expect(notify).not.toHaveBeenCalled();
    clear();
  }
  const clear = registerComposerForm({
    id: "mine",
    workspaceId: "w",
    serverName: "App",
    cancel: vi.fn(),
    operation: { ...identity, expiresAt: Date.now() + 10000 },
  });
  expect(notify).toHaveBeenLastCalledWith(true);
  clear();
  expect(notify).toHaveBeenLastCalledWith(false);
  stop();
  expect(notify).toHaveBeenCalledTimes(2);
});
it.each(["expire", "abort", "dispose"])(
  "stops exact pending input on %s without reviving",
  async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const notify = vi.fn();
    const stop = watchOwnedLegacyInput(identity, controller.signal, notify);
    const clear = registerComposerForm({
      id: "mine",
      workspaceId: "w",
      serverName: "App",
      cancel: vi.fn(),
      operation: { ...identity, expiresAt: Date.now() + 1000 },
    });
    if (mode === "expire") await vi.advanceTimersByTimeAsync(1000);
    else if (mode === "abort") controller.abort();
    else stop();
    expect(notify.mock.calls).toEqual([[true], [false]]);
    clear();
    stop();
    expect(notify).toHaveBeenCalledTimes(2);
  },
);
