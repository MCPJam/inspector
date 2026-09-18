/**
 * Golden-trace normalization and comparison (HP-43 step 6).
 */
import {
  compareOAuthEmulationTrace,
  computeOAuthGoldenTraceDigest,
  computeOAuthProfileDigest,
  GOLDEN_STALENESS_DAYS,
  insertAuthorizationRedirectStep,
  isUnqualifiedMatch,
  normalizeAuthorizationRedirectStep,
  normalizeOAuthTrace,
  NORMALIZED_VALUE,
} from "../../src/oauth/emulation/golden-trace.js";
import type {
  NormalizedTraceStep,
  OAuthGoldenTrace,
} from "../../src/oauth/emulation/golden-trace.js";
import { runEmulatedOAuthPreflight } from "../../src/oauth/emulation/preflight.js";
import { deriveOAuthEmulation } from "../../src/oauth/emulation/derive.js";
import type { HttpHistoryEntry } from "../../src/oauth/state-machines/types.js";
import {
  autoConsent,
  createMockOAuthServer,
} from "../support/mock-oauth-as.js";
import { verified } from "../support/oauth-profiles.js";

const SERVER_URL = "https://mcp-server.example.com/mcp";
const CALLBACK = "http://127.0.0.1:41234/callback";
const NOW = new Date("2026-08-03T00:00:00Z");

const entry = (
  overrides: Partial<HttpHistoryEntry["request"]> & { step?: string } = {}
): HttpHistoryEntry =>
  ({
    step: (overrides.step ?? "token_request") as HttpHistoryEntry["step"],
    timestamp: 1_700_000_000_000,
    duration: 42,
    request: {
      method: overrides.method ?? "POST",
      url: overrides.url ?? "https://as.example.com/token",
      headers: overrides.headers ?? {},
      body: overrides.body,
    },
  }) as HttpHistoryEntry;

