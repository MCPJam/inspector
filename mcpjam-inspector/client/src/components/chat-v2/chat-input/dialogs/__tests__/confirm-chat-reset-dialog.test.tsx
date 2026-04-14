import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmChatResetDialog } from "../confirm-chat-reset-dialog";

const SKIP_CHAT_RESET_CONFIRMATION_KEY = "skipChatResetConfirmation";

describe("ConfirmChatResetDialog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("re-checks skip preference when dialog open state changes", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    const { rerender } = render(
      <ConfirmChatResetDialog
        open={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    localStorage.setItem(SKIP_CHAT_RESET_CONFIRMATION_KEY, "true");

    rerender(
      <ConfirmChatResetDialog open onConfirm={onConfirm} onCancel={onCancel} />,
    );

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("auto-confirms only once when onConfirm reference changes while open", () => {
    localStorage.setItem(SKIP_CHAT_RESET_CONFIRMATION_KEY, "true");
    const onConfirm1 = vi.fn();
    const onConfirm2 = vi.fn();

    const { rerender } = render(
      <ConfirmChatResetDialog open onConfirm={onConfirm1} onCancel={vi.fn()} />,
    );

    rerender(
      <ConfirmChatResetDialog open onConfirm={onConfirm2} onCancel={vi.fn()} />,
    );

    expect(onConfirm1).toHaveBeenCalledTimes(1);
    expect(onConfirm2).not.toHaveBeenCalled();
  });

  it("persists skip preference when confirming with don't show again", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <ConfirmChatResetDialog open onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    await user.click(screen.getByLabelText("Don't show this again"));
    await user.click(screen.getByRole("button", { name: "Reset chat" }));

    expect(localStorage.getItem(SKIP_CHAT_RESET_CONFIRMATION_KEY)).toBe("true");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Reset chat?")).not.toBeInTheDocument();
  });
});
