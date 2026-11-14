/**
 * The vendor-side containment settings (`ops/telemetry-containment/`) are
 * generated from the credential-URL registry. These tests hold them to it:
 * PostHog's replay blocklist blocks every credential page and nothing else,
 * and Sentry's scrubbing rules remove the secret from every registered shape
 * in a syntax Sentry's Relay accepts.
 */
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ROUTES, isReplayBlockedUrl } from "../credential-urls";
import {
  buildPostHogTransformation,
  buildPostHogUrlBlocklist,
  buildSentryPiiConfig,
} from "../../../ops/telemetry-containment/configs.mts";
import {
  SAMPLE_SECRET,
  cleanSamples,
  routeSamples,
} from "../../../ops/credential-leak-monitor/samples.mts";

const ORIGIN = "https://app.mcpjam.com";
const SECRET = "SENTINELc0nta1n";

/** One absolute page URL per registered page route, secret planted. */
const PAGE_URLS: Record<string, string> = {
  "score-results": `/results/${SECRET}`,
  "bench-results": `/bench/results/${SECRET}`,
  "conformance-shared": `/conformance/shared/${SECRET}`,
  "evals-shared": `/evals/shared/${SECRET}`,
  "tester-link": `/user-testing/acme/${SECRET}`,
  "tester-link-legacy": `/chatbox/acme/${SECRET}`,
  "server-connection-claim": `/connect/server/${SECRET}`,
  "mcp-oauth-callback": `/oauth/callback?code=${SECRET}`,
  "github-install-callback": `/settings/integrations/github/callback?code=${SECRET}`,
  "workos-callback": `/callback?code=${SECRET}`,
  "local-access-link": `/#token=${SECRET}`,
};

const NOT_BLOCKED = [
  "/p/k17abc/servers?tab=tools",
  "/user-testing/k17abc/edit",
  "/user-testing/k17abc",
  "/connect/server/request/req_1",
  "/results",
  "/settings/api-keys",
  "/#section",
];

describe("PostHog replay URL blocklist", () => {
  const blocklist = buildPostHogUrlBlocklist().map(
    // posthog-js compiles each entry with no flags.
    (entry) => new RegExp(entry.url),
  );
  const blocked = (url: string) => blocklist.some((re) => re.test(url));

  it("has an entry for every registered page", () => {
    const pages = CREDENTIAL_ROUTES.filter((route) => route.scope === "page");
    expect(Object.keys(PAGE_URLS).sort()).toEqual(
      pages.map((route) => route.id).sort(),
    );
  });

  it.each(Object.entries(PAGE_URLS))("blocks %s", (_id, path) => {
    expect(blocked(`${ORIGIN}${path}`)).toBe(true);
    // The same rule the current client applies before it records.
    expect(isReplayBlockedUrl(path)).toBe(true);
  });

  it("blocks a secret key in any case, on any page", () => {
    expect(blocked(`${ORIGIN}/servers?Code=x`)).toBe(true);
    expect(blocked(`${ORIGIN}/servers?X-Amz-Signature=x`)).toBe(true);
    expect(blocked(`${ORIGIN}/servers#access_token=x`)).toBe(true);
  });

  it.each(NOT_BLOCKED)("records %s", (path) => {
    expect(blocked(`${ORIGIN}${path}`)).toBe(false);
    expect(isReplayBlockedUrl(path)).toBe(false);
  });
});

describe("Sentry Advanced Data Scrubbing rules", () => {
  const config = buildSentryPiiConfig();
  const rules = Object.values(config.rules);

  it("applies every rule to every string", () => {
    expect(config.applications.$string.sort()).toEqual(
      Object.keys(config.rules).sort(),
    );
  });

  it("uses only syntax Relay's regex engine accepts", () => {
    for (const rule of rules) {
      expect(rule.pattern).not.toMatch(/\(\?[=!<]/); // no lookaround
      expect(rule.pattern).not.toMatch(/\\[1-9]/); // no backreferences
    }
  });

  /** Relay replaces each captured group 1 with the text. */
  function applyRules(value: string): string {
    let out = value;
    for (const rule of rules) {
      const insensitive = rule.pattern.startsWith("(?i)");
      const re = new RegExp(
        insensitive ? rule.pattern.slice(4) : rule.pattern,
        insensitive ? "gi" : "g",
      );
      out = out.replace(re, (match, secret: string) =>
        secret === undefined
          ? match
          : match.slice(0, match.lastIndexOf(secret)) +
            "[redacted]" +
            match.slice(match.lastIndexOf(secret) + secret.length),
      );
    }
    return out;
  }

  it.each(
    routeSamples()
      .filter((sample) => sample.expected !== null)
      .map((sample) => [sample.expected, sample.value]),
  )("removes the secret from %s: %s", (_id, value) => {
    expect(value).toContain(SAMPLE_SECRET);
    expect(applyRules(value)).not.toContain(SAMPLE_SECRET);
  });

  it("leaves clean values alone", () => {
    for (const sample of cleanSamples()) {
      expect(applyRules(sample.value)).toBe(sample.value);
    }
  });
});

describe("PostHog ingestion transformation", () => {
  it("checks every URL property against every pattern and drops on a match", () => {
    const source = buildPostHogTransformation();
    expect(source).toContain("return null");
    expect(source).toContain("'$current_url'");
    expect(source.match(/match\(value, pattern\)/g)).toHaveLength(1);
  });
});
