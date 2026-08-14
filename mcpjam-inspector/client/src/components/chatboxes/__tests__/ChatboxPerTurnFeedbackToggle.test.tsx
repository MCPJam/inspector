/**
 * The per-scenario rollout switch for per-turn ratings.
 *
 * The behaviour worth pinning is the in-flight guard: the control is
 * optimistic, so two clicks racing one `pending` slot can leave the switch
 * showing one thing and the server storing another.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";

const { updateChatboxMock, toastErrorMock } = vi.hoisted(() => ({
  updateChatboxMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({ updateChatbox: updateChatboxMock }),
}));

vi.mock("@/lib/toast", () => ({ toast: { error: toastErrorMock } }));

import { ChatboxPerTurnFeedbackToggle } from "../ChatboxPerTurnFeedbackToggle";

function chatbox(enabled?: boolean): ChatboxSettings {
  return {
    chatboxId: "cbx_1",
    projectId: "proj_1",
    name: "Scenario",
    ...(enabled === undefined
      ? {}
      : { chatUi: { surfaces: { perTurnFeedback: { enabled } } } }),
  } as unknown as ChatboxSettings;
}

const toggle = () =>
  screen.getByTestId("user-testing-per-turn-feedback-toggle");

describe("ChatboxPerTurnFeedbackToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChatboxMock.mockResolvedValue(undefined);
  });

  it("reads off when the scenario has never opted in", () => {
    // The backend default is `false` and normalization defaults the whole
    // envelope, so an absent surface must read as off, not as unset-but-on.
    render(<ChatboxPerTurnFeedbackToggle chatbox={chatbox()} />);
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
  });

  it("reads off when the chat UI envelope is explicitly null", () => {
    render(
      <ChatboxPerTurnFeedbackToggle
        chatbox={{ ...chatbox(), chatUi: null } as ChatboxSettings}
      />
    );
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
  });

  it("writes only the perTurnFeedback surface", () => {
    render(<ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />);
    fireEvent.click(toggle());
    expect(updateChatboxMock).toHaveBeenCalledWith({
      chatboxId: "cbx_1",
      chatUi: { surfaces: { perTurnFeedback: { enabled: true } } },
    });
  });

  it("serializes two dispatches that land in the same tick", async () => {
    // The in-flight latch is a REF, not state: two `onCheckedChange` calls in
    // one tick both read the pre-commit `saving`, so a state check would let
    // both through and out-of-order responses could persist the opposite of
    // the last click. Fired without an intervening act() flush precisely so
    // the `disabled` attribute is not what's under test — a user click on a
    // disabled switch never reaches the handler, which would make this pass
    // even with the latch removed.
    let resolveWrite: (() => void) | undefined;
    updateChatboxMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    render(<ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />);
    const control = toggle();
    act(() => {
      control.click();
      control.click();
    });

    expect(updateChatboxMock).toHaveBeenCalledTimes(1);
    resolveWrite?.();
    await waitFor(() => expect(toggle()).not.toBeDisabled());
  });

  it("holds the optimistic value until the server's catches up", async () => {
    // `chatbox` arrives through a reactive query. Clearing the override when
    // the mutation resolves snaps the switch back to the old setting for the
    // frame or two before the update lands.
    updateChatboxMock.mockResolvedValue(undefined);
    const { rerender } = render(
      <ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />
    );

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeDisabled());

    // Mutation resolved, reactive value has NOT arrived yet.
    expect(toggle()).toHaveAttribute("data-state", "checked");

    rerender(<ChatboxPerTurnFeedbackToggle chatbox={chatbox(true)} />);
    expect(toggle()).toHaveAttribute("data-state", "checked");
  });

  it("does not carry pending state into another scenario", async () => {
    // The parent swaps the `chatbox` prop rather than remounting, so a write
    // started on one scenario must not resolve into the next one's state —
    // that would clear `saving` while the previous optimistic value stayed on
    // screen, showing the old scenario's setting for the new one.
    let resolveWrite: (() => void) | undefined;
    updateChatboxMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    const { rerender } = render(
      <ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />
    );
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("data-state", "checked");

    // Navigate to a different scenario that has the surface OFF.
    rerender(
      <ChatboxPerTurnFeedbackToggle
        chatbox={{ ...chatbox(false), chatboxId: "cbx_2" } as ChatboxSettings}
      />
    );
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
    expect(toggle()).not.toBeDisabled();

    // The first scenario's write lands late — it must not touch this one.
    resolveWrite?.();
    await waitFor(() =>
      expect(toggle()).toHaveAttribute("data-state", "unchecked")
    );
  });

  it("reverts the switch when the write fails", async () => {
    updateChatboxMock.mockRejectedValue(new Error("nope"));
    render(<ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />);

    fireEvent.click(toggle());

    await waitFor(() =>
      expect(toggle()).toHaveAttribute("data-state", "unchecked")
    );
    expect(toastErrorMock).toHaveBeenCalled();
  });
});
