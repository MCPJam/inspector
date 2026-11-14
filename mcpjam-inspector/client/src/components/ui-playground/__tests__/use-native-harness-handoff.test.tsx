import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeHarnessLimitDialogStore } from "@/stores/native-harness-limit-dialog-store";
import { useNativeHarnessHandoff } from "../use-native-harness-handoff";

const REFUSAL = new Error(
  JSON.stringify({
    message:
      "This organization has used its 20 free native harness turns. Upgrade your plan to keep using them, or switch to MCPJam Harness.",
    code: "native_harness_trial_exhausted",
  }),
);

const afterSwitch = () => useNativeHarnessLimitDialogStore.getState().afterSwitch;

function renderHandoff(error: Error | undefined, started = true) {
  const startNewChat = vi.fn(async () => started);
  const setComposerInput = vi.fn();
  const view = renderHook(
    ({ error: current }: { error: Error | undefined }) =>
      useNativeHarnessHandoff({
        error: current,
        refusedText: "List my open tickets",
        startNewChat,
        setComposerInput,
      }),
    { initialProps: { error } },
  );
  return { ...view, startNewChat, setComposerInput };
}

beforeEach(() => {
  useNativeHarnessLimitDialogStore.setState({ afterSwitch: null });
});

describe("useNativeHarnessHandoff", () => {
  it("offers nothing while the last turn is not the trial's refusal", () => {
    renderHandoff(undefined);
    expect(afterSwitch()).toBeNull();
    renderHandoff(new Error("Could not reach the server."));
    expect(afterSwitch()).toBeNull();
  });

  it("starts a new chat with the refused message once the dialog switches", async () => {
    const { startNewChat, setComposerInput } = renderHandoff(REFUSAL);

    act(() => afterSwitch()?.());

    await waitFor(() =>
      expect(setComposerInput).toHaveBeenCalledWith("List my open tickets"),
    );
    expect(startNewChat).toHaveBeenCalledTimes(1);
  });

  it("leaves the composer alone when the person keeps the current chat", async () => {
    const { startNewChat, setComposerInput } = renderHandoff(REFUSAL, false);

    act(() => afterSwitch()?.());

    await waitFor(() => expect(startNewChat).toHaveBeenCalled());
    expect(setComposerInput).not.toHaveBeenCalled();
  });

  it("withdraws once the refusal is gone, and never another chat's handoff", () => {
    const { rerender, unmount } = renderHandoff(REFUSAL);
    expect(afterSwitch()).not.toBeNull();

    rerender({ error: undefined });
    expect(afterSwitch()).toBeNull();

    rerender({ error: REFUSAL });
    const other = vi.fn();
    act(() => useNativeHarnessLimitDialogStore.getState().setAfterSwitch(other));
    unmount();
    expect(afterSwitch()).toBe(other);
  });
});
