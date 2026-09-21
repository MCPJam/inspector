import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  releaseBrowserForChat,
  useBrowserChatHandoff,
  runBrowserCommandWithHandoff,
} from "../chat-handoff";

it("retains background commands across renderer mounts and panel closure", async () => {
  const release = vi.fn(async () => {});
  await runBrowserCommandWithHandoff({
    projectId: "background",
    sessionId: "b",
    send: async () => {},
    release,
  });
  const view = renderHook(() =>
    useBrowserChatHandoff({
      projectId: "background",
      sessionId: "b",
      holding: false,
      release: async () => true,
    }),
  );
  view.unmount();
  await releaseBrowserForChat("background", "b");
  await releaseBrowserForChat("background", "b");
  expect(release).toHaveBeenCalledOnce();
});

it("shares concurrent background handoffs even when the command response is lost", async () => {
  const release = vi.fn(async () => {});
  await expect(
    runBrowserCommandWithHandoff({
      projectId: "lost-response",
      sessionId: "b",
      send: async () => {
        throw new Error("offline");
      },
      release,
    }),
  ).rejects.toThrow("offline");
  await Promise.all([
    releaseBrowserForChat("lost-response", "b"),
    releaseBrowserForChat("lost-response", "b"),
  ]);
  expect(release).toHaveBeenCalledOnce();
});

it("awaits handoff only for the matching conversation", async () => {
  let finish!: (ok: boolean) => void;
  const release = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() =>
    useBrowserChatHandoff({
      projectId: "p1",
      sessionId: "a",
      holding: true,
      release,
    }),
  );
  await releaseBrowserForChat("p1", "b");
  await releaseBrowserForChat("p2", "a");
  expect(release).not.toHaveBeenCalled();
  let sent = false;
  const send = releaseBrowserForChat("p1", "a").then(() => {
    sent = true;
  });
  expect(release).toHaveBeenCalledOnce();
  expect(sent).toBe(false);
  finish(true);
  await send;
  expect(sent).toBe(true);
  view.unmount();
});

it("keeps a closed pane's held browser available for automatic handoff", async () => {
  const release = vi.fn(async () => true);
  const view = renderHook(() =>
    useBrowserChatHandoff({
      projectId: "closed",
      sessionId: "a",
      holding: true,
      release,
    }),
  );
  view.unmount();
  await releaseBrowserForChat("closed", "a");
  await releaseBrowserForChat("closed", "a");
  expect(release).toHaveBeenCalledOnce();
});

it("fails the preflight when release fails, allowing a retry", async () => {
  const release = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const view = renderHook(() =>
    useBrowserChatHandoff({
      projectId: "failed",
      sessionId: "a",
      holding: true,
      release,
    }),
  );
  await expect(releaseBrowserForChat("failed", "a")).rejects.toThrow(
    "Couldn't return browser control",
  );
  await releaseBrowserForChat("failed", "a");
  expect(release).toHaveBeenCalledTimes(2);
  view.unmount();
});

it("leaves another holder alone", async () => {
  const release = vi.fn(async () => true);
  const view = renderHook(() =>
    useBrowserChatHandoff({
      projectId: "other",
      sessionId: "a",
      holding: false,
      release,
    }),
  );
  await act(async () => releaseBrowserForChat("other", "a"));
  expect(release).not.toHaveBeenCalled();
  view.unmount();
});

it("retains the old conversation's release without letting it update the new pane", async () => {
  const currentChecks: boolean[] = [];
  const release = vi.fn(async (isCurrent: () => boolean) => {
    currentChecks.push(isCurrent());
    return true;
  });
  const view = renderHook(
    ({ sessionId }) =>
      useBrowserChatHandoff({
        projectId: "switch",
        sessionId,
        holding: true,
        release,
      }),
    { initialProps: { sessionId: "a" } },
  );
  view.rerender({ sessionId: "b" });
  await releaseBrowserForChat("switch", "a");
  await releaseBrowserForChat("switch", "b");
  expect(currentChecks).toEqual([false, true]);
  view.unmount();
});

it("retries a failed release after the pane has closed", async () => {
  const release = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(true);
  const view = renderHook(() =>
    useBrowserChatHandoff({
      projectId: "offline",
      sessionId: "a",
      holding: true,
      release,
    }),
  );
  view.unmount();
  await expect(releaseBrowserForChat("offline", "a")).rejects.toThrow(
    "Offline",
  );
  await expect(releaseBrowserForChat("offline", "a")).resolves.toBeUndefined();
  await releaseBrowserForChat("offline", "a");
  expect(release).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "shares concurrent releases and allows retry after failure: %s",
  async (succeeds) => {
    let finish!: (ok: boolean) => void;
    const release = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderHook(() =>
      useBrowserChatHandoff({
        projectId: `concurrent-${succeeds}`,
        sessionId: "a",
        holding: true,
        release,
      }),
    );
    const first = releaseBrowserForChat(`concurrent-${succeeds}`, "a");
    const second = releaseBrowserForChat(`concurrent-${succeeds}`, "a");
    expect(release).toHaveBeenCalledOnce();
    const outcomes = Promise.allSettled([first, second]);
    finish(succeeds);
    expect((await outcomes).map((result) => result.status)).toEqual(
      succeeds ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"],
    );
    if (!succeeds) {
      const retry = releaseBrowserForChat(`concurrent-${succeeds}`, "a");
      expect(release).toHaveBeenCalledTimes(2);
      finish(true);
      await retry;
    }
    view.unmount();
  },
);
