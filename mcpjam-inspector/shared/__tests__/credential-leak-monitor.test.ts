/**
 * The production leak monitor (`ops/credential-leak-monitor/`) generates its
 * PostHog and Sentry patterns from the credential-URL registry. These tests
 * hold the two together: every registered route has a pattern that catches
 * its UNREDACTED form and misses its scrubbed (`[redacted]`) form, so adding
 * a route to the registry cannot leave the monitor blind to it, and a
 * correctly scrubbed URL can never page anyone.
 */
import { describe, expect, it } from "vitest";
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