describe("normalizeOAuthTrace", () => {
  it("neutralizes per-run values but keeps their keys", () => {
    const [step] = normalizeOAuthTrace([
      entry({
        url: "https://as.example.com/authorize?state=abc123&code_challenge=xyz&scope=mcp%3Aread",
      }),
    ]);
    // The volatile values are gone; the parameters themselves are not, so a
    // client that STOPS sending one still shows up as a difference.
    expect(step.url).toContain(`state=${encodeURIComponent(NORMALIZED_VALUE)}`);
    expect(step.url).toContain(
      `code_challenge=${encodeURIComponent(NORMALIZED_VALUE)}`
    );
    expect(step.url).toContain("scope=mcp%3Aread");
  });

  it("normalizes the loopback callback port everywhere it appears", () => {
    const [step] = normalizeOAuthTrace([
      entry({
        url: `https://as.example.com/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}`,
        body: { redirect_uris: [CALLBACK, "zed://oauth"] },
      }),
    ]);
    expect(step.url).toContain("127.0.0.1%3A%3Cport%3E");
    expect(step.body).toEqual({
      redirect_uris: ["http://127.0.0.1:<port>/callback", "zed://oauth"],
    });
  });

  it("normalizes a bracketed IPv6 loopback callback too", () => {
    // A `\b` guard never matches before `[`, so the IPv6 form was silently
    // left un-normalized and its per-run port leaked into comparisons.
    const ipv6Callback = "http://[::1]:41234/callback";
    const [step] = normalizeOAuthTrace([
      entry({
        url: `https://as.example.com/authorize?redirect_uri=${encodeURIComponent(ipv6Callback)}`,
        body: { redirect_uris: [ipv6Callback, "zed://oauth"] },
      }),
    ]);
    expect(step.url).toContain(encodeURIComponent("[::1]:<port>"));
    expect(step.body).toEqual({
      redirect_uris: ["http://[::1]:<port>/callback", "zed://oauth"],
    });
  });

  it("keeps a `__proto__` form parameter instead of losing it to the prototype", () => {
    const [step] = normalizeOAuthTrace([
      entry({ body: "__proto__=surprise&grant_type=authorization_code" }),
    ]);
    // The expectation is built with JSON.parse, not an object literal: writing
    // `{ __proto__: "surprise" }` would hit the very trap under test and
    // compare against an object with no such own property.
    expect(JSON.parse(JSON.stringify(step.body))).toEqual(
      JSON.parse(
        '{"__proto__":"surprise","grant_type":"authorization_code"}'
      )
    );
    expect(JSON.stringify(step.body)).toContain("__proto__");
  });

  it("puts the rebuilt query before any fragment, not inside it", () => {
    const [step] = normalizeOAuthTrace([
      entry({ url: "https://as.example.com/authorize?scope=x#frag" }),
    ]);
    expect(step.url).toBe("https://as.example.com/authorize?scope=x");
  });

  it("compares form bodies as objects, ignoring parameter order", () => {
    const [a] = normalizeOAuthTrace([
      entry({ body: "grant_type=authorization_code&code=SECRET&resource=https%3A%2F%2Fx" }),
    ]);
    const [b] = normalizeOAuthTrace([
      entry({ body: "resource=https%3A%2F%2Fx&code=OTHER&grant_type=authorization_code" }),
    ]);
    expect(a.body).toEqual(b.body);
    expect((a.body as Record<string, string>).code).toBe(NORMALIZED_VALUE);
    expect((a.body as Record<string, string>).grant_type).toBe(
      "authorization_code"
    );
  });

  it("drops timestamps and derived headers, keeps knob-bearing ones", () => {
    const [step] = normalizeOAuthTrace([
      entry({
        headers: {
          "MCP-Protocol-Version": "2025-03-26",
          "User-Agent": "RealClient/1.0",
          Authorization: "Bearer super-secret",
          "Content-Length": "123",
        },
      }),
    ]);
    expect(step).not.toHaveProperty("timestamp");
    expect(step.headers["mcp-protocol-version"]).toBe("2025-03-26");
    expect(step.headers["user-agent"]).toBe("RealClient/1.0");
    expect(step.headers.authorization).toBe(NORMALIZED_VALUE);
    expect(step.headers["content-length"]).toBeUndefined();
  });

  it("excludes responses — a golden describes the client, not the server", () => {
    const withResponse = {
      ...entry(),
      response: { status: 200, statusText: "OK", headers: {}, body: { a: 1 } },
    } as HttpHistoryEntry;
    const [step] = normalizeOAuthTrace([withResponse]);
    expect(step).not.toHaveProperty("response");
  });

  it("keeps a JSON body containing `=` as JSON", () => {
    // `{"redirect_uri":"http://x?a=b"}` has no spaces and contains `=`, so a
    // shape test alone would misread it as form-encoded and reshape the body.
    const [step] = normalizeOAuthTrace([
      entry({ body: '{"redirect_uri":"http://x?a=b","client_name":"C"}' }),
    ]);
    expect(step.body).toEqual({
      client_name: "C",
      redirect_uri: "http://x?a=b",
    });
  });

  it("preserves repeated form parameters instead of keeping only the last", () => {
    // Collapsing these would let a run with duplicates compare equal to one
    // without them — parity overstated by a parsing artifact.
    const [withDuplicates] = normalizeOAuthTrace([
      entry({ body: "scope=a&scope=b&grant_type=authorization_code" }),
    ]);
    const [withoutDuplicates] = normalizeOAuthTrace([
      entry({ body: "scope=b&grant_type=authorization_code" }),
    ]);
    expect((withDuplicates.body as Record<string, unknown>).scope).toEqual([
      "a",
      "b",
    ]);
    expect(withDuplicates.body).not.toEqual(withoutDuplicates.body);
  });

  it("normalizes the authorization redirect as its own step", () => {
    const step = normalizeAuthorizationRedirectStep(
      "https://as.example.com/authorize?client_id=generated-42&state=zz"
    );
    expect(step.step).toBe("authorization_redirect");
    expect(step.url).toContain(
      `client_id=${encodeURIComponent(NORMALIZED_VALUE)}`
    );
  });
});

