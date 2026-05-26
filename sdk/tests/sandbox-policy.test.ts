/**
 * Unit tests for the pure sandbox-policy resolver. Mirrors the
 * "Sandbox policy enforcement" section of the inspector plan
 * (`/Users/marcelojimenezrocabado/.claude/plans/inspector-mcp-profile.md`):
 *
 *   1. mode picks the BASELINE; restrictTo + deny always apply on top.
 *   2. restrictTo INTERSECTS — never unions undeclared domains.
 *   3. deny SUBTRACTS — wins over restrictTo, baseline, and resource decl.
 *   4. Hosted-mode HARD CLAMP strips dangerous values regardless.
 *
 * Each test names the precedence rule it guards so a future regression
 * triages straight to which step broke.
 */

import { describe, expect, test } from "vitest";
import {
  resolveSandboxCsp,
  resolveSandboxPermissions,
} from "../src/sandbox-policy";

describe("resolveSandboxCsp — baseline selection from `mode`", () => {
  test("declared mode: baseline = resource declaration", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["a.com", "b.com"],
      },
      policy: { mode: "declared" },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com", "b.com"]);
    expect(csp.trace.effectiveMode).toBe("declared");
  });

  test("declared mode: resource omitted → SEP-1865 secure default (empty)", () => {
    const csp = resolveSandboxCsp({
      // No resourceCsp passed.
      policy: { mode: "declared" },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual([]);
    expect(csp.resourceDomains).toEqual([]);
  });

  test("declared mode is default when policy.mode is omitted", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com"] },
      // No policy.mode set.
      hostedMode: false,
    });
    expect(csp.trace.effectiveMode).toBe("declared");
    expect(csp.connectDomains).toEqual(["a.com"]);
  });

  test("host-default mode: baseline = caller-supplied hostDefaultBaseline", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["resource.com"] },
      hostDefaultBaseline: { connectDomains: ["host-default.com"] },
      policy: { mode: "host-default" },
      hostedMode: false,
    });
    // Resource declaration is ignored in this mode.
    expect(csp.connectDomains).toEqual(["host-default.com"]);
  });

  test("relaxed mode: hostedMode=false uses hostDefaultBaseline if provided", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["resource.com"] },
      hostDefaultBaseline: { connectDomains: ["relaxed.com"] },
      policy: { mode: "relaxed" },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["relaxed.com"]);
  });
});

