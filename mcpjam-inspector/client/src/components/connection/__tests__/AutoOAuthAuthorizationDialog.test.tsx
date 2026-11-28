import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

  it("declines on Escape and restores focus inside server settings", async () => {
    const user = userEvent.setup();
    const onSettingsOpenChange = vi.fn();
    render(
      <>
        <Dialog open onOpenChange={onSettingsOpenChange}>
          <DialogContent>
            <DialogTitle>Server settings</DialogTitle>
            <DialogDescription>Edit the server configuration.</DialogDescription>
            <button>Reconnect</button>
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
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reconnect" })).toHaveFocus();
    });
    expect(onSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("ignores double-clicks on the next prompt and restores focus after the queue clears", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <button>Connect</button>
        <AutoOAuthAuthorizationDialog />
      </StrictMode>,
    );
    const connect = screen.getByRole("button", { name: "Connect" });
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    act(() => {
      connect.focus();
      first = confirmAutoOAuthEscalation("Asana");
      second = confirmAutoOAuthEscalation("Linear");
    });
    const [firstPrompt, secondPrompt] =
      useAutoOAuthAuthorizationStore.getState().queue;

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Asana"?',
    );
    expect(firstPrompt.id).not.toBe(secondPrompt.id);
    expect(vi.mocked(track).mock.calls).toEqual([
      ["server_auto_oauth_prompt_shown", { location, prompt_id: firstPrompt.id }],
    ]);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await expect(first).resolves.toBe(false);

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Linear"?',
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue to sign in" }), {
      detail: 2,
    });
    const cancel = screen.getByRole("button", { name: "Not now" });
    fireEvent.click(cancel, { detail: 2 });
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Linear"?',
    );
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Continue to sign in" }));
    await expect(second).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(connect).toHaveFocus());
    expect(vi.mocked(track).mock.calls).toEqual([
      ["server_auto_oauth_prompt_shown", { location, prompt_id: firstPrompt.id }],
      [
        "server_auto_oauth_prompt_resolved",
        { location, prompt_id: firstPrompt.id, decision: "not_now" },
      ],
      ["server_auto_oauth_prompt_shown", { location, prompt_id: secondPrompt.id }],
      [
        "server_auto_oauth_prompt_resolved",
        { location, prompt_id: secondPrompt.id, decision: "continue" },
      ],
    ]);
  });

  it("drops canceled prompts whether they are visible or still queued", async () => {
    const active = new AbortController();
    const queued = new AbortController();
    const visible = confirmAutoOAuthEscalation("First", active.signal);
    const unseen = confirmAutoOAuthEscalation("Second", queued.signal);
    const third = confirmAutoOAuthEscalation("Third");
    const firstId = useAutoOAuthAuthorizationStore.getState().queue[0].id;
    render(<AutoOAuthAuthorizationDialog />);

    act(() => queued.abort());
    await expect(unseen).resolves.toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "First"?',
    );

    act(() => active.abort());
    await expect(visible).resolves.toBe(false);
    expect(track).toHaveBeenCalledWith("server_auto_oauth_prompt_resolved", {
      location,
      prompt_id: firstId,
      decision: "superseded",
    });
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      'Authorize "Third"?',
    );
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await expect(third).resolves.toBe(false);
  });
});
