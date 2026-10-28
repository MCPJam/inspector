import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiHarnessEnvironment } from "../chat-session-harness-environment.js";
const base = {
  credential: false,
};
beforeEach(() => vi.clearAllMocks());
describe("API harness grant identity", () => {
  it("does not move a plain host conversation onto its new composed trace environment", async () => {
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        resolvedEnvironmentId: "composed",
      }),
    ).toEqual({ ok: true, environmentId: undefined });
  });
  it("retains an explicitly pinned environment", async () => {
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        pinnedEnvironmentId: "named",
        resolvedEnvironmentId: "composed",
      }),
    ).toEqual({ ok: true, environmentId: "named" });
  });
  it("uses the modern credential composition without composing it again", async () => {
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        credential: true,
        resolvedEnvironmentId: "credential",
      }),
    ).toEqual({ ok: true, environmentId: "credential" });
  });
  it("refuses a credential turn without a resolved grant before provisioning", () => {
    expect(resolveApiHarnessEnvironment({ credential: true })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});