describe("resolveSandboxCsp — restrictTo intersects in every mode", () => {
  test("declared mode + restrictTo: intersection drops domains not in restrictTo", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com", "b.com", "c.com"] },
      policy: {
        mode: "declared",
        restrictTo: { connectDomains: ["a.com", "c.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com", "c.com"]);
  });

  test("declared mode + restrictTo: NEVER unions undeclared domains (SEP-1865)", () => {
    // Resource declared only a.com; restrictTo lists evil.com too.
    // Intersection means evil.com is NEVER added — host MUST NOT loosen.
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com"] },
      policy: {
        mode: "declared",
        restrictTo: { connectDomains: ["a.com", "evil.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com"]);
    expect(csp.connectDomains).not.toContain("evil.com");
  });

  test("host-default mode + restrictTo: intersection still applies (not a bypass)", () => {
    const csp = resolveSandboxCsp({
      hostDefaultBaseline: { connectDomains: ["a.com", "b.com"] },
      policy: {
        mode: "host-default",
        restrictTo: { connectDomains: ["a.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com"]);
  });

  test("relaxed mode + restrictTo: intersection still applies", () => {
    const csp = resolveSandboxCsp({
      hostDefaultBaseline: { connectDomains: ["a.com", "b.com"] },
      policy: {
        mode: "relaxed",
        restrictTo: { connectDomains: ["a.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com"]);
  });

  test("restrictTo omitted for a directive: baseline passes through unchanged", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["a.com", "b.com"],
        resourceDomains: ["res.com"],
      },
      policy: {
        mode: "declared",
        restrictTo: { connectDomains: ["a.com"] },
        // No resourceDomains restriction.
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com"]);
    expect(csp.resourceDomains).toEqual(["res.com"]);
  });

  test("restrictTo matches case-insensitively (parity with deny)", () => {
    // Regression for the case-mismatch class: restrictTo used to do
    // strict Set.has() equality while deny did case-insensitive
    // matching. A user who wrote `Api.Example.COM` (typo, copy-paste
    // from a docs example with mixed case, etc.) would have their
    // restrictTo entry silently fail to match a lowercased
    // resource-declared `api.example.com` — domain dropped from the
    // intersection without any signal. The two matching strategies
    // within the same resolver must agree.
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["https://api.example.com"] },
      policy: {
        mode: "declared",
        // Mixed-case restrictTo MUST match the lower-case baseline.
        restrictTo: { connectDomains: ["HTTPS://API.EXAMPLE.COM"] },
      },
      hostedMode: false,
    });
    // Result keeps the baseline-cased original — restrictTo is just a
    // lookup index, not the source of truth for the emitted CSP.
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
  });

  test("restrictTo case-insensitive: mixed-case baseline + lower-case restrictTo also matches", () => {
    // Symmetric direction of the previous test — verifies the lookup
    // is case-insensitive regardless of which side has the casing
    // variation.
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["HTTPS://Api.Example.COM"] },
      policy: {
        mode: "declared",
        restrictTo: { connectDomains: ["https://api.example.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["HTTPS://Api.Example.COM"]);
  });
});

describe("resolveSandboxCsp — deny subtracts in every mode", () => {
  test("declared mode + deny: subtraction (NOT a bypass — deny applies even in declared)", () => {
    // The exact regression the plan flagged: `declared` is NOT a bypass.
    // deny applies regardless of mode.
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com", "b.com"] },
      policy: {
        mode: "declared",
        deny: { connectDomains: ["a.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["b.com"]);
    expect(csp.connectDomains).not.toContain("a.com");
  });

  test("deny wins over restrictTo: a domain in both is denied", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com", "b.com"] },
      policy: {
        mode: "declared",
        restrictTo: { connectDomains: ["a.com"] },
        deny: { connectDomains: ["a.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual([]);
  });

  test("deny wins over resource declaration", () => {
    // The user's stated semantics: deny is absolute.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["api.example.com", "api.evil.com"],
      },
      policy: {
        mode: "declared",
        deny: { connectDomains: ["api.evil.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["api.example.com"]);
  });

  test("deny wildcard pattern strips matching subdomains", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.evil.com",
          "https://other.evil.com",
          "https://good.com",
        ],
      },
      policy: {
        mode: "declared",
        deny: { connectDomains: ["https://*.evil.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["https://good.com"]);
  });

  test("host-default mode + deny: deny still applies", () => {
    const csp = resolveSandboxCsp({
      hostDefaultBaseline: { connectDomains: ["a.com", "b.com"] },
      policy: {
        mode: "host-default",
        deny: { connectDomains: ["a.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["b.com"]);
  });
});

describe("resolveSandboxCsp — hosted-mode clamp", () => {
  test("hosted clamp strips wildcards regardless of profile (relaxed mode)", () => {
    const csp = resolveSandboxCsp({
      hostDefaultBaseline: { connectDomains: ["*", "https:", "https://good.com"] },
      policy: { mode: "relaxed" },
      hostedMode: true,
    });
    // `*` and `https:` are dangerous; only the explicit https://good.com survives.
    expect(csp.connectDomains).toEqual(["https://good.com"]);
    expect(csp.trace.hostedClamp.stripped.connectDomains).toContain("*");
    expect(csp.trace.hostedClamp.stripped.connectDomains).toContain("https:");
  });

  test("hosted clamp strips localhost and private-network ranges", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://localhost:3000",
          "http://127.0.0.1:8080",
          "https://10.0.0.5",
          "https://192.168.1.1",
          "https://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    // Only the public domain survives.
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
  });

  test("hosted clamp strips unsafe schemes", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["javascript:alert(1)", "https://safe.com"],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://safe.com"]);
  });

  test("hosted clamp strips bare host:port forms (no scheme)", () => {
    // P1 regression: the bare-host fallback used to call
    // `isDangerousHostname` directly on strings like "localhost:3000",
    // which the loopback/private-network patterns wouldn't match (they
    // expect a port-less hostname). A hosted widget could declare a
    // bare loopback source and escape the clamp. The URL-prefixed and
    // protocol-relative forms have always been stripped — only the bare
    // form leaked through.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "localhost:3000",
          "127.0.0.1:8080",
          "[::1]:9000",
          "10.0.0.5:5432",
          "192.168.1.1:80",
          "api.example.com:443",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    // Only the public domain (with port) survives.
    expect(csp.connectDomains).toEqual(["api.example.com:443"]);
    expect(csp.trace.hostedClamp.stripped.connectDomains).toEqual(
      expect.arrayContaining([
        "localhost:3000",
        "127.0.0.1:8080",
        "[::1]:9000",
        "10.0.0.5:5432",
        "192.168.1.1:80",
      ]),
    );
  });

  test("hosted clamp strips bare loopback hosts with path suffix", () => {
    // Same family as the port case: CSP host-source allows a path
    // component (`host:port path`). The URL parser drops paths just as
    // it drops ports, so this lands on the same fix as :port — covered
    // explicitly because the original predicate would have left these
    // untouched.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["localhost/api", "127.0.0.1/admin"],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual([]);
  });

  test("hosted clamp is a no-op when hostedMode=false (dev)", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["https://localhost:3000", "*", "https://api.com"],
      },
      policy: { mode: "declared" },
      hostedMode: false,
    });
    // All preserved — dev mode trusts whatever the resource declared.
    expect(csp.connectDomains).toEqual([
      "https://localhost:3000",
      "*",
      "https://api.com",
    ]);
    expect(csp.trace.hostedClamp.stripped).toEqual({});
  });

  test("hosted clamp strips bare WILDCARD loopback hosts (P1 regression)", () => {
    // The exact bypass Codex flagged: `*.localhost` and friends used to
    // hit the wildcard branch and return false WITHOUT any hostname
    // check, while the URL form `https://*.localhost` was correctly
    // stripped via `.endsWith(".localhost")`. A hosted widget could
    // declare the bare wildcard syntax to keep loopback targets in
    // the allowlist. Now both shapes are stripped via a two-pass
    // wildcard check (parse with wildcard preserved + strip leading
    // `*.` and recheck the suffix).
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "*.localhost",
          "*.localhost:3000",
          "https://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
    const stripped =
      csp.trace.hostedClamp.stripped.connectDomains ?? [];
    expect(stripped).toContain("*.localhost");
    expect(stripped).toContain("*.localhost:3000");
  });

  test("hosted clamp strips bare WILDCARD IPv4 private-network hosts", () => {
    // Pass 1 of the two-pass check (wildcard-preserved hostname) misses
    // `*.10.0.0.1` because the URL parser yields `*.10.0.0.1` and that
    // doesn't match the IPv4 regex. Pass 2 strips the leading `*.` and
    // rechecks `10.0.0.1` against the RFC1918 regex. Without pass 2,
    // a hosted widget could pin `*.10.0.0.1` and keep internal-network
    // exfiltration targets.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "*.10.0.0.1",
          "*.192.168.1.1",
          "*.172.16.0.1",
          "*.169.254.1.1",
          "https://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
  });

  test("hosted clamp PRESERVES bare wildcards of public domains", () => {
    // Counter-test: the two-pass wildcard check MUST NOT strip benign
    // public-domain wildcards like `*.example.com`. The stripped
    // suffix `example.com` is not loopback/private; the URL parser
    // returns `*.example.com` as hostname, which also doesn't match
    // any dangerous-hostname pattern.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "*.example.com",
          "*.cdn.example.com",
          "*.cloudflare.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual([
      "*.example.com",
      "*.cdn.example.com",
      "*.cloudflare.com",
    ]);
    expect(csp.trace.hostedClamp.stripped.connectDomains ?? []).toEqual([]);
  });
});

describe("resolveSandboxCsp — hostedClampExtraDeny (app-specific clamp)", () => {
  // P1 regression: a hosted widget could declare app-sensitive origins
  // (e.g. https://app.mcpjam.com) in connectDomains and have them
  // forwarded into the iframe's CSP — letting it exfiltrate the user's
  // session. policy.deny is profile-overridable (bypassable); this
  // caller-supplied clamp is not.

  test("strips exact matches in hosted mode", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://app.mcpjam.com/api/secret",
          "https://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
      hostedClampExtraDeny: {
        connectDomains: ["https://app.mcpjam.com/api/secret"],
      },
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
    expect(csp.trace.hostedClamp.stripped.connectDomains).toContain(
      "https://app.mcpjam.com/api/secret",
    );
  });

  test("wildcard pattern strips all matching subdomains", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://app.mcpjam.com",
          "https://api.mcpjam.com",
          "https://www.mcpjam.com",
          "https://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
      hostedClampExtraDeny: {
        connectDomains: ["https://*.mcpjam.com"],
      },
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
  });

  test("hostedClampExtraDeny is a no-op when hostedMode=false (dev preserves)", () => {
    // The clamp gates on hostedMode === true. In dev/local mode, the
    // user explicitly opted out of strict behavior — same rationale as
    // the built-in clamp predicate. Keeps "develop locally with full
    // freedom" workable.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://app.mcpjam.com",
          "https://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: false,
      hostedClampExtraDeny: {
        connectDomains: ["https://*.mcpjam.com"],
      },
    });
    expect(csp.connectDomains).toEqual([
      "https://app.mcpjam.com",
      "https://api.example.com",
    ]);
    expect(csp.trace.hostedClamp.stripped).toEqual({});
  });

  test("built-in dangerous patterns AND extra deny both run in one pass", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "*", // stripped by built-in (wildcard)
          "https://localhost:3000", // stripped by built-in (loopback)
          "https://app.mcpjam.com", // stripped by extra
          "https://api.example.com", // kept
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
      hostedClampExtraDeny: {
        connectDomains: ["https://*.mcpjam.com"],
      },
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
    // Trace surfaces both reasons so the debug UI can show why.
    const stripped = csp.trace.hostedClamp.stripped.connectDomains ?? [];
    expect(stripped).toContain("*");
    expect(stripped).toContain("https://localhost:3000");
    expect(stripped).toContain("https://app.mcpjam.com");
  });

  test("hostedClampExtraDeny applied per-directive (frameDomains alone)", () => {
    // restrictTo / deny shapes are per-directive; hostedClampExtraDeny
    // mirrors that. A caller can strip only specific directives without
    // touching others. Important for the inspector use case where only
    // connect/resource/frame/baseUri need MCPJam stripping (no other
    // directive families exist today, but the shape supports growth).
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["https://app.mcpjam.com"],
        frameDomains: ["https://app.mcpjam.com"],
      },
      policy: { mode: "declared" },
      hostedMode: true,
      hostedClampExtraDeny: {
        // Only frameDomains is gated; connectDomains intentionally NOT
        // listed here.
        frameDomains: ["https://*.mcpjam.com"],
      },
    });
    expect(csp.frameDomains).toEqual([]);
    expect(csp.connectDomains).toEqual(["https://app.mcpjam.com"]);
  });

  test("hosted-mode relaxed profile: extra-deny clamp STILL strips MCPJam origins", () => {
    // P1 regression: a saved profile with mode="relaxed" used to bypass
    // the resolver entirely in the renderer, silently dropping the
    // hosted clamp's MCPJam-origin extra-deny. After the renderer-side
    // fix, relaxed-in-hosted-mode falls through into resolveSandboxCsp,
    // so the security contract here MUST hold:
    //
    //   "Hosted clamp is non-bypassable — saved profiles cannot opt out
    //    of stripping MCPJam-origin access from widget-declared CSP."
    //
    // Without this guarantee a hosted user could save mode=relaxed +
    // declare MCPJam origins in connectDomains and exfiltrate via the
    // iframe's session.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://app.mcpjam.com",
          "https://api.example.com",
        ],
      },
      // Caller passes the resource as hostDefaultBaseline because
      // relaxed mode's "permissive baseline" is conceptually unbounded
      // (the renderer treats it as "use whatever the widget declared").
      hostDefaultBaseline: {
        connectDomains: [
          "https://app.mcpjam.com",
          "https://api.example.com",
        ],
      },
      policy: { mode: "relaxed" },
      hostedMode: true,
      hostedClampExtraDeny: {
        connectDomains: ["https://*.mcpjam.com"],
      },
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
    expect(csp.trace.hostedClamp.stripped.connectDomains).toContain(
      "https://app.mcpjam.com",
    );
  });

  test("relaxed + restrictTo: restrictTo applies even though mode is relaxed", () => {
    // The other half of the "deny always wins / restrictTo applies in
    // every mode" guarantee: a saved relaxed profile that ALSO sets
    // restrictTo should intersect, not bypass. Renderer treats
    // resource-declared CSP as the baseline; restrictTo narrows.
    const csp = resolveSandboxCsp({
      hostDefaultBaseline: {
        connectDomains: ["a.com", "b.com", "c.com"],
      },
      policy: {
        mode: "relaxed",
        restrictTo: { connectDomains: ["a.com", "b.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["a.com", "b.com"]);
  });

  test("extra deny survives all earlier precedence steps (resource+restrictTo+deny)", () => {
    // Full pipeline: resource declares everything, restrictTo keeps a
    // subset, profile.deny removes one, then hostedClampExtraDeny still
    // strips the app origin even though restrictTo "allowed" it. This
    // proves the clamp is non-bypassable from the profile editor.
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://app.mcpjam.com",
          "https://api.example.com",
          "https://evil.com",
          "https://other.com",
        ],
      },
      policy: {
        mode: "declared",
        restrictTo: {
          connectDomains: [
            "https://app.mcpjam.com",
            "https://api.example.com",
            "https://evil.com",
          ],
        },
        deny: { connectDomains: ["https://evil.com"] },
      },
      hostedMode: true,
      hostedClampExtraDeny: {
        connectDomains: ["https://*.mcpjam.com"],
      },
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
  });
});

describe("resolveSandboxCsp — combined precedence (the full pipeline)", () => {
  test("resource + restrictTo + deny + hosted clamp run in order", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "https://evil.example.com",
          "https://other.example.com",
          "https://localhost:3000",
        ],
      },
      policy: {
        mode: "declared",
        restrictTo: {
          connectDomains: [
            "https://api.example.com",
            "https://evil.example.com",
            "https://localhost:3000",
            // other.example.com intentionally NOT in restrictTo → dropped at step 2
          ],
        },
        deny: {
          connectDomains: ["https://evil.example.com"], // wins at step 3
        },
      },
      hostedMode: true, // strips localhost at step 4
    });
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
  });

  test("trace captures each intermediate stage", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["a.com", "b.com", "c.com"] },
      policy: {
        mode: "declared",
        restrictTo: { connectDomains: ["a.com", "b.com"] },
        deny: { connectDomains: ["a.com"] },
      },
      hostedMode: false,
    });
    expect(csp.trace.baseline.connectDomains).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
    expect(csp.trace.afterRestrictTo.connectDomains).toEqual(["a.com", "b.com"]);
    expect(csp.trace.afterDeny.connectDomains).toEqual(["b.com"]);
    expect(csp.connectDomains).toEqual(["b.com"]);
  });
});

