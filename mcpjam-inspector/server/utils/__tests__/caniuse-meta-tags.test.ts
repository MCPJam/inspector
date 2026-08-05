import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_TITLE_TAG,
  getCaniuseMetaTagsHtml,
  getCaniuseTitleTag,
} from "../caniuse-meta-tags.js";

const CLIENT_INDEX_HTML_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../client/index.html"
);

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

  // If client/index.html's default <title> tag is ever edited, the
  // production `.replace(DEFAULT_DOCUMENT_TITLE_TAG, ...)` call in
  // server/index.ts silently no-ops — caniuse.dev would keep showing
  // "MCPJam Inspector" with no test catching it. Guard the constant against
  // the actual file instead of just against itself.
  it("matches the <title> tag actually present in client/index.html", () => {
    const indexHtml = readFileSync(CLIENT_INDEX_HTML_PATH, "utf-8");
    expect(indexHtml).toContain(DEFAULT_DOCUMENT_TITLE_TAG);
  });

  it("keeps the description within Google's ~155-160 char snippet budget", () => {
    const html = getCaniuseMetaTagsHtml();
    const match = html.match(/<meta name="description" content="([^"]+)"/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").length).toBeLessThanOrEqual(143);
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
