import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnattendedHarnessVenue } from "../useUnattendedHarnessVenue";
const request = vi.hoisted(() => vi.fn());
const environment = vi.hoisted(() => ({ hosted: false }));
vi.mock("@/lib/config", () => ({ get HOSTED_MODE() { return environment.hosted; } }));
vi.mock("@/lib/session-token", () => ({ authFetch: request }));
vi.mock("@/lib/local-harness-consent", () => ({
  subscribeLocalHarnessConsent: () => () => {},
}));
afterEach(() => {
  cleanup();
  request.mockReset();
  environment.hosted = false;
});

it.each(["local", "hosted", "unavailable"])(
  "uses the server's %s venue",
  async (venue) => {
    request.mockResolvedValue(
      new Response(JSON.stringify({ unattendedVenue: venue })),
    );
    const { result } = renderHook(() =>
      useUnattendedHarnessVenue("project", "codex"),
    );
    expect(result.current).toBe("checking");
    await waitFor(() => expect(result.current).toBe(venue));
    expect(request.mock.calls[0][0]).toContain("scope=unattended");
  },
);
it("does not treat errors or missing projection as a cloud fallback", async () => {
  request.mockResolvedValue(new Response("{}"));
  const { result } = renderHook(() =>
    useUnattendedHarnessVenue("project", "codex"),
  );
  await waitFor(() => expect(result.current).toBe("unavailable"));
});
it("clears the previous project's venue while checking a new target", async () => {
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ unattendedVenue: "local" })),
  );
  request.mockReturnValueOnce(new Promise(() => {}));
  const { result, rerender } = renderHook(
    ({ id }) => useUnattendedHarnessVenue(id, "codex"),
    { initialProps: { id: "first" } },
  );
  await waitFor(() => expect(result.current).toBe("local"));
  rerender({ id: "second" });
  expect(result.current).toBe("checking");
});

it("rechecks eligibility when the window regains focus", async () => {
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ unattendedVenue: "local" })),
  );
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ unattendedVenue: "unavailable" })),
  );
  const { result } = renderHook(() =>
    useUnattendedHarnessVenue("project", "codex"),
  );
  await waitFor(() => expect(result.current).toBe("local"));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(result.current).toBe("unavailable"));
});

it("reports network failure without claiming a venue", async () => {
  request.mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useUnattendedHarnessVenue("project", "codex"));
  await waitFor(() => expect(result.current).toBe("unavailable"));
});

it("resolves hosted immediately without probing the loopback-only endpoint", () => {
  environment.hosted = true;
  const { result } = renderHook(() => useUnattendedHarnessVenue("project", "codex"));
  expect(result.current).toBe("hosted");
  act(() => window.dispatchEvent(new Event("focus")));
  expect(request).not.toHaveBeenCalled();
});
