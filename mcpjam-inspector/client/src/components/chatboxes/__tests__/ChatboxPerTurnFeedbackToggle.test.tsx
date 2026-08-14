/**
 * The per-scenario rollout switch for per-turn ratings.
 *
 * The behaviour worth pinning is the in-flight guard: the control is
 * optimistic, so two clicks racing one `pending` slot can leave the switch
 * showing one thing and the server storing another.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("writes only the perTurnFeedback surface", () => {
    render(<ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />);
    fireEvent.click(toggle());
    expect(updateChatboxMock).toHaveBeenCalledWith({
      chatboxId: "cbx_1",
      chatUi: { surfaces: { perTurnFeedback: { enabled: true } } },
    });
  });

  it("ignores a second click while the first write is in flight", async () => {
    // Both clicks share one `pending` slot: the first response would clear the
    // second's optimistic value, and out-of-order writes could store the
    // opposite of the last click.
    let resolveWrite: (() => void) | undefined;
    updateChatboxMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    render(<ChatboxPerTurnFeedbackToggle chatbox={chatbox(false)} />);
    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(updateChatboxMock).toHaveBeenCalledTimes(1);
    resolveWrite?.();
    await waitFor(() => expect(toggle()).not.toBeDisabled());
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
