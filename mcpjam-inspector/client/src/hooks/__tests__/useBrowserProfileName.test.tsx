import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useBrowserProfileName } from "../useBrowserProfileName";
const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser-profiles/client", () => ({ listBrowserProfiles: list }));
beforeEach(() => {
  list.mockReset();
});
it("does not fetch without a selected profile", () => {
  renderHook(() => useBrowserProfileName("p"));
  expect(list).not.toHaveBeenCalled();
});
it("discards labels from a previous project and ignores late replies", async () => {
  let resolveOld!: (value: unknown[]) => void;
  list
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce([
      { profileId: "profile", name: "New project profile" },
    ]);
  const { result, rerender } = renderHook(
    ({ project }) => useBrowserProfileName(project, "profile"),
    { initialProps: { project: "old" } },
  );
  rerender({ project: "new" });
  await waitFor(() => expect(result.current).toBe("New project profile"));
  await act(async () =>
    resolveOld([{ profileId: "profile", name: "Old project profile" }]),
  );
  expect(result.current).toBe("New project profile");
});
it("falls back when the saved profile cannot be read", async () => {
  list.mockRejectedValue(new Error("unavailable"));
  const { result } = renderHook(() => useBrowserProfileName("p", "profile"));
  await act(async () => {});
  expect(result.current).toBeUndefined();
});
