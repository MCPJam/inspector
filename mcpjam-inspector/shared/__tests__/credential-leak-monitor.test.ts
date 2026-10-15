/**
 * The production leak monitor (`ops/credential-leak-monitor/`) generates its
 * PostHog and Sentry patterns from the credential-URL registry. These tests
 * hold the two together: every registered route has a pattern that catches
 * its UNREDACTED form and misses its scrubbed (`[redacted]`) form, so adding
 * a route to the registry cannot leave the monitor blind to it, and a
 * correctly scrubbed URL can never page anyone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_ROUTES,
  SECRET_PARAM_KEYS,
  containsCredential,
  isSecretParamKey,
  scrubCredentialUrl,
  scrubCredentialsInText,
} from "../credential-urls";
import {
  GENERIC_SECRET_PARAM_ID,
  USERINFO_ID,
  buildHogqlQuery,
  buildHogqlSelfTest,
  buildLeakPatterns,
  buildSentryQueries,
  classifyLeak,
  hogqlString,
  secretKeyAlternation,
  toRegExp,
} from "../../../ops/credential-leak-monitor/patterns.mts";
import {
  SAMPLE_SECRET,
  allSamples,
  cleanSamples,
  genericSamples,
  routeSamples,
} from "../../../ops/credential-leak-monitor/samples.mts";
import {
  exitCode,
  report,
  runPosthog,
  runSentry,
} from "../../../ops/credential-leak-monitor/run.mts";

const patterns = buildLeakPatterns();

/** Reverse of `hogqlString`: what ClickHouse would read from the literal. */
function readHogqlString(literal: string): string {
  expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true);
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

