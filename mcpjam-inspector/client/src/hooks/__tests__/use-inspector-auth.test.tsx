import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInspectorAuth } from "../use-inspector-auth";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";

const auth = vi.hoisted(() => ({
  user: { id: "user-auth-test" },
  organizationId: "org-auth-test",
  isLoading: false,
  signIn: vi.fn().mockResolvedValue(undefined),
  signUp: vi.fn().mockResolvedValue(undefined),
  getAccessToken: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
beforeEach(() => {
  vi.clearAllMocks();
  useWorkosAuthUnavailableStore.getState().dismiss();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["signIn", "http://devhub.htb:6274"],
  ["signUp", "http://devhub.htb:6274"],
  ["signIn", "http://192.168.1.50:6274"],
  ["signUp", "http://0.0.0.0:6274"],
] as const)(
  "blocks %s on %s without calling WorkOS",
  async (action, origin) => {
    vi.stubGlobal("location", new URL(origin));
    const { result } = renderHook(useInspectorAuth);
    await act(async () => {
      expect(await result.current[action]()).toBe("blocked");
      expect(await result.current[action]()).toBe("blocked");
    });
    expect(auth[action]).not.toHaveBeenCalled();
    expect(useWorkosAuthUnavailableStore.getState().open).toBe(true);
  },
);

it.each([
  "https://devhub.htb",
  "http://localhost:6274",
  "http://127.0.0.1:6274",
  "http://[::1]:6274",
  "null",
])("preserves auth and options on %s", async (origin) => {
  vi.stubGlobal("location", { origin });
  const { result } = renderHook(useInspectorAuth);
  const options = {
    state: { returnTo: "/servers" },
    organizationId: "org-auth-test",
  };
  expect(result.current.user).toBe(auth.user);
  expect(result.current.organizationId).toBe(auth.organizationId);
  expect(result.current.getAccessToken).toBe(auth.getAccessToken);
  expect(result.current.signOut).toBe(auth.signOut);
  await act(async () => {
    expect(await result.current.signIn(options)).toBe("started");
    expect(await result.current.signUp(options)).toBe("started");
  });
  expect(auth.signIn).toHaveBeenCalledWith(options);
  expect(auth.signUp).toHaveBeenCalledWith(options);
  expect(useWorkosAuthUnavailableStore.getState().open).toBe(false);
});
