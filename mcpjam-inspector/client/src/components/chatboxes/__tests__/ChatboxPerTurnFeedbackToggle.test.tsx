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

  it("keeps a scenario's pending write out of the next scenario's state", () => {
    // The parent mounts this KEYED on chatboxId, so a scenario switch is a
    // remount, not reused state. Rendered with the same key React would use,
    // so a late-resolving write from the first scenario lands on a dead
    // instance instead of the live one.
    let resolveWrite: (() => void) | undefined;
    updateChatboxMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    const { rerender } = render(
      <ChatboxPerTurnFeedbackToggle key="cbx_1" chatbox={chatbox(false)} />
    );
    fireEvent.click(toggle());
    expect(updateChatboxMock).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute("data-state", "checked");
    expect(toggle()).toBeDisabled();

    rerender(
      <ChatboxPerTurnFeedbackToggle
        key="cbx_2"
        chatbox={{ ...chatbox(false), chatboxId: "cbx_2" } as ChatboxSettings}
      />
    );

    // Fresh instance: no optimistic value, not disabled by the other write.
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
    expect(toggle()).not.toBeDisabled();

    if (!resolveWrite) throw new Error("expected a pending write to resolve");
    resolveWrite();
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

describe("ChatboxPerTurnFeedbackToggle — widget style", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChatboxMock.mockResolvedValue(undefined);
  });

  const styled = (perTurnFeedback: Record<string, unknown>): ChatboxSettings =>
    ({
      chatboxId: "cbx_1",
      projectId: "proj_1",
      name: "Scenario",
      chatUi: { surfaces: { perTurnFeedback } },
    } as unknown as ChatboxSettings);

  const stylePicker = () =>
    screen.queryByTestId("user-testing-per-turn-feedback-style");
  const styleButton = (style: "stars" | "thumbs") =>
    screen.getByTestId(`user-testing-per-turn-feedback-style-${style}`);

  it("is hidden while the surface is off", () => {
    // A widget style is a question about a widget nobody is being shown.
    render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: false })} />
    );
    expect(stylePicker()).toBeNull();
  });

  it("defaults to stars for a scenario that predates the style field", () => {
    render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: true })} />
    );
    expect(styleButton("stars")).toHaveAttribute("aria-checked", "true");
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a stored thumbs style", () => {
    render(
      <ChatboxPerTurnFeedbackToggle
        chatbox={styled({ enabled: true, style: "thumbs" })}
      />
    );
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");
  });

  it("writes ONLY the style — the backend merge preserves enabled", () => {
    // Restating `enabled` here would be the style control asserting a rollout
    // decision it is not making, and would race a toggle write.
    render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: true })} />
    );

    fireEvent.click(styleButton("thumbs"));

    expect(updateChatboxMock).toHaveBeenCalledWith({
      chatboxId: "cbx_1",
      chatUi: { surfaces: { perTurnFeedback: { style: "thumbs" } } },
    });
  });

  it("does not write when the chosen style is already active", () => {
    render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: true })} />
    );
    fireEvent.click(styleButton("stars"));
    expect(updateChatboxMock).not.toHaveBeenCalled();
  });

  it("reverts to the stored style when the write fails", async () => {
    updateChatboxMock.mockRejectedValue(new Error("nope"));
    render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: true })} />
    );

    fireEvent.click(styleButton("thumbs"));

    await waitFor(() =>
      expect(styleButton("stars")).toHaveAttribute("aria-checked", "true")
    );
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it("holds the style override until the SERVER's style catches up", async () => {
    // The two optimistic values live in one object with a PER-FIELD standdown.
    // `chatbox` arrives through a reactive query that re-renders for reasons
    // that have nothing to do with this control; a shared "clear on any
    // resolve" rule would snap the segmented control back to the old style for
    // the frames before the write lands.
    let resolveWrite: (() => void) | undefined;
    updateChatboxMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    const { rerender } = render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: true })} />
    );

    fireEvent.click(styleButton("thumbs"));
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");

    // A reactive re-render arrives still carrying the OLD style.
    rerender(
      <ChatboxPerTurnFeedbackToggle
        chatbox={styled({ enabled: true, prompt: "unrelated change" })}
      />
    );
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");

    if (!resolveWrite) throw new Error("expected a pending write to resolve");
    await act(async () => {
      resolveWrite!();
    });

    // Only the server reporting the new style stands the override down.
    rerender(
      <ChatboxPerTurnFeedbackToggle
        chatbox={styled({ enabled: true, style: "thumbs" })}
      />
    );
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");
  });

  it("makes the description copy match the chosen style", () => {
    const { rerender } = render(
      <ChatboxPerTurnFeedbackToggle chatbox={styled({ enabled: true })} />
    );
    expect(screen.getByText(/1–5 stars/)).toBeInTheDocument();

    rerender(
      <ChatboxPerTurnFeedbackToggle
        chatbox={styled({ enabled: true, style: "thumbs" })}
      />
    );
    expect(screen.getByText(/👍 or 👎/)).toBeInTheDocument();
  });
});
