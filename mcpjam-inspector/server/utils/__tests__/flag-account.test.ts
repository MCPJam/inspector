import { afterEach, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../../routes/v1/convex-client.js", () => ({ createConvexClient: (token: string) => ({ query: (...args: unknown[]) => query(token, ...args) }) }));
import { flagAccountEmail } from "../flag-account";
import { rolloutPersonProperties } from "../../../shared/strict-server-analytics";
afterEach(() => { vi.unstubAllEnvs(); query.mockReset(); });
it("uses only the authenticated subject's account record for flag email", async () => {
  vi.stubEnv("CONVEX_URL", "https://synthetic.convex.cloud");
  query.mockResolvedValue({ externalId: "user_verified", email: "account@example.test" });
  expect(await flagAccountEmail("verified-bearer", "user_verified")).toBe("account@example.test");
  expect(query).toHaveBeenCalledWith("verified-bearer", "users:getCurrentUser", {});
  query.mockResolvedValue({ externalId: "user_other", email: "customer@example.test" });
  expect(await flagAccountEmail("verified-bearer", "user_verified")).toBeUndefined();
  query.mockRejectedValue(new Error("unavailable"));
  expect(await flagAccountEmail("verified-bearer", "user_verified")).toBeUndefined();
});
it("keeps finite cohorts plus explicitly trusted account email and drops caller email", () => {
  expect(rolloutPersonProperties({ email: "caller@example.test", platform: "linux", deployment: "self_hosted", customer: "SENTINEL" }, "account@example.test")).toEqual({ email: "account@example.test", platform: "linux", deployment: "self_hosted" });
  expect(rolloutPersonProperties({ email: "caller@example.test", platform: "SENTINEL" })).toEqual({});
});
