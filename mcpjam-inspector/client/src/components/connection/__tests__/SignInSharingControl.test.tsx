import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { SignInSharingControl } from "../SignInSharingControl";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const HOSTED_RUNS =
  /hosted runs can act as.* Nobody can get their tokens out\./;

function mount(shared: boolean, accountCount = 0) {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(
    <SignInSharingControl
      shared={shared}
      accountCount={accountCount}
      onChange={onChange}
    />,
  );
  return onChange;
}

async function flip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("switch"));
  return await screen.findByRole("alertdialog");
}

describe("SignInSharingControl", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("says who can act as the accounts and that nobody gets their tokens out", () => {
    mount(false);
    expect(
      screen.getByRole("switch", { name: "Share sign-in with the project" }),
    ).not.toBeChecked();
    expect(screen.getByText(HOSTED_RUNS)).toBeTruthy();
    cleanup();
    mount(true, 2);
    expect(
      screen.getByRole("switch", { name: "Shared with the project" }),
    ).toBeChecked();
    expect(screen.getByText(HOSTED_RUNS)).toBeTruthy();
  });

  it("shares only once the admin confirms what it means", async () => {
    const user = userEvent.setup();
    const onChange = mount(false);
    const dialog = await flip(user);
    expect(dialog).toHaveTextContent(
      "Share this server's sign-in with the project?",
    );
    expect(dialog).toHaveTextContent(
      "Every member's hosted runs will be able to act as the accounts admins connect here, and nobody can get their tokens out.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();

    await flip(user);
    await user.click(screen.getByRole("button", { name: "Share sign-in" }));
    expect(onChange).toHaveBeenCalledWith("shared");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Sign-in shared with the project.",
      ),
    );
  });

  it.each([
    [
      2,
      "Stop sharing and delete 2 project accounts?",
      "MCPJam will delete them and ask the sign-in provider to revoke their tokens.",
    ],
    [
      1,
      "Stop sharing and delete the project account?",
      "MCPJam will delete it and ask the sign-in provider to revoke its token.",
    ],
  ])(
    "says turning sharing off deletes %i project account(s), and confirms it",
    async (count, title, deletion) => {
      const user = userEvent.setup();
      const onChange = mount(true, count);
      const dialog = await flip(user);
      expect(dialog).toHaveTextContent(title);
      expect(dialog).toHaveTextContent(deletion);
      expect(dialog).toHaveTextContent("This cannot be undone.");
      await user.click(
        screen.getByRole("button", { name: "Delete and stop sharing" }),
      );
      expect(onChange).toHaveBeenCalledWith("personal");
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Sign-in no longer shared, and the project accounts were deleted.",
        ),
      );
    },
  );

  it("stops sharing a server with no project accounts without a deletion warning", async () => {
    const user = userEvent.setup();
    const onChange = mount(true, 0);
    const dialog = await flip(user);
    expect(dialog).toHaveTextContent("Stop sharing this server's sign-in?");
    expect(dialog).not.toHaveTextContent("delete");
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(onChange).toHaveBeenCalledWith("personal");
  });

  it.each([
    [
      new ConvexError({
        code: "FORBIDDEN",
        message: "Only project admins can share.",
      }),
      "Only project admins can share.",
    ],
    [
      new Error("[Request ID: 0123456789abcdef] Server Error"),
      "Could not share this server's sign-in. Try again.",
    ],
  ])("shows why sharing failed", async (failure, message) => {
    const user = userEvent.setup();
    const onChange = mount(false);
    onChange.mockRejectedValue(failure);
    await flip(user);
    await user.click(screen.getByRole("button", { name: "Share sign-in" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