describe("compareOAuthEmulationTrace", () => {
  const steps: NormalizedTraceStep[] = normalizeOAuthTrace([
    entry({ step: "request_client_registration", url: "https://as.example.com/register", body: { client_name: "Real Client" } }),
    entry({ step: "token_request", body: "grant_type=authorization_code&code=X" }),
  ]);

  const golden = (
    overrides: Partial<OAuthGoldenTrace> = {}
  ): OAuthGoldenTrace => ({
    profileDigest: "digest-a",
    capturedAt: "2026-07-20",
    clientVersion: "1.2.3",
    steps,
    ...overrides,
  });

  const compare = (
    overrides: Partial<Parameters<typeof compareOAuthEmulationTrace>[0]> = {}
  ) =>
    compareOAuthEmulationTrace({
      trace: steps,
      golden: golden(),
      profileDigest: "digest-a",
      coverageSummary: "complete",
      now: NOW,
      ...overrides,
    });

  it("an exact run with complete coverage and a fresh capture is an unqualified match", () => {
    const result = compare();
    expect(result.status).toBe("matched");
    expect(result.qualifiers).toEqual([]);
    expect(result.differences).toEqual([]);
    expect(isUnqualifiedMatch(result)).toBe(true);
  });

  it("declared substitutions downgrade the status, not the diff", () => {
    const result = compare({
      declaredSubstitutions: [
        { kind: "redirect-uri-appended", detail: "callback appended" },
      ],
    });
    expect(result.status).toBe("matched_with_declared_substitutions");
    expect(result.differences).toEqual([]);
    expect(isUnqualifiedMatch(result)).toBe(false);
  });

  it("partial coverage can never be an unqualified match", () => {
    const result = compare({ coverageSummary: "partial" });
    expect(result.status).toBe("matched");
    expect(result.qualifiers).toContain("partial_coverage");
    expect(isUnqualifiedMatch(result)).toBe(false);
  });

  it("reports each differing field of a step", () => {
    const drifted = normalizeOAuthTrace([
      entry({ step: "request_client_registration", url: "https://as.example.com/register", body: { client_name: "Different Name" } }),
      entry({ step: "token_request", body: "grant_type=authorization_code&code=X" }),
    ]);
    const result = compare({ trace: drifted });
    expect(result.status).toBe("mismatched");
    expect(result.differences).toEqual([
      expect.objectContaining({ index: 0, kind: "body" }),
    ]);
    expect(isUnqualifiedMatch(result)).toBe(false);
  });

  it("reports a request the real client made that the run never did", () => {
    const result = compare({ trace: [steps[0]] });
    expect(result.differences).toEqual([
      expect.objectContaining({ index: 1, kind: "missing_in_run" }),
    ]);
  });

  it("reports a request the run made that the real client never did", () => {
    const result = compare({ trace: [...steps, steps[1]] });
    expect(result.differences).toEqual([
      expect.objectContaining({ index: 2, kind: "unexpected_in_run" }),
    ]);
  });

  it("a hand-authored golden is normalized before diffing, so key order is not a mismatch", () => {
    // Goldens may be written or edited by hand; without re-normalizing, header
    // key order alone would manufacture a difference.
    const handAuthored: NormalizedTraceStep[] = steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            headers: { "X-Zeta": "2", "Content-Type": "application/json" },
          }
        : step
    );
    const runSteps: NormalizedTraceStep[] = steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            headers: { "content-type": "application/json", "x-zeta": "2" },
          }
        : step
    );
    const result = compare({
      golden: golden({ steps: handAuthored }),
      trace: runSteps,
    });
    expect(result.differences).toEqual([]);
    expect(result.status).toBe("matched");
  });

  it("refuses to compare a golden captured from a different profile", () => {
    const result = compare({ profileDigest: "digest-b" });
    expect(result.status).toBe("not_compared");
    expect(result.reason).toBe("golden_profile_mismatch");
    expect(result.differences).toEqual([]);
  });

  it("refuses to compare when the run produced no trace", () => {
    const result = compare({ trace: [] });
    expect(result.status).toBe("not_compared");
    expect(result.reason).toBe("no_run_trace");
  });
});

