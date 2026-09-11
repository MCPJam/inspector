import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversationTargetRestoration } from "../use-conversation-target-restoration";

function setup() {
  return {
    projectId: "project-1",
    composer: { kind: "host" as const, hostId: "current" },
    settled: true,
    hostsLoading: false,
    hostIds: ["current", "saved"],
    environmentsEnabled: true,
    selectHost: vi.fn(),
    selectEnvironment: vi.fn(),
    clearEnvironment: vi.fn(),
  };
}

describe("conversation target restoration", () => {
  it("waits for the selected host's scope reset before allowing transcript hydration", async () => {
    const props = setup();
    const { result, rerender } = renderHook(useConversationTargetRestoration, {
      initialProps: props,
    });
    const hydrated = vi.fn();
    act(() => {
      void result.current
        .restoreTarget({ kind: "host", hostId: "saved" }, () => true)
        .then(hydrated);
    });
    expect(props.selectHost).toHaveBeenCalledWith("saved");
    expect(hydrated).not.toHaveBeenCalled();
    rerender({
      ...props,
      composer: { kind: "host", hostId: "saved" },
      settled: false,
    });
    expect(hydrated).not.toHaveBeenCalled();
    rerender({
      ...props,
      composer: { kind: "host", hostId: "saved" },
      settled: true,
    });
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(true));
  });

  it("waits for the host list, and leaves an unavailable target for the disclosure", async () => {
    const props = { ...setup(), hostsLoading: true, hostIds: [] };
    const { result, rerender } = renderHook(useConversationTargetRestoration, {
      initialProps: props,
    });
    const hydrated = vi.fn();
    act(() => {
      void result.current
        .restoreTarget({ kind: "host", hostId: "deleted" }, () => true)
        .then(hydrated);
    });
    expect(hydrated).not.toHaveBeenCalled();
    rerender({ ...props, hostsLoading: false });
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(true));
    expect(props.selectHost).not.toHaveBeenCalled();
  });

  it("cancels a superseded restore and a restore after switching projects", async () => {
    const props = setup();
    const { result, rerender } = renderHook(useConversationTargetRestoration, {
      initialProps: props,
    });
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      void result.current
        .restoreTarget({ kind: "host", hostId: "saved" }, () => true)
        .then(first);
    });
    act(() => {
      void result.current
        .restoreTarget(
          { kind: "environment", environmentId: "env" },
          () => true,
        )
        .then(second);
    });
    await waitFor(() => expect(first).toHaveBeenCalledWith(false));
    rerender({ ...props, projectId: "project-2" });
    await waitFor(() => expect(second).toHaveBeenCalledWith(false));
  });

  it("selects the environment through its existing resolver", async () => {
    const props = setup();
    const { result, rerender } = renderHook(
      (input: Parameters<typeof useConversationTargetRestoration>[0]) =>
        useConversationTargetRestoration(input),
      { initialProps: props },
    );
    const hydrated = vi.fn();
    act(() => {
      void result.current
        .restoreTarget(
          { kind: "environment", environmentId: "env" },
          () => true,
        )
        .then(hydrated);
    });
    expect(props.selectEnvironment).toHaveBeenCalledWith("env");
    rerender({
      ...props,
      composer: { kind: "environment", environmentId: "env" },
      settled: false,
    });
    expect(hydrated).not.toHaveBeenCalled();
    rerender({
      ...props,
      composer: { kind: "environment", environmentId: "env" },
      settled: true,
    });
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(true));
  });

  it("clears both selectors for an explicit ad-hoc run", async () => {
    const props = setup();
    const { result, rerender } = renderHook(
      (input: Parameters<typeof useConversationTargetRestoration>[0]) =>
        useConversationTargetRestoration(input),
      { initialProps: props },
    );
    const hydrated = vi.fn();
    act(() => {
      void result.current
        .restoreTarget({ kind: "adhoc" }, () => true)
        .then(hydrated);
    });
    expect(props.clearEnvironment).toHaveBeenCalled();
    expect(props.selectHost).toHaveBeenCalledWith(null);
    rerender({ ...props, composer: { kind: "host", hostId: null } });
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(true));
  });

  it("does not guess for legacy rows and cancels on unmount", async () => {
    const { result, unmount } = renderHook(useConversationTargetRestoration, {
      initialProps: setup(),
    });
    await expect(
      result.current.restoreTarget({ kind: "unrecorded" }, () => true),
    ).resolves.toBe(true);
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.restoreTarget(
        { kind: "host", hostId: "saved" },
        () => true,
      );
    });
    unmount();
    await expect(pending).resolves.toBe(false);
  });
});
