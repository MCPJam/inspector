import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { track } from "@/lib/analytics";
import {
  confirmAutoOAuthEscalation,
  useAutoOAuthAuthorizationStore,
} from "@/lib/oauth/auto-oauth-escalation";
import { AutoOAuthAuthorizationDialog } from "../AutoOAuthAuthorizationDialog";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const location = "auto_oauth_authorization_dialog";

describe("AutoOAuthAuthorizationDialog", () => {
  beforeEach(() => vi.mocked(track).mockClear());

  afterEach(() => {
    useAutoOAuthAuthorizationStore.setState({ queue: [], shownPromptId: null });
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
    expect(track).not.toHaveBeenCalled();

    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = confirmAutoOAuthEscalation("Jensen is back");
    });
    const dialog = screen.getByRole("alertdialog", {
      name: 'Authorize "Jensen is back"?',
    });
    const promptId = useAutoOAuthAuthorizationStore.getState().queue[0].id;
    expect(within(dialog).getByRole("button", { name: "Not now" })).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Server settings" })).toBeNull();

    await user.keyboard("{Escape}");
    await expect(outcome).resolves.toBe(false);
    expect(vi.mocked(track).mock.calls).toEqual([
      ["server_auto_oauth_prompt_shown", { location, prompt_id: promptId }],
      [
        "server_auto_oauth_prompt_resolved",
        { location, prompt_id: promptId, decision: "dismiss" },
      ],
    ]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Server settings" })).toBeVisible();
    expect(onSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("confirms only the current server and lets the next server be declined", async () => {
    const user = userEvent.setup();
    const first = confirmAutoOAuthEscalation("Asana");
    const second = confirmAutoOAuthEscalation("Linear");
    const [firstPrompt, secondPrompt] =
      useAutoOAuthAuthorizationStore.getState().queue;
    render(
      <StrictMode>
        <AutoOAuthAuthorizationDialog />
      </StrictMode>,
    );

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Asana"?',
    );
    expect(firstPrompt.id).not.toBe(secondPrompt.id);
    expect(vi.mocked(track).mock.calls).toEqual([
      ["server_auto_oauth_prompt_shown", { location, prompt_id: firstPrompt.id }],
    ]);
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
    expect(vi.mocked(track).mock.calls).toEqual([
      ["server_auto_oauth_prompt_shown", { location, prompt_id: firstPrompt.id }],
      [
        "server_auto_oauth_prompt_resolved",
        { location, prompt_id: firstPrompt.id, decision: "continue" },
      ],
      ["server_auto_oauth_prompt_shown", { location, prompt_id: secondPrompt.id }],
      [
        "server_auto_oauth_prompt_resolved",
        { location, prompt_id: secondPrompt.id, decision: "not_now" },
      ],
    ]);
  });
});
