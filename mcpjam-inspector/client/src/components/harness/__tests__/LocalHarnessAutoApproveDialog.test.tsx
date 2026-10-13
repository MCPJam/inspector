import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalHarnessAutoApproveDialog } from "../LocalHarnessTrustDialog";
describe("local Off consent copy", () => {
  it.each(["Claude Code", "Codex"])(
    "names %s and states OS-user command and file authority",
    (name) => {
      render(
        <LocalHarnessAutoApproveDialog
          open
          name={name}
          onCancel={vi.fn()}
          onApprove={vi.fn()}
        />,
      );
      expect(screen.getByRole("heading").textContent).toBe(
        "Run commands without asking?",
      );
      expect(
        screen.getByText(
          `${name} will run commands and change files on this computer as your user account, without asking first. Turn Tool Approval back on anytime.`,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Run without asking" }),
      ).toBeEnabled();
    },
  );
  it("keeps a failed persistence request open and reports the failure", async () => {
    const onCancel = vi.fn();
    render(
      <LocalHarnessAutoApproveDialog
        open
        name="Claude Code"
        onCancel={onCancel}
        onApprove={vi.fn(async () => {
          throw new Error("offline");
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run without asking" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("offline"),
    );
    expect(onCancel).not.toHaveBeenCalled();
  });
});