describe("compareOAuthEmulationTrace — freshness", () => {
  const steps = normalizeOAuthTrace([entry()]);
  const compareAged = (capturedAt: string, clientVersion?: string) =>
    compareOAuthEmulationTrace({
      trace: steps,
      golden: {
        profileDigest: "d",
        capturedAt,
        steps,
        ...(clientVersion ? { clientVersion } : {}),
      },
      profileDigest: "d",
      coverageSummary: "complete",
      now: NOW,
    });

  it("a capture exactly at the threshold is still current", () => {
    // NOW − 90 days.
    const result = compareAged("2026-05-05");
    expect(result.freshness?.ageDays).toBe(GOLDEN_STALENESS_DAYS);
    expect(result.freshness?.stale).toBe(false);
    expect(result.qualifiers).not.toContain("stale_capture");
  });

  it("a capture one day past the threshold is stale, never presented as current", () => {
    const result = compareAged("2026-05-04");
    expect(result.freshness?.ageDays).toBe(GOLDEN_STALENESS_DAYS + 1);
    expect(result.freshness?.stale).toBe(true);
    expect(result.qualifiers).toContain("stale_capture");
    expect(result.status).toBe("matched");
    expect(isUnqualifiedMatch(result)).toBe(false);
  });

  it("an impossible calendar date is stale, not silently rolled forward", () => {
    // `new Date("2026-02-31")` rolls to March 3, which would turn a malformed
    // capture into a confident freshness claim.
    const result = compareAged("2026-02-31");
    expect(Number.isNaN(result.freshness?.ageDays as number)).toBe(true);
    expect(result.freshness?.stale).toBe(true);
    expect(result.qualifiers).toContain("stale_capture");
  });

  it("a future-dated capture is stale — nothing was captured tomorrow", () => {
    // A negative age would otherwise sail past the `> threshold` check and be
    // reported as current.
    const result = compareAged("2026-09-01");
    expect(result.freshness?.ageDays).toBeLessThan(0);
    expect(result.freshness?.stale).toBe(true);
    expect(result.qualifiers).toContain("stale_capture");
    expect(isUnqualifiedMatch(result)).toBe(false);
  });

  it("a malformed capturedAt is stale rather than current", () => {
    for (const capturedAt of ["not-a-date", "2026-8-3", ""]) {
      const result = compareAged(capturedAt);
      expect(result.freshness?.stale).toBe(true);
    }
  });

  it("a client-version mismatch qualifies the match", () => {
    const result = compareOAuthEmulationTrace({
      trace: steps,
      golden: {
        profileDigest: "d",
        capturedAt: "2026-08-01",
        clientVersion: "1.0.0",
        steps,
      },
      profileDigest: "d",
      coverageSummary: "complete",
      expectedClientVersion: "2.0.0",
      now: NOW,
    });
    expect(result.qualifiers).toContain("client_version_mismatch");
    expect(isUnqualifiedMatch(result)).toBe(false);
  });
});

describe("insertAuthorizationRedirectStep", () => {
  const steps = normalizeOAuthTrace([
    entry({ step: "request_client_registration", url: "https://as.example.com/register" }),
    entry({ step: "token_request" }),
    entry({ step: "authenticated_mcp_request", url: SERVER_URL }),
  ]);

  it("places the redirect before the token exchange, where it happened", () => {
    const withRedirect = insertAuthorizationRedirectStep(
      steps,
      "https://as.example.com/authorize?client_id=x"
    );
    expect(withRedirect.map((step) => step.step)).toEqual([
      "request_client_registration",
      "authorization_redirect",
      "token_request",
      "authenticated_mcp_request",
    ]);
  });

  it("appends when the run stopped at the redirect and never exchanged", () => {
    const stopped = steps.slice(0, 1);
    expect(
      insertAuthorizationRedirectStep(stopped, "https://as.example.com/authorize").map(
        (step) => step.step
      )
    ).toEqual(["request_client_registration", "authorization_redirect"]);
  });

  it("is a no-op when authorization never happened", () => {
    expect(insertAuthorizationRedirectStep(steps, undefined)).toBe(steps);
  });
});

