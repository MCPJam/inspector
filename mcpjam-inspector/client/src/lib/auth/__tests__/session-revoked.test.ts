import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionRevokedBody,
  isSessionRevokedResponse,
  notifySessionRevoked,
  resetSessionRevokedForTests,
  setSessionRevokedHandler,
} from "../session-revoked";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("session-revoked", () => {
  beforeEach(() => {
    resetSessionRevokedForTests();
  });

  describe("isSessionRevokedBody", () => {
    it("recognizes the /api/web and the /api/v1 envelope", () => {
      expect(isSessionRevokedBody({ code: "SESSION_REVOKED" })).toBe(true);
      expect(
        isSessionRevokedBody({
          code: "UNAUTHORIZED",
          details: { reason: "SESSION_REVOKED" },
        }),
      ).toBe(true);
    });

    it.each([
      null,
      "SESSION_REVOKED",
      {},
      { code: "UNAUTHORIZED" },
      { code: "UNAUTHORIZED", details: { reason: "other" } },
      { code: "UNAUTHORIZED", details: "SESSION_REVOKED" },
      { code: "FORBIDDEN", details: { reason: "SESSION_REVOKED" } },
    ])("rejects %j", (body) => {
      expect(isSessionRevokedBody(body)).toBe(false);
    });
  });

  describe("isSessionRevokedResponse", () => {
    it("reads a clone, leaving the body to the caller", async () => {
      const response = json({ code: "SESSION_REVOKED", message: "m" }, 401);

      expect(await isSessionRevokedResponse(response)).toBe(true);
      expect(await response.json()).toEqual({
        code: "SESSION_REVOKED",
        message: "m",
      });
    });

    it("is false for any other status, or a body that is not JSON", async () => {
      expect(
        await isSessionRevokedResponse(json({ code: "SESSION_REVOKED" }, 403)),
      ).toBe(false);
      expect(
        await isSessionRevokedResponse(new Response("nope", { status: 401 })),
      ).toBe(false);
      expect(
        await isSessionRevokedResponse({ status: 401 } as Response),
      ).toBe(false);
    });
  });

  describe("notifySessionRevoked", () => {
    it("runs the handler once per page load, however often it is called", () => {
      const handler = vi.fn();
      setSessionRevokedHandler(handler);

      notifySessionRevoked();
      notifySessionRevoked();
      notifySessionRevoked();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("delivers a refusal that arrived before the handler registered", () => {
      notifySessionRevoked();
      const handler = vi.fn();

      setSessionRevokedHandler(handler);
      setSessionRevokedHandler(handler);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("stops calling a handler once it unregisters", () => {
      const handler = vi.fn();
      const unregister = setSessionRevokedHandler(handler);
      unregister();

      notifySessionRevoked();

      expect(handler).not.toHaveBeenCalled();
    });

    it("survives a handler that throws", () => {
      setSessionRevokedHandler(() => {
        throw new Error("boom");
      });

      expect(() => notifySessionRevoked()).not.toThrow();
    });
  });
});
