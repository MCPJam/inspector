import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  hosted: false,
  user: null as null | { id: string },
  request: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: state.user }),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: state.request }));
import { useBrowserToolIds } from "../useBrowserToolIds";
import { useLocalBrowserConsent } from "../useLocalBrowserConsent";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

beforeEach(() => {
  localStorage.clear();
  state.hosted = false;
  state.user = null;
  state.request
    .mockReset()
    .mockImplementation(async (url: string) =>
      Response.json(
        url.endsWith("/grant")
          ? { token: "guest-device-browser-consent", grantedAt: "now" }
          : { scope: "device", enabledProjects: 0, skippedProjects: 0 },
      ),
    );
});

it("enables every guest local view only after explicit Allow, including views opened later", async () => {
  const first = renderHook(() => ({
    consent: useLocalBrowserConsent(),
    tools: useBrowserToolIds(null, "local"),
  }));
  const second = renderHook(() => useBrowserToolIds(null, "local"));
  expect(first.result.current.tools).toBeUndefined();
  expect(state.request).not.toHaveBeenCalled();
  await act(async () => {
    expect(await first.result.current.consent.grant()).toBe(true);
  });
  expect(first.result.current.tools).toEqual(["browser"]);
  expect(second.result.current).toEqual(["browser"]);
  expect(
    renderHook(() => useBrowserToolIds(null, "local")).result.current,
  ).toEqual(["browser"]);
  await act(async () => {
    await first.result.current.consent.revoke();
  });
  expect(second.result.current).toBeUndefined();
});

it("never turns guest device consent into hosted tools or shared settings after sign-in", () => {
  localStorage.setItem(
    "mcp-local-browser-consent-v1",
    JSON.stringify({ token: "guest-device-browser-consent", grantedAt: "now" }),
  );
  expect(
    renderHook(() => useBrowserToolIds(null, "cloud")).result.current,
  ).toBeUndefined();
  state.hosted = true;
  expect(
    renderHook(() => useBrowserToolIds(null, "local")).result.current,
  ).toBeUndefined();
  state.hosted = false;
  state.user = { id: "member" };
  expect(
    renderHook(() => useBrowserToolIds(null, "local")).result.current,
  ).toBeUndefined();
  expect(state.request).not.toHaveBeenCalled();
});

it("preserves an explicit client opt-out for guests", () => {
  localStorage.setItem(
    "mcp-local-browser-consent-v1",
    JSON.stringify({ token: "guest-device-browser-consent", grantedAt: "now" }),
  );
  const config = {
    builtInToolIds: ["browser"],
    localBrowserEnabled: false,
  } as HostConfigDtoV2;
  expect(
    renderHook(() => useBrowserToolIds(config, "local")).result.current,
  ).toEqual([]);
});
