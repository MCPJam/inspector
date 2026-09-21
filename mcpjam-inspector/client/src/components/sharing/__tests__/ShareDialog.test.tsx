import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShareDialog } from "../ShareDialog";

describe("ShareDialog", () => {
  it("renders title, description, and children when open", () => {
    render(
      <ShareDialog
        open
        onOpenChange={vi.fn()}
        title="Share this run"
        description="Anyone with the link can view it."
      >
        <p>panel body</p>
      </ShareDialog>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Share this run")).toBeInTheDocument();
    expect(
      screen.getByText("Anyone with the link can view it."),
    ).toBeInTheDocument();
    expect(screen.getByText("panel body")).toBeInTheDocument();
  });

  it("omits the description when none is provided", () => {
    render(
      <ShareDialog open onOpenChange={vi.fn()} title="Share">
        <span>child</span>
      </ShareDialog>,
    );

    expect(screen.getByText("Share")).toBeInTheDocument();
    expect(screen.queryByText("Anyone with the link can view it.")).not.toBeInTheDocument();
  });

  it("is controlled: closed until open is true", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ShareDialog open={false} onOpenChange={onOpenChange} title="Share">
        <span>hidden child</span>
      </ShareDialog>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("hidden child")).not.toBeInTheDocument();

    rerender(
      <ShareDialog open onOpenChange={onOpenChange} title="Share">
        <span>hidden child</span>
      </ShareDialog>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("hidden child")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
