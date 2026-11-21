import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import webRoutes from "../index.js";

vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/authkit-jwt.js")
  >()),
  classifyAuthKitBearer: vi.fn().mockResolvedValue({ kind: "not_authkit" }),
  verifyAuthKitToken: vi
    .fn()
    .mockRejectedValue(new Error("Unverified test identity")),
}));

it("requires verified identity on the mounted cloud skills route before reading the body", async () => {
  const app = new Hono().route("/api/web", webRoutes);
  const request = new Request("http://localhost/api/web/skills/create", {
    method: "POST",
    headers: {
      authorization: "Bearer test-credential",
      "content-type": "application/json",
    },
    body: "{}",
  });
  const response = await app.request(request);
  expect(response.status).toBe(401);
  expect(request.bodyUsed).toBe(false);
});
