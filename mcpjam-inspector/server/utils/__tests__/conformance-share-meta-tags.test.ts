import { describe, expect, it } from "vitest";
import { DEFAULT_DOCUMENT_TITLE_TAG } from "../caniuse-meta-tags.js";
import {
  conformanceShareTokenFromPath,
  injectConformanceShareMetaTags,
  requestOrigin,
} from "../conformance-share-meta-tags.js";

const TOKEN = "V1StGXR8_Z5jdHi6B-myT";

describe("conformance share meta tags", () => {
  it("reads the token of a shared run's page", () => {
    expect(conformanceShareTokenFromPath(`/conformance/shared/${TOKEN}`)).toBe(
      TOKEN,
    );
    expect(conformanceShareTokenFromPath(`/conformance/shared/${TOKEN}/`)).toBe(
      TOKEN,
    );
  });

  it("ignores other pages and tokens outside the link alphabet", () => {
    expect(conformanceShareTokenFromPath("/conformance/shared")).toBeNull();
    expect(
      conformanceShareTokenFromPath("/evals/shared/abcdefghijk"),
    ).toBeNull();
    expect(
      conformanceShareTokenFromPath('/conformance/shared/"><script>x'),
    ).toBeNull();
    expect(
      conformanceShareTokenFromPath("/conformance/shared/legacy.hmac.token"),
    ).toBeNull();
  });

  it("builds an absolute origin only from a plain host", () => {
    expect(requestOrigin({ host: "app.mcpjam.com" })).toBe(
      "https://app.mcpjam.com",
    );
    expect(
      requestOrigin({
        host: "internal:8080",
        forwardedHost: "app.mcpjam.com",
        forwardedProto: "https",
      }),
    ).toBe("https://app.mcpjam.com");
    expect(requestOrigin({ host: "localhost:6274" })).toBe(
      "http://localhost:6274",
    );
    expect(requestOrigin({ host: 'evil.com"><x' })).toBeNull();
  });

  it("swaps the title and points og:image at the run's card", () => {
    const html = injectConformanceShareMetaTags(
      `<html><head>${DEFAULT_DOCUMENT_TITLE_TAG}</head><body></body></html>`,
      { origin: "https://app.mcpjam.com", token: TOKEN },
    );
    expect(html).not.toContain(DEFAULT_DOCUMENT_TITLE_TAG);
    expect(html).toContain(
      `<meta property="og:image" content="https://app.mcpjam.com/api/web/conformance-share-card/${TOKEN}.png" />`,
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
  });
});
