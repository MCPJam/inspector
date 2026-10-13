import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalSecretDelivery } from "../secret-delivery.js";
import {
  convexListProjectSecretBindings, convexGetEnvironmentSecretSelection,
} from "../../../computers/convex-secrets-client.js";
vi.mock("../../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(),
  convexGetEnvironmentSecretSelection: vi.fn(),
}));
const args = { bearer: "test", projectId: "p", environmentId: "env" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(convexListProjectSecretBindings).mockResolvedValue([
    { secretId: "materialized", name: "SERVICE_KEY", delivery: "materialized" },
    { secretId: "brokered", name: "REMOTE_KEY", delivery: "brokered" },
  ]);
  vi.mocked(convexGetEnvironmentSecretSelection).mockResolvedValue(["materialized"]);
});
describe("local secret delivery", () => {
  it("allows materialized secrets and ignores unselected brokered rows", async () => {
    await expect(assertLocalSecretDelivery(args)).resolves.toBeUndefined();
  });
  it("refuses a selected brokered secret", async () => {
    vi.mocked(convexGetEnvironmentSecretSelection).mockResolvedValue(["brokered"]);
    await expect(assertLocalSecretDelivery(args)).rejects.toThrow("brokered secrets");
  });
  it("does not treat a metadata failure as an empty selection", async () => {
    vi.mocked(convexGetEnvironmentSecretSelection).mockRejectedValue(new Error("offline"));
    await expect(assertLocalSecretDelivery(args)).rejects.toThrow("offline");
  });
  it("does not fetch secrets without an environment grant", async () => {
    await assertLocalSecretDelivery({ ...args, environmentId: undefined });
    expect(convexListProjectSecretBindings).not.toHaveBeenCalled();
  });
  it("refuses an unresolved environment", async () => {
    await expect(assertLocalSecretDelivery({ ...args, environmentUnresolvedReason: "missing" }))
      .rejects.toThrow("Cannot verify");
  });
});
