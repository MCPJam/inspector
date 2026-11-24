import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  confirmAutoOAuthEscalation,
  useAutoOAuthAuthorizationStore,
} from "@/lib/oauth/auto-oauth-escalation";
import { AutoOAuthAuthorizationDialog } from "../AutoOAuthAuthorizationDialog";

describe("AutoOAuthAuthorizationDialog", () => {
  afterEach(() => {
    useAutoOAuthAuthorizationStore.setState({ queue: [] });
  });

  it("opens above server settings and Escape declines only the authorization", async () => {
    const user = userEvent.setup();
    const onSettingsOpenChange = vi.fn();
    render(
      <>
        <Dialog open onOpenChange={onSettingsOpenChange}>
          <DialogContent>
            <DialogTitle>Server settings</DialogTitle>
            <DialogDescription>Edit the server configuration.</DialogDescription>
          </DialogContent>
        </Dialog>
        <AutoOAuthAuthorizationDialog />
      </>,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = confirmAutoOAuthEscalation("Jensen is back");
    });
    const dialog = screen.getByRole("alertdialog", {
      name: 'Authorize "Jensen is back"?',
    });
    expect(within(dialog).getByRole("button", { name: "Not now" })).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Server settings" })).toBeNull();

    await user.keyboard("{Escape}");
    await expect(outcome).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Server settings" })).toBeVisible();
    expect(onSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("confirms only the current server and lets the next server be declined", async () => {
    const user = userEvent.setup();
    const first = confirmAutoOAuthEscalation("Asana");
    const second = confirmAutoOAuthEscalation("Linear");
    render(<AutoOAuthAuthorizationDialog />);

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Asana"?',
    );
    await user.click(screen.getByRole("button", { name: "Continue to sign in" }));
    await expect(first).resolves.toBe(true);

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Linear"?',
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue to sign in" }), {
      detail: 2,
    });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "Not now" });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    await expect(second).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
