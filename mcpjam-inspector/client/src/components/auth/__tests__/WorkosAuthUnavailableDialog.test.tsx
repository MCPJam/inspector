import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkosAuthUnavailableDialog } from "../WorkosAuthUnavailableDialog";
import { InviteTeamSignUpDialog } from "../InviteTeamSignUpDialog";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";

beforeEach(() => useWorkosAuthUnavailableStore.getState().dismiss());
afterEach(() => vi.unstubAllGlobals());
const signUp = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signUp, signIn: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

function openDialog() {
  render(<WorkosAuthUnavailableDialog />);
  act(() => {
    useWorkosAuthUnavailableStore.getState().show();
    useWorkosAuthUnavailableStore.getState().show();
  });
}

it("shows one dialog and opens only the hosted app in a new tab", () => {
  openDialog();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Sign-in isn’t available at this HTTP address",
  );
  const link = screen.getByRole("link", { name: "Open app.mcpjam.com" });
  expect(link).toHaveAttribute("href", "https://app.mcpjam.com");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
});

it.each(["Cancel", "Close"])("dismisses with %s and can reopen", (name) => {
  openDialog();
  fireEvent.click(screen.getByRole("button", { name }));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => useWorkosAuthUnavailableStore.getState().show());
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("dismisses with Escape", () => {
  openDialog();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens above an existing sign-up dialog and returns focus on Cancel", async () => {
  vi.stubGlobal("location", new URL("http://devhub.htb:6274/servers"));
  render(
    <>
      <InviteTeamSignUpDialog isOpen onClose={vi.fn()} />
      <WorkosAuthUnavailableDialog />
    </>,
  );
  const createAccount = screen.getByRole("button", {
    name: "Create free account",
  });
  createAccount.focus();
  fireEvent.click(createAccount);
  expect(
    await screen.findByRole("dialog", { name: "Sign in on app.mcpjam.com" }),
  ).toBeVisible();
  expect(signUp).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(createAccount).toHaveFocus());
});
