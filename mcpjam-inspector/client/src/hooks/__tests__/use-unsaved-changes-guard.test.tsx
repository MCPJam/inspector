import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  useUnsavedChangesGuard,
  type GuardLocation,
} from "../use-unsaved-changes-guard";

function Guarded({
  allow,
  onDiscard,
}: {
  allow?: (current: GuardLocation, next: GuardLocation) => boolean;
  onDiscard: () => void;
}) {
  useUnsavedChangesGuard(true, onDiscard, undefined, undefined, allow);
  return null;
}

function setup(
  allow?: (current: GuardLocation, next: GuardLocation) => boolean,
) {
  const onDiscard = vi.fn();
  const router = createMemoryRouter(
    [{ path: "*", element: <Guarded allow={allow} onDiscard={onDiscard} /> }],
    { initialEntries: ["/a"] },
  );
  render(<RouterProvider router={router} />);
  return { router, onDiscard };
}

afterEach(() => vi.restoreAllMocks());

describe("useUnsavedChangesGuard", () => {
  it("prompts on any location change when no allow is given", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { router, onDiscard } = setup();
    await act(() => router.navigate("/b"));
    expect(confirm).toHaveBeenCalledWith(
      "You have unsaved settings. Leave without saving?",
    );
    expect(router.state.location.pathname).toBe("/a");
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("lets an allowed move through without a prompt", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const allow = (current: GuardLocation, next: GuardLocation) =>
      current.pathname === "/a" && next.pathname === "/b";
    const { router } = setup(allow);
    await act(() => router.navigate("/b"));
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/b");
  });

  it("still prompts for a move the predicate refuses, and discards on yes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { router, onDiscard } = setup(() => false);
    await act(() => router.navigate("/c"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/c");
  });
});
