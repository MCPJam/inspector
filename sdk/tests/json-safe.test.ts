import { describe, expect, it } from "vitest";
import { deepJsonSafe } from "../src/json-safe.js";
import { MCPAuthError } from "../src/mcp-client-manager/errors.js";

describe("deepJsonSafe", () => {
  it("flattens an MCPAuthError instance to plain JSON-safe data", () => {
    const safe = deepJsonSafe(new MCPAuthError("HTTP 401", 401));
    expect(safe).toEqual({
      name: "MCPAuthError",
      message: "HTTP 401",
      code: "AUTH_ERROR",
      statusCode: 401,
    });
    // Plain object, not a class instance — this is exactly what the Convex
    // write rejects otherwise.
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(safe))).toEqual(safe);
  });

  it("sanitizes errors nested inside detail payloads", () => {
    const cause = new Error("socket closed");
    const safe = deepJsonSafe({
      attempt: 1,
      error: new MCPAuthError("HTTP 401", 401, { cause }),
      missing: undefined,
      fn: () => "never",
    }) as Record<string, unknown>;
    expect(safe.attempt).toBe(1);
    expect(safe.error).toMatchObject({
      name: "MCPAuthError",
      statusCode: 401,
      cause: { name: "Error", message: "socket closed" },
    });
    expect("missing" in safe).toBe(false);
    expect("fn" in safe).toBe(false);
  });

  it("handles cycles, dates, and non-finite numbers", () => {
    const circular: Record<string, unknown> = { n: Number.NaN };
    circular.self = circular;
    circular.when = new Date("2026-08-24T00:00:00.000Z");
    const safe = deepJsonSafe(circular) as Record<string, unknown>;
    expect(safe.self).toBe("[circular]");
    expect(safe.n).toBe("NaN");
    expect(safe.when).toBe("2026-08-24T00:00:00.000Z");
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it("turns undefined array entries into null, matching JSON semantics", () => {
    expect(deepJsonSafe([1, undefined, () => 2])).toEqual([1, null, null]);
  });
});
