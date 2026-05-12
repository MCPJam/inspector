import { describe, expect, it } from "vitest";
import {
  matchesDomain,
  resolveSandboxCsp,
  resolveSandboxPermissions,
} from "../sandbox-policy";

describe("matchesDomain", () => {
  it("exact match", () => {
    expect(matchesDomain("https://api.example.com", "https://api.example.com")).toBe(true);
  });
  it("scheme mismatch fails closed", () => {
    expect(
      matchesDomain("https://api.example.com", "http://api.example.com"),
    ).toBe(false);
  });
  it("`*` matches anything", () => {
    expect(matchesDomain("*", "https://anything.com")).toBe(true);
  });
  it("`https://*` matches any https host", () => {
    expect(matchesDomain("https://*", "https://api.example.com")).toBe(true);
    expect(matchesDomain("https://*", "http://api.example.com")).toBe(false);
  });
  it("suffix wildcard matches subdomains AND the bare suffix", () => {
    expect(
      matchesDomain("https://*.example.com", "https://api.example.com"),
    ).toBe(true);
    expect(
      matchesDomain("https://*.example.com", "https://api.v2.example.com"),
    ).toBe(true);
    // Bare suffix matches too — per CSP spec for *.example.com.
    expect(
      matchesDomain("https://*.example.com", "https://example.com"),
    ).toBe(true);
  });
  it("suffix wildcard does NOT match unrelated hosts", () => {
    expect(
      matchesDomain("https://*.example.com", "https://attacker.com"),
    ).toBe(false);
    // Tricky: foo-example.com is NOT a subdomain of example.com even
    // though it ends with the same characters. The implementation
    // must use `.` boundary matching.
    expect(
      matchesDomain("https://*.example.com", "https://attackerexample.com"),
    ).toBe(false);
  });
});

describe("resolveSandboxCsp — mode picks baseline", () => {
  it("default mode is `declared` — baseline is the resource declaration", () => {
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["api.example.com"] },
      hostDefaultCsp: { connectDomains: ["should-not-show.com"] },
      isHostedMode: false,
    });
    expect(result.mode).toBe("declared");
    expect(result.baseline.connectDomains).toEqual(["api.example.com"]);
    expect(result.effective.connectDomains).toEqual(["api.example.com"]);
  });

  it("`host-default` baseline is the inspector's preset CSP", () => {
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["resource.com"] },
      hostDefaultCsp: { connectDomains: ["host-default.com"] },
      isHostedMode: false,
      profile: { profileVersion: 1, apps: { sandbox: { csp: { mode: "host-default" } } } },
    });
    expect(result.baseline.connectDomains).toEqual(["host-default.com"]);
  });

  it("`relaxed` baseline is the permissive CSP", () => {
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["resource.com"] },
      relaxedCsp: { connectDomains: ["*"] },
      isHostedMode: false,
      profile: { profileVersion: 1, apps: { sandbox: { csp: { mode: "relaxed" } } } },
    });
    expect(result.baseline.connectDomains).toEqual(["*"]);
  });
});

describe("resolveSandboxCsp — restrictTo intersection (applies in EVERY mode)", () => {
  it("intersects baseline with restrictTo (`declared` mode)", () => {
    // The most important regression: `mode: "declared"` is NOT a
    // bypass — restrictTo still applies on top of the resource
    // declaration. A bug that short-circuits resolution in declared
    // mode would silently widen access whenever the user pinned the
    // safest mode.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["api.ok.com", "api.other.com"],
      },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              mode: "declared",
              restrictTo: { connectDomains: ["api.ok.com"] },
            },
          },
        },
      },
    });
    expect(result.afterRestrictTo.connectDomains).toEqual(["api.ok.com"]);
    expect(result.effective.connectDomains).toEqual(["api.ok.com"]);
  });

  it("intersects baseline with restrictTo (`host-default` mode)", () => {
    const result = resolveSandboxCsp({
      hostDefaultCsp: { connectDomains: ["a.com", "b.com", "c.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              mode: "host-default",
              restrictTo: { connectDomains: ["b.com"] },
            },
          },
        },
      },
    });
    expect(result.afterRestrictTo.connectDomains).toEqual(["b.com"]);
  });

  it("NEVER unions undeclared domains in (SEP-1865 rule)", () => {
    // restrictTo CANNOT widen the baseline. A domain listed in
    // restrictTo but not in the baseline must NOT appear in
    // afterRestrictTo. Anything else would let the host grant
    // access the resource never declared.
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              restrictTo: { connectDomains: ["a.com", "c.com"] },
            },
          },
        },
      },
    });
    expect(result.effective.connectDomains).toEqual(["a.com"]);
    expect(result.effective.connectDomains).not.toContain("c.com");
  });
});

