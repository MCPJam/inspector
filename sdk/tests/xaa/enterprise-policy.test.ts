import { describe, expect, it } from "vitest";
import {
  readXaaEnterprisePolicy,
  withXaaEnterprisePolicy,
  withoutXaaEnterprisePolicy,
  XAA_ENTERPRISE_POLICY_EXTENSION,
} from "../../src/xaa/enterprise-policy.js";

const KEY = XAA_ENTERPRISE_POLICY_EXTENSION;

describe("readXaaEnterprisePolicy — three-state contract", () => {
  it("absent profile / absent extensions / absent key → off", () => {
    expect(readXaaEnterprisePolicy(undefined)).toEqual({ kind: "off" });
    expect(readXaaEnterprisePolicy(null)).toEqual({ kind: "off" });
    expect(readXaaEnterprisePolicy({ profileVersion: 1 })).toEqual({
      kind: "off",
    });
    expect(
      readXaaEnterprisePolicy({ extensions: { "other/ext": {} } })
    ).toEqual({ kind: "off" });
  });

  it("valid policy → on", () => {
    expect(
      readXaaEnterprisePolicy({ extensions: { [KEY]: { idp: "mcpjam" } } })
    ).toEqual({ kind: "on", policy: { idp: "mcpjam" } });
  });

  it("malformed value → invalid, never off", () => {
    for (const bad of ["yes", 1, true, null, ["mcpjam"]]) {
      const state = readXaaEnterprisePolicy({ extensions: { [KEY]: bad } });
      expect(state.kind, JSON.stringify(bad)).toBe("invalid");
    }
  });

  it("unsupported idp → invalid with an actionable reason", () => {
    const state = readXaaEnterprisePolicy({
      extensions: { [KEY]: { idp: "okta" } },
    });
    expect(state.kind).toBe("invalid");
    expect((state as { reason: string }).reason).toContain("okta");
    expect((state as { reason: string }).reason).toContain("mcpjam");
  });

  it("missing idp field → invalid", () => {
    expect(readXaaEnterprisePolicy({ extensions: { [KEY]: {} } }).kind).toBe(
      "invalid"
    );
  });

  it("non-object profile/extensions → invalid", () => {
    expect(readXaaEnterprisePolicy("junk").kind).toBe("invalid");
    expect(readXaaEnterprisePolicy({ extensions: "junk" }).kind).toBe(
      "invalid"
    );
  });

  it("non-plain objects (Date/Map/class instances) → invalid, never off", () => {
    // A malformed programmatic profile must fail closed — the loose
    // typeof-object check would have read these as "no extensions" = off.
    expect(readXaaEnterprisePolicy(new Date()).kind).toBe("invalid");
    expect(readXaaEnterprisePolicy(new Map()).kind).toBe("invalid");
    expect(
      readXaaEnterprisePolicy({ extensions: new Date() }).kind
    ).toBe("invalid");
    // Object.create(null) is still a plain record.
    expect(readXaaEnterprisePolicy(Object.create(null))).toEqual({
      kind: "off",
    });
  });
});

describe("withXaaEnterprisePolicy / withoutXaaEnterprisePolicy", () => {
  it("round-trips on/off restoring the original shape byte-for-byte", () => {
    const base = {
      profileVersion: 1,
      mcpProtocolVersion: "2025-11-25",
      extensions: { "other/ext": { a: 1 } },
    };
    const on = withXaaEnterprisePolicy(base);
    expect(readXaaEnterprisePolicy(on)).toEqual({
      kind: "on",
      policy: { idp: "mcpjam" },
    });
    expect((on.extensions as Record<string, unknown>)["other/ext"]).toEqual({
      a: 1,
    });
    const off = withoutXaaEnterprisePolicy(on);
    expect(off).toEqual(base);
  });

  it("materializes a minimal envelope from an absent profile and collapses back to undefined", () => {
    const on = withXaaEnterprisePolicy(undefined);
    expect(readXaaEnterprisePolicy(on).kind).toBe("on");
    expect(on.profileVersion).toBe(1);
    expect(withoutXaaEnterprisePolicy(on)).toBeUndefined();
  });

  it("preserves a pre-existing valid value, repairs an invalid one", () => {
    const valid = { extensions: { [KEY]: { idp: "mcpjam" } } };
    const kept = withXaaEnterprisePolicy(valid);
    expect((kept.extensions as Record<string, unknown>)[KEY]).toEqual({
      idp: "mcpjam",
    });
    const broken = { extensions: { [KEY]: { idp: "okta" } } };
    const repaired = withXaaEnterprisePolicy(broken);
    expect((repaired.extensions as Record<string, unknown>)[KEY]).toEqual({
      idp: "mcpjam",
    });
  });

  it("does not mutate its input", () => {
    const base = { profileVersion: 1, extensions: { [KEY]: { idp: "mcpjam" } } };
    const snapshot = JSON.parse(JSON.stringify(base));
    withoutXaaEnterprisePolicy(base);
    withXaaEnterprisePolicy(base);
    expect(base).toEqual(snapshot);
  });

  it("toggle-off repairs a malformed extensions container", () => {
    // extensions: null reads as invalid; leaving it in place would make the
    // host permanently invalid — the toggle is the documented repair path.
    const off = withoutXaaEnterprisePolicy({
      profileVersion: 1,
      extensions: null as unknown as Record<string, unknown>,
    });
    expect(off).toBeUndefined();
    const offKeepingSiblings = withoutXaaEnterprisePolicy({
      profileVersion: 1,
      mcpProtocolVersion: "2025-11-25",
      extensions: ["junk"] as unknown as Record<string, unknown>,
    });
    expect(offKeepingSiblings).toEqual({
      profileVersion: 1,
      mcpProtocolVersion: "2025-11-25",
    });
  });

  it("keeps a profile with other meaningful fields when the policy is removed", () => {
    const on = withXaaEnterprisePolicy({
      profileVersion: 1,
      initialize: { clientInfo: { name: "x", version: "1" } },
    });
    const off = withoutXaaEnterprisePolicy(on);
    expect(off).toEqual({
      profileVersion: 1,
      initialize: { clientInfo: { name: "x", version: "1" } },
    });
  });
});
