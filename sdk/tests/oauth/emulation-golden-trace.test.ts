/**
 * Golden-trace normalization and comparison (HP-43 step 6).
 */
import {
  compareOAuthEmulationTrace,
  computeOAuthGoldenTraceDigest,
  computeOAuthProfileDigest,
  GOLDEN_STALENESS_DAYS,
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