describe("resolveSandboxPermissions", () => {
  test("resource declaration is the CEILING — profile cannot grant what resource didn't request", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: { camera: true },
      policy: {
        mode: "custom",
        allow: { camera: true, microphone: true }, // microphone NOT in declared
      },
      hostedMode: false,
    });
    expect(perms.granted).toEqual({ camera: true });
    expect(perms.granted).not.toHaveProperty("microphone");
  });

  test("deny-all mode: empty allow= regardless of resource declaration", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: { camera: true, microphone: true },
      policy: { mode: "deny-all" },
      hostedMode: false,
    });
    expect(perms.granted).toEqual({});
  });

  test("resource-declared mode passes the resource's request through", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: { camera: true, geolocation: true },
      policy: { mode: "resource-declared" },
      hostedMode: false,
    });
    expect(perms.granted).toEqual({ camera: true, geolocation: true });
  });

  test("hosted clamp strips sensitive permissions regardless of mode", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: {
        camera: true,
        microphone: true,
        geolocation: true,
        clipboardWrite: true,
      },
      policy: { mode: "resource-declared" }, // user opted into resource-declared
      hostedMode: true,
    });
    // Default hostedClampDeny strips camera/microphone/geolocation.
    expect(perms.granted).toEqual({ clipboardWrite: true });
    expect(perms.trace.deniedByHostedClamp).toEqual(
      expect.arrayContaining(["camera", "microphone", "geolocation"]),
    );
  });

  test("profile deny removes clipboardWrite by its camelCase MCP key", () => {
    // P2 regression: the resolver does plain string-key matching against
    // `resourcePermissions`, which is the spec's `_meta.ui.permissions`
    // map (camelCase per SEP-1865). A profile that denied
    // `"clipboard-write"` (kebab, the Permission-Policy spelling) used
    // to silently no-op because no resource key by that name existed.
    // The clamp doc and HostConfigEditor now both standardize on the
    // camelCase MCP key — this test pins that semantics.
    const perms = resolveSandboxPermissions({
      resourcePermissions: { clipboardWrite: true, camera: true },
      policy: { mode: "resource-declared", deny: ["clipboardWrite"] },
      hostedMode: false,
    });
    expect(perms.granted).toEqual({ camera: true });
    expect(perms.trace.deniedByProfile).toEqual(["clipboardWrite"]);
  });

  test("custom mode allows clipboardWrite by its camelCase MCP key", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: { clipboardWrite: true, camera: true },
      policy: {
        mode: "custom",
        allow: { clipboardWrite: true },
      },
      hostedMode: false,
    });
    // resource declaration is the ceiling; only the allow entry passes.
    expect(perms.granted).toEqual({ clipboardWrite: true });
  });

  test("profile deny wins over allow", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: { camera: true, microphone: true },
      policy: {
        mode: "custom",
        allow: { camera: true, microphone: true },
        deny: ["microphone"],
      },
      hostedMode: false,
    });
    expect(perms.granted).toEqual({ camera: true });
    expect(perms.trace.deniedByProfile).toEqual(["microphone"]);
  });

  // Guards the aliasing regression: `trace.afterMode` used to point at the
  // same object as `granted`, so the in-place `delete` mutations in
  // step 3 + step 4 silently erased the stage-2 snapshot. A future
  // refactor that re-aliases must trip this test.
  test("trace.afterMode is the post-mode snapshot, NOT the final granted set", () => {
    const perms = resolveSandboxPermissions({
      resourcePermissions: { camera: true, microphone: true, geolocation: true },
      policy: {
        mode: "resource-declared",
        deny: ["microphone"], // removed at step 3
      },
      hostedMode: true, // step 4 strips camera + geolocation
    });
    expect(perms.granted).toEqual({});
    // afterMode should still include EVERY resource-declared permission —
    // it captures the candidate set right after mode application, before
    // any subtraction.
    expect(perms.trace.afterMode).toEqual({
      camera: true,
      microphone: true,
      geolocation: true,
    });
    expect(perms.trace.deniedByProfile).toEqual(["microphone"]);
    expect(perms.trace.deniedByHostedClamp).toEqual(
      expect.arrayContaining(["camera", "geolocation"]),
    );
  });
});

