import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({ hosted: false, cloud: false }));
const evaluate = vi.hoisted(() => vi.fn());
vi.mock("../../../config.js", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("../../analytics.js", () => ({
  evaluateHostedBrowserRollout: evaluate,
}));
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: async (token: string) =>
    token.startsWith("guest-")
      ? { valid: true, guestId: token }
      : { valid: false },
}));
vi.mock("../../../services/authkit-jwt.js", () => ({
  verifyAuthKitToken: async (token: string) => {
    if (token === "member") return { sub: "user-1" };
    throw new Error("invalid credentials");
  },
}));

beforeEach(() => {
  vi.resetModules();
  state.hosted = false;
  state.cloud = false;
  evaluate.mockReset().mockImplementation(async () => state.cloud);
});

async function request(
  token: string | null,
  local = true,
  host = "localhost:6274",
) {
  const { resolveBrowserRollout } = await import("../browser-rollout.js");
  const app = new Hono();
  app.get("/", async (c) => c.json(await resolveBrowserRollout(c, local)));
  const response = await app.request(`http://${host}/`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return response.json();
}

describe("Browser rollout admission", () => {
  it.each(["member", "guest-a"])(
    "allows %s locally without asking a flag",
    async (token) => {
      expect((await request(token)).enabled).toBe(true);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it("requires the hosted flag for a member in cloud", async () => {
    expect((await request("member", false)).enabled).toBe(false);
    expect(evaluate).toHaveBeenCalledWith("user-1");
  });
  it("never admits a guest to hosted Browser even if the flag is on", async () => {
    state.cloud = true;
    expect((await request("guest-a", false)).enabled).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });
  it.each([null, "forged", "expired"])(
    "denies unverified identity %s",
    async (token) => {
      expect((await request(token)).enabled).toBe(false);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it("does not expose a local browser through a remote host", async () => {
    expect(
      (await request("guest-a", true, "inspector.example.com")).enabled,
    ).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("does not expose local Browser in hosted mode", async () => {
    state.hosted = true;
    expect((await request("member")).enabled).toBe(false);
  });
  it("keeps guest project keys bounded, isolated and unforgeable by nesting", async () => {
    const { guestBrowserProject } = await import("../browser-rollout.js");
    const a = guestBrowserProject("project", "guest-a");
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(a).not.toBe(guestBrowserProject("project", "guest-b"));
    expect(a).not.toBe(guestBrowserProject(a, "guest-b"));
    expect(() => guestBrowserProject("../project", "guest-a")).toThrow();
  });
});
