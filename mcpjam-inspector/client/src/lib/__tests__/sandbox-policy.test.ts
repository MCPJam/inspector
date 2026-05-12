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
    // Intentional divergence from W3C CSP Level 3: that spec's
    // host-source algorithm matches subdomains ONLY, not the bare
    // apex. We diverge so a profile saying "restrict to
    // *.example.com" doesn't silently exclude `example.com` itself —
    // a common author intent in MCP host-policy use cases. Real
    // browser CSP enforcement won't behave this way; the resolver
    // owns the divergence and the CSP debug overlay surfaces the
    // effective set so users can see what actually got matched.
    expect(
      matchesDomain("https://*.example.com", "https://example.com"),
    ).toBe(true);
  });
  it("host comparison is case-insensitive (regression: RFC 3986 §3.2.2)", () => {
    // Without case-insensitive matching, a profile-author typing
    // `https://API.example.com` in restrictTo or deny would silently
    // mismatch against `https://api.example.com` in the resource
    // declaration, either widening (missed restrictTo intersection)
    // or under-blocking (missed deny subtraction).
    expect(
      matchesDomain("https://API.example.com", "https://api.example.com"),
    ).toBe(true);
    expect(
      matchesDomain("https://*.EXAMPLE.com", "https://api.example.com"),
    ).toBe(true);
    expect(
      matchesDomain("https://*.example.com", "https://API.EXAMPLE.COM"),
    ).toBe(true);
  });

  it("wildcard matching strips ports on the domain side (regression: deny with port)", () => {
    // Regression for Bugbot Medium: a deny pattern of `https://*.evil.com`
    // must still match `https://api.evil.com:8443`. Previously the
    // domain side retained the port suffix and `endsWith` failed.
    expect(
      matchesDomain("https://*.evil.com", "https://api.evil.com:8443"),
    ).toBe(true);
    expect(
      matchesDomain("https://api.example.com", "https://api.example.com:443"),
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

describe("resolveSandboxCsp — mode selection without baselines", () => {
  it("`host-default` mode with no hostDefaultCsp resolves to no directive (caller responsibility)", () => {
    // Regression for Bugbot Medium: the renderer MUST pass a
    // `hostDefaultCsp` baseline when offering this mode to users
    // (the renderer wires it to the widget-declared CSP today).
    // The resolver itself is correctly faithful to the caller —
    // `mode: "host-default"` without a baseline means "no
    // baseline," which produces no directive at all (undefined).
    // The caller-side wiring in mcp-apps-renderer.tsx pins this
    // contract: it explicitly passes a baseline matching the
    // legacy pre-profile iframe behavior so this mode is never
    // exposed to users without something for the resolver to
    // intersect/subtract against.
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["https://api.example.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { csp: { mode: "host-default" } } },
      },
    });
    expect(result.effective.connectDomains).toBeUndefined();
  });

  it("`relaxed` mode with no relaxedCsp resolves to no directive (caller responsibility)", () => {
    const result = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["https://api.example.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { csp: { mode: "relaxed" } } },
      },
    });
    expect(result.effective.connectDomains).toBeUndefined();
  });

  it("`relaxed` mode + wildcard baseline + hosted clamp narrows back to safe set", () => {
    // Simulates the renderer's actual wiring: passes
    // `relaxedCsp: { connectDomains: ["*"] }` so the mode is
    // genuinely permissive in local dev. In hosted mode, the
    // platform clamp strips the wildcard back so `relaxed` is
    // never a hosted-mode foot-gun.
    const local = resolveSandboxCsp({
      relaxedCsp: { connectDomains: ["*"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { csp: { mode: "relaxed" } } },
      },
    });
    // Local dev: wildcard survives.
    expect(local.effective.connectDomains).toEqual(["*"]);

    const hosted = resolveSandboxCsp({
      relaxedCsp: { connectDomains: ["*"] },
      isHostedMode: true,
      profile: {
        profileVersion: 1,
        apps: { sandbox: { csp: { mode: "relaxed" } } },
      },
    });
    // Hosted: clamp strips the wildcard.
    expect(hosted.effective.connectDomains).toEqual([]);
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

  it("narrows wildcard baseline to concrete restrictTo entries (regression: bidirectional intersection)", () => {
    // Regression for Codex P2 / Bugbot High: when the baseline is a
    // wildcard (e.g. `*` in relaxed mode, or `https://*.example.com`
    // from a resource that declared it), a concrete `restrictTo`
    // entry must still narrow it. The naive
    // `b.some(p => matchesDomain(p, baselineEntry))` direction
    // alone would drop the wildcard and yield []. The bidirectional
    // implementation keeps concrete restrictTo entries the baseline
    // wildcard covers — matching SEP-1865's "host MAY restrict, MUST
    // NOT widen" semantic.
    const relaxedRestrict = resolveSandboxCsp({
      relaxedCsp: { connectDomains: ["*"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              mode: "relaxed",
              restrictTo: { connectDomains: ["https://api.example.com"] },
            },
          },
        },
      },
    });
    expect(relaxedRestrict.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);

    // Same shape with a more specific wildcard baseline.
    const wildcardSubdomainRestrict = resolveSandboxCsp({
      resourceCsp: { connectDomains: ["https://*.example.com"] },
      isHostedMode: false,
      profile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              restrictTo: { connectDomains: ["https://api.example.com"] },
            },
          },
        },
      },
    });
    expect(wildcardSubdomainRestrict.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
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

  it("strips javascript:/data:/blob: scheme-source expressions in hosted mode (regression: single-colon scheme)", () => {
    // Regression for CodeRabbit Critical: CSP scheme-source
    // expressions are written with a single colon (`javascript:`,
    // `data:`, `blob:`). The previous `splitScheme` only detected
    // `scheme://` and returned `undefined` for these, letting them
    // slip past the clamp's scheme blocks at lines 578-585.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "javascript:alert(1)",
          "data:image/png;base64,abc",
          "blob:https://example.com/foo",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips path-suffixed hosts before clamping (regression: mcpjam.com/api, localhost/foo)", () => {
    // Regression for CodeRabbit Major: CSP source expressions legally
    // carry paths (`https://mcpjam.com/api`). Without path-stripping
    // in extractHostname, `lowerHost` becomes `mcpjam.com/api`, so
    // `=== "mcpjam.com"` and `.endsWith(".mcpjam.com")` both miss
    // and the MCPJam same-origin clamp is bypassed. Same gap for
    // `localhost/admin` against the `=== "localhost"` guard.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "https://mcpjam.com/api",
          "https://localhost/admin",
          "https://api.mcpjam.dev/v1?token=secret",
          "http://10.0.0.1/x#frag",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips IPv6 unspecified address `::` (regression: dual-stack 0.0.0.0 analog)", () => {
    // Regression for Bugbot Medium: `[::]` is the IPv6 wildcard
    // bind address — on dual-stack hosts it routes to local
    // services exactly the same way `0.0.0.0` does. Without an
    // explicit check, it slipped past the clamp because:
    //   - isIpv6Loopback requires last group = 1 (it's 0)
    //   - not ULA (first group not in fc00–fdff)
    //   - not link-local (first group not in fe80–febf)
    //   - not IPv4-mapped (group 5 not "ffff")
    //   - string-match checks compare against IPv4 literals only.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "http://[::]:3000",
          "http://[::]",
          "http://[0:0:0:0:0:0:0:0]",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips canonical and compressed IPv6 loopback forms (regression: 0:0:0:0:0:0:0:1, ::1, 0::1)", () => {
    // Regression for CodeRabbit Critical follow-up: literal-string
    // `effectiveHost === "::1"` only catches one IPv6 loopback form.
    // RFC 4291 lets the same address be written canonical
    // (`0:0:0:0:0:0:0:1`), compressed (`::1`), or with the `::` at
    // various positions (`0::1`, `::0:1`). All must be blocked or an
    // attacker picks the form that slips past.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "http://[::1]",
          "http://[0:0:0:0:0:0:0:1]",
          "http://[0::1]",
          "http://[::0:1]",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips leading-zero IPv6 forms (regression: 0000::0001, 0000:0000:0000:0000:0000:FFFF:7F00:0001)", () => {
    // Regression for Bugbot High: `expandIPv6` previously lowercased
    // each group but didn't strip leading zeros, so `"0000"` stayed
    // as `"0000"` and the downstream `g === "0"` / `g === "ffff"`
    // checks failed for padded forms. An attacker could pick the
    // padded variant to slip past loopback / IPv4-mapped guards.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          // Leading-zero loopback.
          "http://[0000::0001]",
          // Fully padded IPv4-mapped 127.0.0.1.
          "http://[0000:0000:0000:0000:0000:FFFF:7F00:0001]",
          // Uppercase + padding mix.
          "http://[0000:0000:0000:0000:0000:FFFF:0A00:0001]",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips native IPv6 ULA (fc00::/7) and link-local (fe80::/10) in hosted mode", () => {
    // Regression for Codex P1: native IPv6 private/link-local
    // targets bypass the clamp on networks with IPv6 routing
    // because the previous implementation only handled loopback
    // and IPv4-mapped. fc00::/7 (ULA — IPv6 RFC-1918 analog) and
    // fe80::/10 (link-local) are both reachable from a hosted
    // widget if the underlying network has v6 routing — exactly
    // the internal-network bypass the bedrock clamp is supposed
    // to prevent.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          // Unique Local Address (fc00::/7).
          "http://[fc00::1]",
          "http://[fd00::1]",
          // Link-local (fe80::/10).
          "http://[fe80::1]",
          "http://[febf::1]",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips hex IPv4-mapped IPv6 (regression: ::ffff:7f00:1 == 127.0.0.1)", () => {
    // Regression for CodeRabbit Critical follow-up: `::ffff:7f00:1`
    // is the hex form of `::ffff:127.0.0.1`. The previous narrow
    // regex only matched dotted-quad form, letting the hex form
    // slip past every IPv4 loopback / RFC-1918 / link-local check.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          // 127.0.0.1 hex-encoded as IPv4-mapped IPv6.
          "http://[::ffff:7f00:1]",
          // 10.0.0.1 hex-encoded.
          "http://[::ffff:0a00:1]",
          // 169.254.169.254 (AWS IMDS) hex-encoded — leading-zero
          // variant.
          "http://[::ffff:a9fe:a9fe]",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips IPv4-mapped IPv6 loopback / RFC-1918 in hosted mode (regression: ::ffff:* bypass)", () => {
    // Regression for CodeRabbit Minor: `::ffff:127.0.0.1` and other
    // IPv4-mapped IPv6 forms route packets to the embedded v4
    // address. The previous clamp dropped them through every
    // `startsWith("127.")` / `startsWith("10.")` etc. check because
    // the string literal starts with `::ffff:`. Unfolding the
    // mapped v4 inside the clamp closes that hole.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "http://[::ffff:127.0.0.1]",
          "http://[::ffff:10.0.0.1]:8443",
          "http://[::ffff:192.168.1.5]",
          "http://[::ffff:169.254.169.254]", // AWS IMDS — link-local exfil
          "http://[::ffff:172.20.0.1]",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
    ]);
  });

  it("strips IPv6 loopback in hosted mode (regression: bracketed + bare forms)", () => {
    // Regression for Codex P1: a naive `slice(0, indexOf(':'))`
    // port-strip reduces `[::1]:3000` to `[` and bare `::1` to the
    // empty string — both slip through every loopback check. The
    // clamp's IPv6 disambiguation must handle bracketed (`[::1]:port`),
    // bracketed-without-port (`[::1]`), and bare (`::1`) forms.
    const result = resolveSandboxCsp({
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "http://[::1]:3000",
          "http://[::1]",
          "::1",
        ],
      },
      isHostedMode: true,
    });
    expect(result.effective.connectDomains).toEqual([
      "https://api.example.com",
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
