import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServerConnectionHandoff } from "../ServerConnectionHandoff";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";

const signIn = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    signIn,
    getAccessToken: async () => undefined,
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  useWorkosAuthUnavailableStore.getState().dismiss();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("clears the busy state when sign-in is blocked on an HTTP host", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: "Sign in required",
            details: { reason: "sign-in-required" },
          }),
          { status: 403 },
        ),
    ),
  );
  window.history.replaceState({}, "", "/connect/server/handoff-token-abc");
  render(<ServerConnectionHandoff />);
  const button = await screen.findByRole("button", { name: "Sign in" });
  vi.stubGlobal(
    "location",
    new URL("http://devhub.htb:6274/connect/server/handoff-token-abc"),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled(),
  );
  expect(signIn).not.toHaveBeenCalled();
  expect(useWorkosAuthUnavailableStore.getState().open).toBe(true);
});
