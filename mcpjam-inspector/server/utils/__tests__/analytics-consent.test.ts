import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsConsentRequired,
  buildAnalyticsConsentScript,
} from "../analytics-consent.js";

const app = new Hono().get("/", (c) => c.text(buildAnalyticsConsentScript(c)));

async function scriptFor(headers: Record<string, string>): Promise<string> {
  const res = await app.request("/", { headers });
  return res.text();
}

const REQUIRED = "<script>window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__=true;</script>";
const NOT_REQUIRED = "<script>window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__=false;</script>";

describe("analyticsConsentRequired", () => {
  it.each(["DE", "FR", "IE", "GB", "NO", "IS", "LI", "RE", "AX"])(
    "requires consent in %s",
    (country) => expect(analyticsConsentRequired(country)).toBe(true),
  );

  it.each(["US", "BR", "IN", "CH"])("does not require it in %s", (country) =>
    expect(analyticsConsentRequired(country)).toBe(false),
  );

  it.each([null, "", "XX", "T1"])(
    "requires consent when the location is unknown (%s)",
    (country) => expect(analyticsConsentRequired(country)).toBe(true),
  );
});

describe("buildAnalyticsConsentScript", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads Cloudflare's country header", async () => {
    expect(await scriptFor({ "cf-ipcountry": "us" })).toBe(NOT_REQUIRED);
    expect(await scriptFor({ "cf-ipcountry": "DE" })).toBe(REQUIRED);
  });

  it("requires consent when the request carries no country", async () => {
    expect(await scriptFor({})).toBe(REQUIRED);
  });

  it("ignores a country header the edge did not attest", async () => {
    vi.stubEnv("MCPJAM_EDGE_SECRET", "edge-secret");
    expect(await scriptFor({ "cf-ipcountry": "US" })).toBe(REQUIRED);
    expect(
      await scriptFor({
        "cf-ipcountry": "US",
        "x-mcpjam-edge-secret": "edge-secret",
      }),
    ).toBe(NOT_REQUIRED);
  });
});