describe("resolveSandboxCsp — deny subtraction (applies in EVERY mode, wins over restrictTo)", () => {
  it("subtracts deny from baseline", () => {
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com", "b.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { csp: { deny: { connectDomains: ["a.com"] } } } },
      },
    });
    expect(result.afterDeny.connectDomains).toEqual(["b.com"]);
    expect(result.effective.connectDomains).toEqual(["b.com"]);
  });

  it("`declared` mode + deny still blocks (regression: declared is NOT a bypass)", () => {
    // The most-tested invariant of the resolver: mode picks the
    // baseline, but deny ALWAYS applies on top of it. A profile
    // saying "use the resource declaration, but block evil.com" must
    // produce an effective set without evil.com.
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com", "evil.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              mode: "declared",
              deny: { connectDomains: ["evil.com"] },
            },
          },
        },
      },
    });
    expect(result.effective.connectDomains).toEqual(["a.com"]);
  });

  it("deny wins over restrictTo when the same domain is in both", () => {
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              restrictTo: { connectDomains: ["a.com"] },
              deny: { connectDomains: ["a.com"] },
            },
          },
        },
      },
    });
    expect(result.effective.connectDomains).toEqual([]);
  });

  it("wildcard deny pattern subtracts matching subdomains", () => {
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.evil.com",
          "https://safe.com",
          "https://nested.api.evil.com",
        ],
      },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: { deny: { connectDomains: ["https://*.evil.com"] } },
          },
        },
      },
    });
    expect(result.effective.connectDomains).toEqual(["https://safe.com"]);
  });
});

describe("resolveSandboxCsp — hosted-mode hard clamp", () => {
  it("strips wildcards even when the user opted into `relaxed`", () => {
    // Defense-in-depth: the user CAN configure `relaxed` mode, but
    // hosted-mode strips wildcards regardless. If a profile editor
    // mistake could open a `*` hole in hosted mode, the clamp wins.
    const result = resolveSandboxCsp({
      relaxedCsp: { connectDomains: ["*", "https://api.ok.com"] },
      isHostedMode: true,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { csp: { mode: "relaxed" } } },
      },
    });
    expect(result.afterHostedClamp.connectDomains).toEqual([
      "https://api.ok.com",
    ]);
  });

  it("strips localhost/RFC-1918 in hosted mode", () => {
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "http://localhost:3000",
          "http://127.0.0.1",
          "http://192.168.1.5",
          "http://10.0.0.1",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips MCPJam same-origin in hosted mode", () => {
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "https://api.mcpjam.com",
          "https://auth.mcpjam.dev",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("does NOT strip when not in hosted mode (local dev keeps localhost etc.)", () => {
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["http://localhost:3000", "https://api.example.com"],
      },
      isHostedMode: false,
    });
    expect(result.effective.connectDomains).toEqual([
      "http://localhost:3000",
      "https://api.example.com",
    ]);
  });
});

describe("resolveSandboxPermissions", () => {
  it("default mode is `resource-declared` — pass declaration through", () => {
    const result = resolveSandboxPermissions({
      resourcePermissions: { camera: true, microphone: false },
      isHostedMode: false,
    });
    expect(result.mode).toBe("resource-declared");
    expect(result.effective).toEqual({ camera: true, microphone: false });
  });

  it("`deny-all` produces empty effective even when resource requested permissions", () => {
    const result = resolveSandboxPermissions({
      resourcePermissions: { camera: true, microphone: true },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { permissions: { mode: "deny-all" } } },
      },
    });
    expect(result.effective).toEqual({ camera: false, microphone: false });
  });

  it("custom mode + ceiling: host CANNOT grant a permission the resource didn't request", () => {
    // The resource is the ceiling. Even if the user explicitly
    // `allow.microphone = true`, the resource didn't ask for it, so
    // the effective stays false. Anything else would let the host
    // grant permissions the resource never opted into.
    const result = resolveSandboxPermissions({
      resourcePermissions: { camera: true }, // microphone NOT declared
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            permissions: {
              mode: "custom",
              allow: { camera: true, microphone: true },
            },
          },
        },
      },
    });
    expect(result.effective.microphone).toBe(false);
    expect(result.effective.camera).toBe(true);
  });

  it("deny wins even when resource AND allow both grant", () => {
    const result = resolveSandboxPermissions({
      resourcePermissions: { camera: true },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            permissions: {
              mode: "custom",
              allow: { camera: true },
              deny: ["camera"],
            },
          },
        },
      },
    });
    expect(result.effective.camera).toBe(false);
  });

  it("hosted-mode clamp strips sensitive permissions even when the profile granted them", () => {
    // Defense-in-depth: a hosted-mode chatbox cannot grant
    // camera/microphone/geolocation regardless of profile intent.
    const result = resolveSandboxPermissions({
      resourcePermissions: { camera: true, geolocation: true, "clipboard-write": true },
      isHostedMode: true,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            permissions: {
              mode: "custom",
              allow: { camera: true, geolocation: true, "clipboard-write": true },
            },
          },
        },
      },
    });
    expect(result.effective.camera).toBe(false);
    expect(result.effective.geolocation).toBe(false);
    // clipboard-write deliberately NOT clamped (most apps need it
    // for "copy to clipboard" buttons).
    expect(result.effective["clipboard-write"]).toBe(true);
  });
});