describe("digests bind a run to its profile and capture", () => {
  it("the profile digest is canonical — key order cannot change it", async () => {
    const a = await computeOAuthProfileDigest({
      profileVersion: 2,
      sendsResourceIndicator: verified(false),
      authModel: verified(["oauth2-dcr"]),
    });
    const b = await computeOAuthProfileDigest({
      profileVersion: 2,
      authModel: verified(["oauth2-dcr"]),
      sendsResourceIndicator: verified(false),
    });
    expect(a).toBe(b);
  });

  it("a different profile yields a different digest", async () => {
    const a = await computeOAuthProfileDigest({
      profileVersion: 2,
      sendsResourceIndicator: verified(false),
    });
    const b = await computeOAuthProfileDigest({
      profileVersion: 2,
      sendsResourceIndicator: verified(true),
    });
    expect(a).not.toBe(b);
  });

  it("the golden digest addresses the captured steps", async () => {
    const steps = normalizeOAuthTrace([entry()]);
    const digest = await computeOAuthGoldenTraceDigest({ steps });
    const other = await computeOAuthGoldenTraceDigest({
      steps: normalizeOAuthTrace([entry({ method: "GET" })]),
    });
    expect(digest).not.toBe(other);
  });
});

describe("runEmulatedOAuthPreflight — comparison dimension", () => {
  const derive = () =>
    deriveOAuthEmulation({
      profileVersion: 2,
      authModel: verified(["oauth2-dcr"]),
    });

  it("stays not_compared with no golden, and always emits a trace", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.comparison.status).toBe("not_compared");
    expect(result.comparison.reason).toBe("no_golden");
    expect(result.trace.length).toBeGreaterThan(0);
    // The three dimensions stay independent: a completed run says nothing
    // about parity.
    expect(result.outcome).toBe("completed");
    expect(result.coverageSummary).toBe("partial");
  });

  it("matches its own trace, qualified by the partial coverage that produced it", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const first = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    const replay = createMockOAuthServer({ serverUrl: SERVER_URL });
    const second = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: replay.executor,
      completeAuthorization: autoConsent,
      profileSchemaVersion: 2,
      catalogRevision: "catalog-2026-08-03",
      goldenComparison: {
        golden: {
          profileDigest: "profile-digest",
          capturedAt: "2026-08-01",
          steps: first.trace,
        },
        profileDigest: "profile-digest",
        now: NOW,
      },
    });

    expect(second.comparison.differences).toEqual([]);
    expect(second.comparison.qualifiers).toContain("partial_coverage");
    expect(isUnqualifiedMatch(second.comparison)).toBe(false);
    expect(second.bindings).toMatchObject({
      profileSchemaVersion: 2,
      profileDigest: "profile-digest",
      catalogRevision: "catalog-2026-08-03",
    });
    expect(second.bindings.goldenTraceDigest).toEqual(expect.any(String));
  });

  it("a completed run records the authorize leg, in flow order", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    expect(result.outcome).toBe("completed");
    const kinds = result.trace.map((step) => step.step);
    expect(kinds).toContain("authorization_redirect");
    // Position is meaning: comparison is index-based, so the redirect must sit
    // where it happened — after registration, before the code is exchanged.
    expect(kinds.indexOf("authorization_redirect")).toBeLessThan(
      kinds.indexOf("token_request")
    );
    // `authorizationUrl` keeps meaning "stopped here, a human is required".
    expect(result.authorizationUrl).toBeUndefined();
  });

  it("a run stopped at the redirect reports the URL and ends on that step", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
    });

    expect(result.outcome).toBe("stopped_at_redirect");
    expect(result.authorizationUrl).toContain("/authorize");
    expect(result.trace.at(-1)?.step).toBe("authorization_redirect");
  });

  it("a golden from another profile is refused rather than diffed", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
      goldenComparison: {
        golden: {
          profileDigest: "some-other-client",
          capturedAt: "2026-08-01",
          steps: [],
        },
        profileDigest: "this-client",
        now: NOW,
      },
    });

    expect(result.comparison.status).toBe("not_compared");
    expect(result.comparison.reason).toBe("golden_profile_mismatch");
  });

  it("a compile-time divergence does not count as a run substitution", async () => {
    // A narrowed ladder version describes the PROFILE, not the wire. Counting
    // it would downgrade a byte-exact match to "matched with substitutions".
    const narrowed = deriveOAuthEmulation({
      profileVersion: 2,
      authModel: verified(["oauth2-dcr"]),
      oauthSpecVersion: verified({
        basis: "constant" as const,
        revisions: ["2024-11-05"],
      }),
    });
    expect(narrowed.divergences).toEqual([
      expect.objectContaining({ kind: "version-narrowed" }),
    ]);

    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const first = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: narrowed,
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    const replay = createMockOAuthServer({ serverUrl: SERVER_URL });
    const second = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: narrowed,
      callbackUrl: CALLBACK,
      requestExecutor: replay.executor,
      completeAuthorization: autoConsent,
      goldenComparison: {
        golden: { profileDigest: "d", capturedAt: "2026-08-01", steps: first.trace },
        profileDigest: "d",
        now: NOW,
      },
    });

    expect(second.comparison.declaredSubstitutions).toEqual([]);
    expect(second.comparison.status).toBe("matched");
    // The compile-time divergence is still reported, just not as a substitution.
    expect(second.divergences).toEqual([
      expect.objectContaining({ kind: "version-narrowed" }),
    ]);
  });

  it("a capture-only run is still bound to the profile it came from", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
      // No golden yet — this run exists to BECOME one.
      profileDigest: "profile-under-capture",
      profileSchemaVersion: 2,
    });

    expect(result.comparison.status).toBe("not_compared");
    expect(result.bindings.profileDigest).toBe("profile-under-capture");
    expect(result.bindings.goldenTraceDigest).toBeUndefined();
  });

  it("rejects two disagreeing profile digests before touching the network", async () => {
    // Allowing this would route around the comparator's binding check: the
    // caller could pass the golden's digest for the comparison while the run
    // actually used another profile, and get a confident match for two
    // different clients — with bindings reporting the other one.
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    await expect(
      runEmulatedOAuthPreflight({
        serverUrl: SERVER_URL,
        emulation: derive(),
        callbackUrl: CALLBACK,
        requestExecutor: mock.executor,
        completeAuthorization: autoConsent,
        profileDigest: "profile-actually-used",
        goldenComparison: {
          golden: {
            profileDigest: "some-other-profile",
            capturedAt: "2026-08-01",
            steps: [],
          },
          profileDigest: "some-other-profile",
          now: NOW,
        },
      })
    ).rejects.toThrow(/disagree/);
    // Rejected before any client was registered on the target server.
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects an explicitly empty digest against a golden's, too", async () => {
    // `""` is a supplied value, not an absent one. Waving it through would
    // resolve the run to `""` — comparison holding `""`, `bindings` omitting
    // the digest — the exact disagreement the guard exists to prevent.
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    await expect(
      runEmulatedOAuthPreflight({
        serverUrl: SERVER_URL,
        emulation: derive(),
        callbackUrl: CALLBACK,
        requestExecutor: mock.executor,
        completeAuthorization: autoConsent,
        profileDigest: "",
        goldenComparison: {
          golden: {
            profileDigest: "some-other-profile",
            capturedAt: "2026-08-01",
            steps: [],
          },
          profileDigest: "some-other-profile",
          now: NOW,
        },
      })
    ).rejects.toThrow(/disagree/);
    expect(mock.requests).toHaveLength(0);
  });

  it("comparison and bindings always report the same digest", async () => {
    const mock = createMockOAuthServer({ serverUrl: SERVER_URL });
    const first = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    const replay = createMockOAuthServer({ serverUrl: SERVER_URL });
    const second = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: replay.executor,
      completeAuthorization: autoConsent,
      // Both supplied, in agreement — the only accepted way to send two.
      profileDigest: "agreed-digest",
      goldenComparison: {
        golden: {
          profileDigest: "agreed-digest",
          capturedAt: "2026-08-01",
          steps: first.trace,
        },
        profileDigest: "agreed-digest",
        now: NOW,
      },
    });

    expect(second.bindings.profileDigest).toBe("agreed-digest");
    expect(second.comparison.status).not.toBe("not_compared");
  });

  it("the run's trace carries no credential material", async () => {
    const mock = createMockOAuthServer({
      serverUrl: SERVER_URL,
      issuedClientSecret: "registered-secret-value",
    });
    const result = await runEmulatedOAuthPreflight({
      serverUrl: SERVER_URL,
      emulation: derive(),
      callbackUrl: CALLBACK,
      requestExecutor: mock.executor,
      completeAuthorization: autoConsent,
    });

    const serialized = JSON.stringify(result.trace);
    expect(serialized).not.toContain("emulated-access-token");
    expect(serialized).not.toContain("registered-secret-value");
    expect(serialized).not.toContain("mock-authorization-code");
  });
});
