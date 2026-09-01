/**
 * The unattended browser policy parser. Its whole job is to be STRICT: an
 * unattended run has no approval, so this parse is the entire authorization
 * story. Anything it does not fully understand must yield `undefined` (⇒ no
 * browser tools), never a permissive default.
 */
import { describe, expect, it } from "vitest";
import {
  browserApprovalDeliveryFor,
  parseBrowserToolPolicy,
} from "../browser-tool-policy";

describe("parseBrowserToolPolicy — accepts what it fully understands", () => {
  it("accepts the three modes", () => {
    expect(parseBrowserToolPolicy({ mode: "allow_all" })).toEqual({
      mode: "allow_all",
    });
    expect(parseBrowserToolPolicy({ mode: "read_only" })).toEqual({
      mode: "read_only",
    });
    expect(
      parseBrowserToolPolicy({
        mode: "allowlist",
        originAllowlist: ["https://example.com"],
      }),
    ).toEqual({ mode: "allowlist", originAllowlist: ["https://example.com"] });
  });

  it("keeps both allowlists and trims blank entries", () => {
    expect(
      parseBrowserToolPolicy({
        mode: "allowlist",
        originAllowlist: [" https://a.test ", ""],
        toolAllowlist: ["browser_observe", "  "],
      }),
    ).toEqual({
      mode: "allowlist",
      originAllowlist: ["https://a.test"],
      toolAllowlist: ["browser_observe"],
    });
  });

  it("omits empty allowlists on non-allowlist modes rather than storing []", () => {
    expect(
      parseBrowserToolPolicy({ mode: "read_only", originAllowlist: [] }),
    ).toEqual({ mode: "read_only" });
  });
});

describe("parseBrowserToolPolicy — refuses everything else", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "allow_all"],
    ["an array", [{ mode: "allow_all" }]],
    ["no mode", {}],
    ["an unknown mode", { mode: "yolo" }],
    ["a near-miss mode", { mode: "allowAll" }],
    ["a non-string mode", { mode: 1 }],
    ["a non-array originAllowlist", { mode: "allow_all", originAllowlist: "x" }],
    [
      "a non-string allowlist entry",
      { mode: "allow_all", toolAllowlist: ["ok", 7] },
    ],
    // An allowlist with nothing in it would silently mean "everything" —
    // the exact opposite of what the word says.
    ["an allowlist mode with empty lists", { mode: "allowlist" }],
    [
      "an allowlist mode with only blank entries",
      { mode: "allowlist", originAllowlist: ["  "] },
    ],
  ])("refuses %s", (_label, input) => {
    expect(parseBrowserToolPolicy(input)).toBeUndefined();
  });
});

describe("browserApprovalDeliveryFor", () => {
  it("wraps a valid policy as unattended delivery", () => {
    expect(browserApprovalDeliveryFor({ mode: "read_only" })).toEqual({
      kind: "unattended",
      policy: { mode: "read_only" },
    });
  });

  it("yields undefined for a missing or malformed policy — the fail-closed path", () => {
    // `undefined` reaching `resolveHostTools` means the run gets NO browser
    // tools, which is the correct outcome for a run nobody authorized.
    expect(browserApprovalDeliveryFor(undefined)).toBeUndefined();
    expect(browserApprovalDeliveryFor({ mode: "nope" })).toBeUndefined();
  });
});
