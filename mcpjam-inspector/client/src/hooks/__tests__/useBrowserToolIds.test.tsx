import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  hosted: false,
  user: null as null | { id: string },
  request: vi.fn(),
  setting: undefined as { enabled: boolean | null } | undefined,
  queries: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: !!state.user }),
  useQuery: (name: unknown, args: unknown) => {
    state.queries(name, args);
    return state.setting;
  },
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
  state.setting = undefined;
  state.queries.mockClear();
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

it("never turns device consent into hosted tools or a shared project's answer", () => {
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
  // A project that never enabled Browser keeps its answer. `Allow` SKIPS
  // projects the member cannot manage, so an unset default there is an org
  // decision — not a gap for this machine's grant to fill.
  state.hosted = false;
  state.user = { id: "member" };
  state.setting = { enabled: null };
  expect(
    renderHook(() => useBrowserToolIds(null, "local", { projectId: "proj_1" }))
      .result.current,
  ).toBeUndefined();
  expect(state.request).not.toHaveBeenCalled();
});

it("lets the device grant answer for a member with no shared setting to read", () => {
  // A local-only project has no Convex row to store a default in, so the
  // settings query never runs. Before this, Allow left the member in the same
  // silent no-Browser turn as a guest: nothing stored, nothing consulted, no
  // tool — on a machine they had explicitly authorized.
  state.user = { id: "member" };
  localStorage.setItem(
    "mcp-local-browser-consent-v1",
    JSON.stringify({ token: "member-device-browser-consent", grantedAt: "now" }),
  );
  const scope = { projectId: "local_1" };
  expect(
    renderHook(() => useBrowserToolIds(null, "local", scope)).result.current,
  ).toEqual(["browser"]);
  expect(state.queries.mock.calls.every(([, args]) => args === "skip")).toBe(
    true,
  );
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

it("reads the project setting without any saved/default client and updates reactively", () => {
  state.user = { id: "member" };
  state.setting = { enabled: true };
  const scope = { projectId: "proj_1" };
  const view = renderHook(() => useBrowserToolIds(null, "local", scope));
  expect(view.result.current).toEqual(["browser"]);
  expect(state.queries).toHaveBeenCalledWith(
    "hosts:getLocalBrowserSettings",
    scope,
  );
  state.setting = { enabled: false };
  view.rerender();
  expect(view.result.current).toEqual([]);
});

it("waits for the named client's setting and respects an opt-out before its DTO loads", () => {
  state.user = { id: "member" };
  const scope = { projectId: "proj_1", hostId: "host_1" };
  const view = renderHook(() => useBrowserToolIds(null, "local", scope));
  expect(view.result.current).toBeUndefined();
  state.setting = { enabled: false };
  view.rerender();
  expect(view.result.current).toEqual([]);
  expect(state.queries).toHaveBeenCalledWith(
    "hosts:getLocalBrowserSettings",
    scope,
  );
});

it("skips local settings for hosted engines and invalid project scopes", () => {
  state.user = { id: "member" };
  renderHook(() => useBrowserToolIds(null, "cloud", { projectId: "proj_1" }));
  renderHook(() => useBrowserToolIds(null, "local", { projectId: "none" }));
  expect(state.queries.mock.calls.every(([, args]) => args === "skip")).toBe(
    true,
  );
});
