import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConvexError } from "convex/values";
import { v1OnError } from "../envelope.js";

const { getBearerMock, queryMock, mutationMock } = vi.hoisted(() => ({
  getBearerMock: vi.fn(),
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: getBearerMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: queryMock, mutation: mutationMock };
  }),
}));

import deletions from "../deletions.js";

function makeApp(): Hono {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", deletions);
  return app;
}

const receipt = {
  requestId: "request_1",
  scope: { type: "organization", id: "org_1" },
  state: "waiting_to_purge",
  acceptedAt: 100,
  purgeAfter: 200,
  statusUrl: "/deletions/request_1",
  canCancel: true,
  liveDataDeletedAt: null,
  closedAt: null,
  attentionCode: null,
};

describe("v1 deletion request contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example";
    getBearerMock.mockResolvedValue("human-bearer");
  });

  it("publishes authenticated backend availability without accepting deletion", async () => {
    queryMock.mockResolvedValue({ available: false, protocolVersion: 1, scopeTypes: ["project", "organization"] });
    const response = await makeApp().request("/api/v1/deletions/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, protocolVersion: 1 });
    expect(getBearerMock).toHaveBeenCalled();
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("requires an idempotency key and never sends a malformed request", async () => {
    const response = await makeApp().request("/api/v1/deletions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { type: "project", id: "project_1" } }),
    });

    expect(response.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("returns an accepted receipt, forwards the stable key, and does not claim completion", async () => {
    mutationMock.mockResolvedValue(receipt);
    const response = await makeApp().request("/api/v1/deletions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "stable-key-1",
      },
      body: JSON.stringify({ scope: { type: "organization", id: "org_1" } }),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      "/api/v1/deletions/request_1",
    );
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toEqual({
      scope: { type: "organization", id: "org_1" },
      idempotencyKey: "stable-key-1",
    });
    const body = await response.json();
    expect(body).toMatchObject({ state: "waiting_to_purge" });
    expect(body).not.toHaveProperty("deleted");
  });

  it.each([
    ["DELETION_UNAVAILABLE", 422, "FEATURE_NOT_SUPPORTED"],
    ["INVALID_IDEMPOTENCY_KEY", 400, "VALIDATION_ERROR"],
    ["IDEMPOTENCY_KEY_REUSED", 409, "CONFLICT"],
    ["DELETION_IN_PROGRESS", 409, "CONFLICT"],
    ["DELETION_ALREADY_STARTED", 409, "CONFLICT"],
  ])("maps %s without exposing Convex framing", async (code, status, publicCode) => {
    mutationMock.mockRejectedValue(new ConvexError({ code }));
    const response = await makeApp().request("/api/v1/deletions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "stable-key-1",
      },
      body: JSON.stringify({ scope: { type: "project", id: "project_1" } }),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      code: publicCode,
      details: { code },
    });
  });

  it("reads status through the receipt grant without project preflight", async () => {
    queryMock.mockResolvedValue(receipt);
    const response = await makeApp().request("/api/v1/deletions/request_1");

    expect(response.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[1]).toEqual({
      requestId: "request_1",
    });
  });

  it("returns a non-enumerating 404 for inaccessible receipts", async () => {
    queryMock.mockResolvedValue(null);
    const response = await makeApp().request("/api/v1/deletions/unknown");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("exposes cancellation as pending until the backend confirms it", async () => {
    mutationMock.mockResolvedValue({
      ...receipt,
      state: "cancel_pending",
      canCancel: false,
    });
    const response = await makeApp().request(
      "/api/v1/deletions/request_1/cancel",
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(202);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toEqual({
      requestId: "request_1",
    });
  });

  it("lets a current scope manager request a receipt grant", async () => {
    mutationMock.mockResolvedValue(receipt);
    const response = await makeApp().request(
      "/api/v1/deletions/request_1/authorize",
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toEqual({
      requestId: "request_1",
    });
  });
});
