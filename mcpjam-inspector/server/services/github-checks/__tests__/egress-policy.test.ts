import { describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_DENY_CIDRS,
  resolveEgressPolicy,
} from "../egress-policy";

describe("shared sandbox network policy", () => {
  it("keeps public access and the three private network blocks by default", () => {
    expect(resolveEgressPolicy(undefined)).toMatchObject({
      denyOut: [...DEFAULT_EGRESS_DENY_CIDRS],
      source: "default",
      weakensDefaults: false,
    });
  });
  it("reads a full replacement, including the existing explicit empty override", () => {
    expect(resolveEgressPolicy("169.254.0.0/16, 100.64.0.0/10")).toMatchObject({
      denyOut: ["169.254.0.0/16", "100.64.0.0/10"],
      source: "override",
      weakensDefaults: true,
    });
    expect(resolveEgressPolicy("")).toMatchObject({
      denyOut: [],
      weakensDefaults: true,
    });
  });
  it.each([
    "10.0.0.0/8,",
    "300.0.0.0/8",
    "10.0.0.0/33",
    "10.0.0.0/1e1",
    "010.0.0.0/8",
    "::/0",
    "secret-canary",
  ])("refuses malformed input without echoing it: %s", (raw) => {
    expect(() => resolveEgressPolicy(raw)).toThrow("E2B_EGRESS_DENY_CIDRS");
    try {
      resolveEgressPolicy(raw);
    } catch (error) {
      expect(String(error)).not.toContain(raw);
    }
  });
  it("does not share mutable arrays across callers", () => {
    resolveEgressPolicy(undefined).denyOut.length = 0;
    expect(resolveEgressPolicy(undefined).denyOut).toHaveLength(3);
  });
});
