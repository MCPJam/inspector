import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalHarnessSetupDialog } from "../LocalHarnessSetupDialog";

describe("LocalHarnessSetupDialog", () => {
  it.each(["Claude Code", "Codex"])(
    "requires an explicit setup action for %s",
    (name) => {
      const onConfirm = vi.fn();
      const onCancel = vi.fn();
      render(
        <LocalHarnessSetupDialog
          name={name}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      );
      expect(screen.getByRole("dialog")).toHaveTextContent(`Set up ${name}`);
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Your message stays in the composer",
      );
      expect(onConfirm).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Set up" }));
      expect(onConfirm).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
    },
  );

  it("cancels without authorizing setup", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <LocalHarnessSetupDialog
        name="Codex"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
