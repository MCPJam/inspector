/**
 * `_meta.ui` resolution (SEP-1865 precedence).
 *
 * The spec allows a server to publish UI metadata on the `resources/list`
 * entry, on the `resources/read` content item, or both, and requires the
 * content item to win. The fields resolve INDEPENDENTLY — a server may
 * publish csp at read time and prefersBorder at list time — which is why the
 * resolver reports a per-field breakdown rather than one source.
 *
 * No test file existed for this module until the `domain` field landed.
 */
import { describe, it, expect } from "vitest";
import {
  canSkipListingLookup,
  resolveUiResourceMeta,
} from "../ui-resource-meta.js";

const CSP_A = { connectDomains: ["https://a.example"] };
const CSP_B = { connectDomains: ["https://b.example"] };

function uiMeta(ui: Record<string, unknown>): Record<string, unknown> {
  return { ui };
}

describe("resolveUiResourceMeta — precedence", () => {
  it("prefers the content item over the listing, per field", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ csp: CSP_A }),
      listingMeta: uiMeta({ csp: CSP_B, prefersBorder: false }),
    });
    expect(resolved.csp).toEqual(CSP_A);
    expect(resolved.prefersBorder).toBe(false);
    expect(resolved.metadataSources.csp).toBe("content");
    expect(resolved.metadataSources.prefersBorder).toBe("listing");
    // Two sources actually contributed, which is what "mixed" is for.
    expect(resolved.metadataSource).toBe("mixed");
  });

  it("reports a single source when only one contributed", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ csp: CSP_A, prefersBorder: true }),
    });
    expect(resolved.metadataSource).toBe("content");
  });

  it("reports none when nothing was declared", () => {
    const resolved = resolveUiResourceMeta({});
    expect(resolved.metadataSource).toBe("none");
    expect(resolved.metadataSources).toEqual({
      csp: "none",
      permissions: "none",
      prefersBorder: "none",
      domain: "none",
    });
  });

  it("ranks legacy openai keys below the listing's canonical block", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: {
        "openai/widgetCSP": { connect_domains: ["https://legacy"] },
      },
      listingMeta: uiMeta({ csp: CSP_B }),
    });
    expect(resolved.csp).toEqual(CSP_B);
    expect(resolved.metadataSources.csp).toBe("listing");
  });

  it("treats an explicit prefersBorder:false as a declaration, not an absence", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ prefersBorder: false }),
      listingMeta: uiMeta({ prefersBorder: true }),
    });
    expect(resolved.prefersBorder).toBe(false);
  });

  it("ignores a malformed prefersBorder rather than coercing it", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ prefersBorder: "yes" }),
    });
    expect(resolved.prefersBorder).toBeUndefined();
    expect(resolved.metadataSources.prefersBorder).toBe("none");
  });
});

describe("resolveUiResourceMeta — domain", () => {
  it("resolves a declared domain and records its source", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ domain: "abc123.claudemcpcontent.com" }),
    });
    expect(resolved.domain).toBe("abc123.claudemcpcontent.com");
    expect(resolved.metadataSources.domain).toBe("content");
  });

  it("falls back to the listing", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ csp: CSP_A }),
      listingMeta: uiMeta({ domain: "listed.example.com" }),
    });
    expect(resolved.domain).toBe("listed.example.com");
    expect(resolved.metadataSources.domain).toBe("listing");
  });

  it("lets the content item win", () => {
    const resolved = resolveUiResourceMeta({
      contentMeta: uiMeta({ domain: "content.example.com" }),
      listingMeta: uiMeta({ domain: "listing.example.com" }),
    });
    expect(resolved.domain).toBe("content.example.com");
  });

  it("trims, and treats an empty declaration as none", () => {
    // It is compared against a hostname downstream, and reporting `""` would
    // render a mismatch finding against a value the server never made.
    expect(
      resolveUiResourceMeta({ contentMeta: uiMeta({ domain: "  x.test  " }) })
        .domain,
    ).toBe("x.test");
    expect(
      resolveUiResourceMeta({ contentMeta: uiMeta({ domain: "   " }) }).domain,
    ).toBeUndefined();
    expect(
      resolveUiResourceMeta({ contentMeta: uiMeta({ domain: 42 }) }).domain,
    ).toBeUndefined();
  });

  it("has no legacy source", () => {
    // `_meta.ui.domain` is SEP-1865 only; the Apps SDK never shipped an
    // `openai/widget*` equivalent, so there is nothing to fall back to.
    const resolved = resolveUiResourceMeta({
      contentMeta: { "openai/widgetDomain": "nope.example.com" },
    });
    expect(resolved.domain).toBeUndefined();
    expect(resolved.metadataSources.domain).toBe("none");
  });
});

describe("canSkipListingLookup", () => {
  const complete = uiMeta({
    csp: CSP_A,
    permissions: { camera: {} },
    prefersBorder: true,
  });

  it("skips when the content item supplies every resolved field", () => {
    expect(canSkipListingLookup(complete)).toBe(true);
  });

  it("does not skip when a field is missing", () => {
    expect(canSkipListingLookup(uiMeta({ csp: CSP_A }))).toBe(false);
    expect(canSkipListingLookup(undefined)).toBe(false);
  });

  it("does not skip on legacy-only metadata", () => {
    // Legacy keys rank below the listing, so the listing can still change the
    // outcome and must be fetched.
    expect(
      canSkipListingLookup({
        "openai/widgetCSP": { connect_domains: ["https://legacy"] },
      }),
    ).toBe(false);
  });

  it("still skips when only `domain` is absent, by design", () => {
    // `domain` is advisory. Requiring it would make every render of a
    // resource that declares the other three pay a resources/list round-trip
    // forever. The narrow cost: a listing-only domain is not seen here.
    expect(canSkipListingLookup(complete)).toBe(true);
    const resolved = resolveUiResourceMeta({ contentMeta: complete });
    expect(resolved.domain).toBeUndefined();
  });
});
