import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_TITLE_TAG,
  getCaniuseMetaTagsHtml,
  getCaniuseTitleTag,
} from "../caniuse-meta-tags.js";

describe("caniuse-meta-tags", () => {
  it("replaces the default document title with a caniuse-specific one", () => {
    const titleTag = getCaniuseTitleTag();
    expect(titleTag).not.toBe(DEFAULT_DOCUMENT_TITLE_TAG);
    expect(titleTag).toMatch(/^<title>.*<\/title>$/);
    expect(titleTag).toContain("Can I Use MCP?");
  });

  it("emits every tag the social-preview checklist flagged as missing", () => {
    const html = getCaniuseMetaTagsHtml();

    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta property="og:description"');
    expect(html).toContain('<meta property="og:image"');
    expect(html).toContain('<meta property="og:site_name"');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta name="twitter:title"');
    expect(html).toContain('<meta name="twitter:description"');
    expect(html).toContain('<meta name="twitter:image"');
  });

  it("uses an absolute HTTPS URL for the OG/Twitter image", () => {
    const html = getCaniuseMetaTagsHtml();
    expect(html).toContain(
      'content="https://caniuse.dev/caniuse-og-dark-1200x630.png"'
    );
  });

  it("splices cleanly into a document ending in </head>", () => {
    const document = `<html><head>${DEFAULT_DOCUMENT_TITLE_TAG}</head><body></body></html>`;
    const withTitle = document.replace(
      DEFAULT_DOCUMENT_TITLE_TAG,
      getCaniuseTitleTag()
    );
    const withMeta = withTitle.replace(
      "</head>",
      `${getCaniuseMetaTagsHtml()}</head>`
    );

    expect(withMeta).toContain(getCaniuseTitleTag());
    expect(withMeta.match(/<title>/g)).toHaveLength(1);
    expect(withMeta).toContain('<meta property="og:title"');
  });
});
