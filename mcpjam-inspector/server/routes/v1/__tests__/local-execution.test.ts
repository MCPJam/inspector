import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const { ensure } = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("../../../utils/harness/local/readiness.js", () => ({
  LocalHarnessRefusalError: class extends Error {},
  ensureLocalHarnessTarget: ensure,
  LocalRuntimePreparingError: class extends Error {},
}));
import routes from "../local-execution";
import { v1OnError } from "../envelope";
const app = new Hono();
app.onError(v1OnError);
app.route("/", routes);
const target = {
  kind: "local-native",
  machineId: "machine",
  workspaceGrantId: "workspace",
  runtimeId: "runtime",
  permissionProfile: "unrestricted",
  policyVersion: "policy",
  grantToken: "a-valid-capability-token",
  actingUserId: "authkit:member",
};
const post = (body: unknown, authorization = "Bearer jwt") =>
  app.request("/projects/project/local-execution-grants", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  ensure.mockResolvedValue({ target, expiresAt: "2026-10-17T00:00:00Z" });
});
describe("local execution grant boundary", () => {
  it.each(["claude-code", "codex"])(
    "requires deliberate unattended consent for %s",
    async (harnessId) => {
      const response = await post({
        harnessId,
        allowUnattended: true,
        workspaceGrantId: "workspace",
      });
      expect(response.status).toBe(200);
      expect(ensure).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "unattended",
          harnessId,
          workspaceGrantId: "workspace",
        }),
      );
      const body = await response.json();
      expect(body.target).toMatchObject({
        scope: "unattended",
        harnessId,
        grantToken: target.grantToken,
      });
      expect(body.target).not.toHaveProperty("actingUserId");
    },
  );
  it.each([
    { harnessId: "codex" },
    { harnessId: "codex", allowUnattended: false },
    { harnessId: "codex", allowUnattended: true, actingUserId: "other" },
  ])("rejects incomplete or forged input before setup", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(ensure).not.toHaveBeenCalled();
  });
  it("rejects missing bearer before setup", async () => {
    expect(
      (
        await post(
          {
            harnessId: "codex",
            allowUnattended: true,
            workspaceGrantId: "workspace",
          },
          "",
        )
      ).status,
    ).toBe(401);
    expect(ensure).not.toHaveBeenCalled();
  });
});
