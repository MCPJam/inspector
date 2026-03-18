/**
 * Unit tests for mergeHeaders and mergeHeadersForAuthServer.
 *
 * These are smoke tests for the shared helpers, exercised directly
 * (without going through any state machine) so every machine that
 * delegates to them gets coverage for free.
 */

import { describe, it, expect } from "vitest";
import {
  mergeHeaders,
  mergeHeadersForAuthServer,
} from "../state-machines/shared/helpers";

describe("mergeHeaders", () => {
  it("returns request headers overriding custom headers", () => {
    const result = mergeHeaders(
      { "X-Custom": "custom-value", Accept: "text/html" },
      { Accept: "application/json" },
    );
    expect(result).toEqual({
      "X-Custom": "custom-value",
      Accept: "application/json",
    });
  });

  it("treats header names case-insensitively when request headers override custom headers", () => {
    const result = mergeHeaders(
      { authorization: "Bearer old-token" },
      { Authorization: "Bearer new-token" },
    );

    expect(
      Object.keys(result).filter((key) => key.toLowerCase() === "authorization"),
    ).toHaveLength(1);
    expect(result.Authorization).toBe("Bearer new-token");
  });

  it("returns custom headers when no request headers provided", () => {
    const result = mergeHeaders({ "X-Custom": "value" });
    expect(result).toEqual({ "X-Custom": "value" });
  });

  it("returns request headers when custom headers are undefined", () => {
    const result = mergeHeaders(undefined, { Accept: "application/json" });
    expect(result).toEqual({ Accept: "application/json" });
  });
});

describe("mergeHeadersForAuthServer", () => {
  it("strips Authorization header (standard casing)", () => {
    const result = mergeHeadersForAuthServer({
      Authorization: "Bearer secret",
      "X-Custom": "keep",
    });
    expect(result).not.toHaveProperty("Authorization");
    expect(result["X-Custom"]).toBe("keep");
  });

  it("strips AUTHORIZATION (all-caps)", () => {
    const result = mergeHeadersForAuthServer({
      AUTHORIZATION: "Bearer secret",
    });
    expect(result).not.toHaveProperty("AUTHORIZATION");
  });

  it("strips authORIZATION (mixed case)", () => {
    const result = mergeHeadersForAuthServer({
      authORIZATION: "Bearer secret",
    });
    expect(result).not.toHaveProperty("authORIZATION");
  });

  it("keeps all non-Authorization headers", () => {
    const result = mergeHeadersForAuthServer({
      "X-Api-Key": "abc",
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(result).toEqual({
      "X-Api-Key": "abc",
      "Content-Type": "application/json",
    });
  });

  it("handles undefined customHeaders", () => {
    const result = mergeHeadersForAuthServer(undefined);
    expect(result).toEqual({});
  });

  it("handles undefined customHeaders with request headers", () => {
    const result = mergeHeadersForAuthServer(undefined, {
      "Content-Type": "application/json",
    });
    expect(result).toEqual({ "Content-Type": "application/json" });
  });
});