describe("credential leak monitor patterns", () => {
  it("has a pattern for every registered route, plus the two catch-alls", () => {
    const ids = patterns.map((pattern) => pattern.id);
    for (const route of CREDENTIAL_ROUTES) expect(ids).toContain(route.id);
    expect(ids).toContain(GENERIC_SECRET_PARAM_ID);
    expect(ids).toContain(USERINFO_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses syntax RE2 (HogQL) and JavaScript both accept", () => {
    for (const pattern of patterns) {
      expect(() => toRegExp(pattern)).not.toThrow();
      // No lookaround, backreferences or named groups: RE2 rejects them.
      expect(pattern.source).not.toMatch(/\(\?[=!<]/);
      expect(pattern.source).not.toMatch(/\\[1-9]/);
      // Exactly one capturing group: the secret, for `extract()`.
      const groups = pattern.source.match(/(?<!\\)\((?!\?)/g) ?? [];
      expect(groups, pattern.id).toHaveLength(1);
    }
  });

  it("attributes every unredacted sample to its route", () => {
    for (const sample of [...routeSamples(), ...genericSamples()]) {
      expect(classifyLeak(sample.value, patterns), sample.value).toBe(
        sample.expected,
      );
    }
  });

  it("covers every path route with an unredacted sample", () => {
    const covered = new Set(
      routeSamples()
        .filter((sample) => sample.expected)
        .map((sample) => sample.expected),
    );
    for (const route of CREDENTIAL_ROUTES) expect(covered).toContain(route.id);
  });

  it("samples are real credentials by the scrubber's own definition", () => {
    for (const sample of [...routeSamples(), ...genericSamples()]) {
      if (sample.expected === null) continue;
      expect(containsCredential(sample.value), sample.value).toBe(true);
    }
  });

  it("never flags the scrubbed form of any sample", () => {
    for (const sample of allSamples()) {
      const scrubbed =
        sample.kind === "url"
          ? scrubCredentialUrl(sample.value)
          : scrubCredentialsInText(sample.value);
      if (sample.expected !== null) {
        expect(scrubbed).not.toContain(SAMPLE_SECRET);
      }
      expect(classifyLeak(scrubbed, patterns), scrubbed).toBeNull();
    }
  });

  it("never flags clean values, placeholders, templates or reserved words", () => {
    for (const sample of cleanSamples()) {
      expect(classifyLeak(sample.value, patterns), sample.value).toBeNull();
    }
    for (const sample of routeSamples()) {
      if (sample.expected === null) {
        expect(classifyLeak(sample.value, patterns), sample.value).toBeNull();
      }
    }
  });

  it("keeps the secret-key alternation in step with isSecretParamKey", () => {
    const keyRegex = new RegExp(`^${secretKeyAlternation()}$`, "i");
    const corpus = [
      ...SECRET_PARAM_KEYS,
      "X-Amz-Signature",
      "x-amz-credential",
      "X-Amz-Security-Token",
      "X-Goog-Signature",
      "x_vendor_access_token",
      "my-secret",
      "db_password",
      "user_credential",
      "SessionToken",
      // Not secrets.
      "tab",
      "page",
      "q",
      "redirect_uri",
      "tokenizer",
      "secretary",
      "keys",
      "codes",
      "ok",
      "format",
    ];
    for (const key of corpus) {
      expect(keyRegex.test(key), key).toBe(isSecretParamKey(key));
    }
  });
});

describe("credential leak monitor queries", () => {
  it("embeds every pattern in the HogQL query as a literal ClickHouse reads back exactly", () => {
    const query = buildHogqlQuery({ hours: 24 });
    for (const pattern of patterns) {
      const re2 = `${pattern.caseInsensitive ? "(?i)" : ""}${pattern.source}`;
      const literal = hogqlString(re2);
      expect(query).toContain(literal);
      expect(readHogqlString(literal)).toBe(re2);
      expect(query).toContain(hogqlString(`${pattern.id}|`));
    }
    expect(query).toContain("INTERVAL 24 HOUR");
    expect(query).toContain("properties.$current_url");
    expect(query).toContain("elements_chain");
  });

  it("refuses a nonsense window", () => {
    expect(() => buildHogqlQuery({ hours: 0 })).toThrow();
    expect(() => buildHogqlQuery({ hours: 1.5 })).toThrow();
  });

  it("builds a self-test over literals only", () => {
    const query = buildHogqlSelfTest(["/results/abc"]);
    expect(query).not.toMatch(/\bFROM\b/);
    expect(query).toContain(hogqlString("/results/abc"));
  });

  it("asks Sentry for every path route on both URL fields", () => {
    const queries = buildSentryQueries();
    const all = queries.map((query) => query.query).join(" ");
    for (const route of CREDENTIAL_ROUTES) {
      if (route.secretIn !== "path") continue;
      const prefix = route.pattern.slice(0, route.pattern.indexOf(":"));
      expect(all).toContain(`url:"*${prefix}*"`);
      expect(all).toContain(`transaction:"*${prefix}*"`);
    }
    // Templated transaction names (`/results/:runToken`) are what a correct
    // client sends; they are excluded server-side.
    expect(queries.at(-1)?.query).toContain('!transaction:"*:*"');
  });
});

describe("credential leak monitor answers", () => {
  /**
   * A monitor that reads a missing or unfinished answer as "nothing found"
   * reports clean while it saw nothing. Only a complete answer with result
   * rows may say clean; anything else is blind, and exits 2.
   */
  const leakedUrl = `https://app.mcpjam.com/results/${SAMPLE_SECRET}`;

  function answer(status: number, body: unknown) {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "phx_test");
    vi.stubEnv("POSTHOG_PROJECT_ID", "1");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntrys_test");
    vi.stubEnv("SENTRY_ORG", "acme");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("PostHog: a query that has not finished is blind", async () => {
    answer(202, { query_status: { complete: false }, results: [] });
    const result = await runPosthog(24);
    expect(result.status).toBe("blind");
    expect(report([result], 24)).toContain("PostHog: blind (query incomplete)");
    expect(exitCode([result])).toBe(2);
  });

  it("PostHog: an answer without results is blind", async () => {
    answer(200, {});
    const result = await runPosthog(24);
    expect(result.status).toBe("blind");
    expect(report([result], 24)).toContain(
      "PostHog: blind (no results in the response)",
    );
    expect(exitCode([result])).toBe(2);
  });

  it("PostHog: a complete answer is clean or a leak", async () => {
    const columns = ["route_id", "property", "platform", "version", "events"];
    answer(200, { query_status: { complete: true }, columns, results: [] });
    const clean = await runPosthog(24);
    expect(clean.status).toBe("clean");
    expect(report([clean], 24)).toContain("PostHog: clean");
    expect(exitCode([clean])).toBe(0);

    answer(200, {
      columns,
      results: [["score-results", "$current_url", "web", "3.15.0", 2]],
    });
    const leak = await runPosthog(24);
    expect(leak.status).toBe("leak");
    expect(exitCode([leak])).toBe(1);
  });

  it("Sentry: an answer without data is blind", async () => {
    answer(200, {});
    const result = await runSentry(24);
    expect(result.status).toBe("blind");
    expect(report([result], 24)).toContain(
      "Sentry: blind (no data in the response)",
    );
    expect(exitCode([result])).toBe(2);
  });

  it("Sentry: a complete answer is clean or a leak", async () => {
    answer(200, { data: [] });
    const clean = await runSentry(24);
    expect(clean.status).toBe("clean");
    expect(report([clean], 24)).toContain("Sentry: clean");

    answer(200, { data: [{ id: "e1", project: "web", url: leakedUrl }] });
    const leak = await runSentry(24);
    expect(leak.status).toBe("leak");
    expect(leak.counts.get("score-results")).toBe(1);
    // The report names the route and the event, never the URL.
    expect(report([leak], 24)).not.toContain(SAMPLE_SECRET);
  });

  it("exits 1 for a leak even when another sink is blind", async () => {
    answer(200, {});
    const blind = await runPosthog(24);
    answer(200, { data: [{ id: "e1", project: "web", url: leakedUrl }] });
    const leak = await runSentry(24);
    expect(exitCode([blind, leak])).toBe(1);
  });
});
