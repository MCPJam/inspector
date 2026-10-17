import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { v1OnError } from "../envelope.js";

function app(data: Record<string, unknown>) {
  const app = new Hono();
  app.onError(v1OnError);
  app.get("/", () => {
    throw Object.assign(new Error("wrapped"), { data });
  });
  return app;
}

describe("platform admission transport", () => {
  it.each([
    [
      { minimumVersion: "10.0.0", docsUrl: "https://docs.mcpjam.com" },
      { minimumVersion: "10.0.0", docsUrl: "https://docs.mcpjam.com" },
    ],
    [{ minimumVersion: 10, docsUrl: false }, {}],
  ])("forwards only typed upgrade guidance: %j", async (guidance, expected) => {
    const response = await app({
      code: "client_upgrade_required",
      message: "Upgrade the SDK.",
      ...guidance,
    }).request("/");
    expect(await response.json()).toEqual({
      code: "UPGRADE_REQUIRED",
      message: "Upgrade the SDK.",
      details: { code: "client_upgrade_required", ...expected },
    });
  });
  it.each(["insufficient_credits", "spend_budget_reached", "wallet_locked"])(
    "preserves a terminal payment refusal: %s",
    async (reason) => {
      const response = await app({
        code: "platform_fee_refused",
        reason,
        message: "Billing refused this run.",
      }).request("/");
      expect(response.status).toBe(402);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toEqual({
        code: "PAYMENT_REQUIRED",
        message: "Billing refused this run.",
        details: { code: "platform_fee_refused", reason },
      });
    },
  );
  it("keeps the held-credit cause beside its billing reason", async () => {
    const response = await app({
      code: "platform_fee_refused",
      reason: "insufficient_credits",
      cause: "credits_reserved",
      message: "Wait for other work to finish, then run it again.",
    }).request("/");
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      details: {
        code: "platform_fee_refused",
        reason: "insufficient_credits",
        cause: "credits_reserved",
      },
    });
  });
  it.each([
    ["platform_fee_unavailable", 503, "INTERNAL_ERROR"],
    ["ADMISSION_CONFLICT", 409, "CONFLICT"],
    ["ADMISSION_CLOSED", 409, "CONFLICT"],
    ["ADMISSION_NOT_FOUND", 404, "NOT_FOUND"],
    ["ORGANIZATION_SPEND_BUDGET_REACHED", 402, "PAYMENT_REQUIRED"],
    ["client_upgrade_required", 426, "UPGRADE_REQUIRED"],
  ])(
    "maps %s without treating it as a throttle",
    async (code, status, wireCode) => {
      const response = await app({
        code,
        message: "Follow the documented recovery step.",
      }).request("/");
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code: wireCode,
        details: { code },
      });
    },
  );
});
