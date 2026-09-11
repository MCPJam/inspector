import { describe, expect, it } from "vitest";
import {
  browserSessionPolicySchema,
  compileBrowserPolicy,
  intersectBrowserPolicies,
  browserPolicyWithin,
  browserPolicyAllowsOrigin,
  browserPolicyAllowsTool,
} from "../browser-session-policy";

describe("session browser policy", () => {
  it("rejects empty, inert, unknown and ambiguous grants", () => {
    for (const policy of [
      { mode: "allow_all", originAllowlist: [] },
      { mode: "read_only", toolAllowlist: ["browser_observe"] },
      { mode: "allowlist" },
      { mode: "allow_all", unknown: true },
      ...[
        "example.com",
        "https://a.test/path",
        "https://u:p@a.test",
        "https://a.test?x",
        "file:///tmp",
      ].map((origin) => ({ mode: "allow_all", originAllowlist: [origin] })),
    ])
      expect(browserSessionPolicySchema.safeParse(policy).success).toBe(false);
  });
  it("canonicalizes origins and tool sets", () => {
    expect(
      browserSessionPolicySchema.parse({
        mode: "allowlist",
        originAllowlist: ["https://EXAMPLE.com:443/", "https://example.com"],
        toolAllowlist: ["browser_observe", "browser_observe"],
      }),
    ).toEqual({
      mode: "allowlist",
      originAllowlist: ["https://example.com"],
      toolAllowlist: ["browser_observe"],
    });
  });
  it("keeps disjoint intersections denied and combines read-only with origin restrictions", () => {
    const a = compileBrowserPolicy({
      mode: "allowlist",
      originAllowlist: ["https://a.test"],
      toolAllowlist: ["browser_navigate"],
    });
    const b = compileBrowserPolicy({
      mode: "read_only",
      originAllowlist: ["https://b.test"],
    });
    const effective = intersectBrowserPolicies(a, b);
    expect(effective).toEqual({ tools: [], origins: [] });
    expect(browserPolicyAllowsTool(effective, "browser_navigate")).toBe(false);
    expect(browserPolicyAllowsOrigin(effective, "https://a.test")).toBe(false);
    expect(browserPolicyWithin(b, a)).toBe(false);
  });
  it("narrows legacy hostname ceilings without broadening ports", () => {
    const grant = compileBrowserPolicy({
      mode: "allow_all",
      originAllowlist: ["https://a.test:8443"],
    });
    const ceiling = compileBrowserPolicy({
      mode: "allow_all",
      originAllowlist: ["a.test"],
    });
    expect(browserPolicyWithin(grant, ceiling)).toBe(true);
    expect(browserPolicyWithin(ceiling, grant)).toBe(false);
    const effective = intersectBrowserPolicies(grant, ceiling);
    expect(
      browserPolicyAllowsOrigin(effective, "https://a.test:8443/path"),
    ).toBe(true);
    expect(browserPolicyAllowsOrigin(effective, "https://a.test/path")).toBe(
      false,
    );
  });
});
