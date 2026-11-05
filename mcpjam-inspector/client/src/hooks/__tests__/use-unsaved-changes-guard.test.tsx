import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { useUnsavedChangesGuard } from "../use-unsaved-changes-guard";

function Draft({ keepsDraft }: { keepsDraft?: (pathname: string) => boolean }) {
  useUnsavedChangesGuard(true, undefined, undefined, false, keepsDraft);
  return null;
}

function renderDraft(keepsDraft?: (pathname: string) => boolean) {
  const router = createMemoryRouter(
    [{ path: "*", element: <Draft keepsDraft={keepsDraft} /> }],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("useUnsavedChangesGuard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks before leaving unsaved settings", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = renderDraft();
    await act(() => router.navigate("/elsewhere"));
    expect(confirm).toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("lets a navigation through when the next page keeps the draft", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const router = renderDraft(
      (pathname) => pathname === "/settings/evaluators",
    );
    await act(() => router.navigate("/settings/evaluators"));
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/settings/evaluators");
  });
});
