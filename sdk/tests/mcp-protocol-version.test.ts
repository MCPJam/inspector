/**
 * Predicate tests for `mcp-protocol-version.ts`.
 *
 * Pins the validate-then-route discipline: `isKnownProtocolVersion` is
 * the membership gate for trust boundaries; `isStatelessProtocolVersion`
 * is the routing predicate that ONLY runs on trusted input. The latter
 * returns true for typo strings — these tests document that explicitly
 * so nobody removes the upstream membership check thinking it's
 * redundant.
 */

import { describe, test, expect } from "vitest";
import {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
} from "../src/mcp-client-manager/mcp-protocol-version.js";

describe("MCP_PROTOCOL_VERSIONS", () => {
  test("exactly four supported versions", () => {
    expect(MCP_PROTOCOL_VERSIONS).toEqual([
      "2025-03-26",
      "2025-06-18",
      "2025-11-25",
      "2026-07-28",
    ]);
  });
});

describe("isKnownProtocolVersion (membership gate)", () => {
  test.each([
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
  ])("accepts %s", (v) => {
    expect(isKnownProtocolVersion(v)).toBe(true);
  });

  test.each([
    "",
    "legacy",
    "stateless",
    "stateless-2026-07-28",
    "DRAFT-2027-zzz",
    "2024-11-05",
    "2024-10-07",
    " 2026-07-28",
    "2026-07-28 ",
    // Regression guard: the pre-RC placeholder literal was retired on
    // upstream's a11b1550 pin to "2026-07-28". It must NOT re-enter the
    // accepted set; if it does, the validate-then-route discipline
    // silently widens.
    "DRAFT-2026-v1",
  ])("rejects %j", (v) => {
    expect(isKnownProtocolVersion(v)).toBe(false);
  });
});

describe("isStatelessProtocolVersion (routing predicate)", () => {
  test("returns false for empty string", () => {
    expect(isStatelessProtocolVersion("")).toBe(false);
  });

  test.each([
    "2024-10-07",
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
  ])("returns false for stateful version %s", (v) => {
    expect(isStatelessProtocolVersion(v)).toBe(false);
  });

  test("returns true for 2026-07-28", () => {
    expect(isStatelessProtocolVersion("2026-07-28")).toBe(true);
  });

  test("returns true for unknown / typo strings — documents why membership must run first", () => {
    // These tests pin the open-predicate hazard: without an upstream
    // `isKnownProtocolVersion` gate, typo strings flow into the
    // stateless branch and the factory builds a preview client with a
    // garbage wire literal. See feedback_validate_then_route memory.
    expect(isStatelessProtocolVersion("DRAFT-2027-zzz")).toBe(true);
    expect(isStatelessProtocolVersion("stateless")).toBe(true);
    expect(isStatelessProtocolVersion("anything-not-stateful")).toBe(true);
    // The retired placeholder routes stateless via the open predicate;
    // it would still produce a malformed wire literal if the membership
    // gate didn't reject it first.
    expect(isStatelessProtocolVersion("DRAFT-2026-v1")).toBe(true);
  });
});