describe("resolveSandboxCsp — hosted clamp hostname normalization", () => {
  test("strips mixed-case unsafe schemes (case-insensitive)", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "JavaScript:alert(1)",
          "VBSCRIPT:evil()",
          "Data:text/html,",
          "https://safe.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://safe.com"]);
  });

  test("strips ws:// and wss:// localhost / private-network endpoints", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "ws://localhost:9000",
          "wss://127.0.0.1:8443",
          "ws://10.0.0.5",
          "wss://api.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["wss://api.example.com"]);
  });

  test("strips zero-padded IPv4 and IPv4-mapped IPv6 loopback", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          // URL parser normalizes 127.000.000.001 → 127.0.0.1
          "https://127.000.000.001",
          // Bracketed IPv6 loopback
          "https://[::1]",
          // IPv4-mapped IPv6 loopback
          "https://[::ffff:127.0.0.1]",
          "https://safe.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://safe.example.com"]);
  });

  test("strips link-local (169.254.x.x) and shared address space (100.64.x.x)", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://169.254.169.254", // cloud metadata endpoint
          "https://100.64.0.1",
          "https://172.20.0.1", // RFC1918
          "https://safe.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://safe.com"]);
  });

  test("strips protocol-relative localhost", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["//localhost:3000", "//safe.com"],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    // Protocol-relative `//safe.com` resolves to a non-loopback host.
    expect(csp.connectDomains).toEqual(["//safe.com"]);
  });

  test("strips bare-scheme tokens including uppercase", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["HTTPS:", "HTTP:", "WSS:", "https://good.com"],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://good.com"]);
  });

  // Codex P1 finding: an earlier shape only caught IPv4-mapped IPv6 in
  // the 127/8 loopback range, leaving RFC1918, link-local, and shared
  // address space reachable via the mapped form. The URL parser
  // canonicalizes `::ffff:192.168.1.1` to `::ffff:c0a8:101`, which
  // bypasses dotted-IPv4 regexes. Unpack the hex form and re-run the
  // full ruleset.
  test("strips IPv4-mapped IPv6 representations of RFC1918 / link-local / shared ranges", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://[::ffff:192.168.1.1]", // RFC1918 via mapped
          "https://[::ffff:10.0.0.5]", // RFC1918 via mapped
          "https://[::ffff:172.16.0.1]", // RFC1918 via mapped
          "https://[::ffff:169.254.169.254]", // cloud metadata via mapped
          "https://[::ffff:100.64.0.1]", // shared address via mapped
          "https://[::ffff:0.0.0.0]", // unspecified via mapped
          "https://safe.example.com",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["https://safe.example.com"]);
  });

  // CodeRabbit Major #5: bare host expressions with ports
  // (`localhost:3000`, `127.0.0.1:8080`) used to bypass stripping because
  // `isDangerousHostname` received the `host:port` literal. The
  // fallback now synthesizes `https://...` and reuses the URL parser.
  test("strips bare host expressions that include ports", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "localhost:3000",
          "127.0.0.1:8080",
          "192.168.1.1:8443",
          "safe.example.com:443",
        ],
      },
      policy: { mode: "declared" },
      hostedMode: true,
    });
    expect(csp.connectDomains).toEqual(["safe.example.com:443"]);
  });
});

describe("matchesAnyDeny — case-insensitivity (CodeRabbit Major #4)", () => {
  // CSP scheme + host matching is case-insensitive per the URL spec, and
  // DNS hostnames are case-insensitive. A deny rule that compares raw
  // strings lets a widget bypass with case variants (e.g. profile says
  // `deny: ["evil.com"]`, widget declares `Evil.com` → not stripped).
  test("exact match: pattern and domain differ only in case", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["Evil.com", "safe.com"] },
      policy: {
        mode: "declared",
        deny: { connectDomains: ["evil.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["safe.com"]);
  });

  test("wildcard match: case-variant subdomain still matches deny pattern", () => {
    const csp = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: ["https://API.Evil.COM", "https://safe.com"],
      },
      policy: {
        mode: "declared",
        deny: { connectDomains: ["https://*.evil.com"] },
      },
      hostedMode: false,
    });
    expect(csp.connectDomains).toEqual(["https://safe.com"]);
  });
});
