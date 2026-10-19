import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ onboarding: vi.fn(), toastError: vi.fn() }));
vi.mock("../thread-app-api", () => ({ createThreadAppApi: () => f }));
vi.mock("@/lib/toast", () => ({ toast: { error: f.toastError } }));
import { usePluginOnboarding } from "../use-plugin-onboarding";
const scope = {
  projectId: "p",
  hostId: "h",
  threadId: "t",
  pluginWorkspace: { version: 1 as const, workspaceId: "w" },
};
const spec = {
  pluginId: "p",
  pluginVersionId: "v",
  name: "Fixture",
  bundleHash: "hash",
  onboarding: {
    componentId: "c",
    modelRef: "p/setup",
    materializedSkillId: "s",
  },
  skill: {
    skillId: "s",
    name: "setup",
    description: "fixture",
    content: "Safe disposable setup",
    contentHash: "content",
  },
  files: [],
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  f.onboarding.mockResolvedValue({ available: true, spec });
});
describe("explicit onboarding action", () => {
  it.each(["current", "new"] as const)(
    "runs once only after explicit %s selection",
    async (conversation) => {
      const run = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        usePluginOnboarding(scope, ["server"], run),
      );
      await waitFor(() => expect(result.current.menu("server")).not.toBeNull());
      expect(run).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.all([
          result.current.start("server", conversation),
          result.current.start("server", conversation),
        ]);
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(
        spec,
        conversation,
        expect.any(AbortSignal),
        "server",
      );
    },
  );
  it("does not dispatch a late read after unmount", async () => {
    let finish!: (value: unknown) => void;
    f.onboarding.mockImplementation((_id, content) =>
      content
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ available: true }),
    );
    const run = vi.fn();
    const { result, unmount } = renderHook(() =>
      usePluginOnboarding(scope, ["server"], run),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.start("server", "current");
    });
    unmount();
    await act(async () => {
      finish({ available: true, spec });
      await pending;
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("never runs unsupported forms of onboarding", async () => {
    f.onboarding.mockResolvedValue({ available: false });
    const run = vi.fn();
    const { result } = renderHook(() =>
      usePluginOnboarding(scope, ["server"], run),
    );
    await act(async () => {
      await result.current.start("server", "current");
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
    // Nothing else shows the hook's error, so it is said on screen.
    expect(f.toastError).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed run to say why itself", async () => {
    const run = vi.fn().mockRejectedValue(new Error("refused"));
    const { result } = renderHook(() =>
      usePluginOnboarding(scope, ["server"], run),
    );
    await act(async () => {
      await result.current.start("server", "current");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeTruthy();
    expect(f.toastError).not.toHaveBeenCalled();
  });
});

describe("onboarding requested from the import dialog", () => {
  it("runs once when one of the plugin's servers offers onboarding here", async () => {
    const { usePluginOnboardingIntentStore } = await import(
      "@/lib/plugin-onboarding-intent"
    );
    const store = usePluginOnboardingIntentStore.getState();
    store.clear();
    store.request({
      projectId: "p",
      serverIds: ["other", "server"],
      pluginId: "plugin",
      pluginName: "Fixture",
      conversation: "new",
    });
    const run = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(() =>
      usePluginOnboarding(scope, ["server"], run),
    );
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith(
      spec,
      "new",
      expect.any(AbortSignal),
      "server",
    );
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
    rerender();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a request that arrives during another run, and starts it after", async () => {
    const { usePluginOnboardingIntentStore } =
      await import("@/lib/plugin-onboarding-intent");
    usePluginOnboardingIntentStore.getState().clear();
    let finish!: () => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePluginOnboarding(scope, ["server"], run),
    );
    await waitFor(() => expect(result.current.menu("server")).not.toBeNull());
    let first!: Promise<void>;
    act(() => {
      first = result.current.start("server", "current");
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    act(() => {
      usePluginOnboardingIntentStore.getState().request({
        projectId: "p",
        serverIds: ["server"],
        pluginId: "plugin",
        pluginName: "Fixture",
        conversation: "new",
      });
    });
    expect(usePluginOnboardingIntentStore.getState().intent).not.toBeNull();
    await act(async () => {
      finish();
      await first;
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(
      spec,
      "new",
      expect.any(AbortSignal),
      "server",
    );
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
  });

  it("runs a plugin with no server once its own onboarding is available", async () => {
    const { usePluginOnboardingIntentStore } =
      await import("@/lib/plugin-onboarding-intent");
    usePluginOnboardingIntentStore.getState().clear();
    usePluginOnboardingIntentStore.getState().request({
      projectId: "p",
      serverIds: [],
      pluginId: "plugin",
      pluginName: "Fixture",
      conversation: "new",
    });
    const run = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePluginOnboarding(scope, [], run));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(f.onboarding.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [{ pluginId: "plugin" }, false],
      [{ pluginId: "plugin" }, true],
    ]);
    expect(run).toHaveBeenCalledWith(spec, "new", expect.any(AbortSignal), {
      pluginId: "plugin",
    });
    expect(usePluginOnboardingIntentStore.getState().intent).toBeNull();
  });

  it("asks a plugin with servers through them, never by plugin", async () => {
    const { usePluginOnboardingIntentStore } =
      await import("@/lib/plugin-onboarding-intent");
    usePluginOnboardingIntentStore.getState().clear();
    usePluginOnboardingIntentStore.getState().request({
      projectId: "p",
      serverIds: ["elsewhere"],
      pluginId: "plugin",
      pluginName: "Fixture",
      conversation: "new",
    });
    const run = vi.fn();
    renderHook(() => usePluginOnboarding(scope, [], run));
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.onboarding).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    usePluginOnboardingIntentStore.getState().clear();
  });

  it("ignores a request for another project", async () => {
    const { usePluginOnboardingIntentStore } = await import(
      "@/lib/plugin-onboarding-intent"
    );
    usePluginOnboardingIntentStore.getState().clear();
    usePluginOnboardingIntentStore.getState().request({
      projectId: "elsewhere",
      serverIds: ["server"],
      pluginId: "plugin",
      pluginName: "Fixture",
      conversation: "new",
    });
    const run = vi.fn();
    const { result } = renderHook(() =>
      usePluginOnboarding(scope, ["server"], run),
    );
    await waitFor(() => expect(result.current.menu("server")).not.toBeNull());
    expect(run).not.toHaveBeenCalled();
    expect(usePluginOnboardingIntentStore.getState().intent).not.toBeNull();
    usePluginOnboardingIntentStore.getState().clear();
  });
});
