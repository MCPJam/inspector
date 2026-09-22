/**
 * The policy-page text extractor, which decides what the drift hash is over.
 *
 * The regex version this replaced was flagged by CodeQL as a bad HTML filter,
 * and the finding was right in a way that mattered here: each of its blind
 * spots makes the DIGEST depend on markup trivia, so an unchanged policy would
 * read as drift (or a changed one would not). The hash's whole job is to be
 * stable under rebuilds and unstable under edits, and these cases are where a
 * pattern-matched version gets that backwards.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error — a maintenance script, deliberately plain JS with no types.
import { extractText } from "../../../scripts/sync-claude-policy-manifest.mjs";

const text = (html: string): string => extractText(html) as string;

describe("extractText", () => {
  it("keeps visible text and drops the tags around it", () => {
    expect(text("<h1>Directory</h1><p>Submit your connector.</p>")).toBe(
      "Directory Submit your connector.",
    );
  });

  it("drops a script body even when the end tag carries whitespace", () => {
    // `</script >` is valid HTML. A `"</script>"` search walks straight past
    // it and swallows the rest of the document as script body — so the hash
    // would then be over an empty string for every page.
    expect(text("<p>keep</p><script>var x = 1;</script >tail")).toBe("keep tail");
  });

  it("drops a script body with attributes on the open tag", () => {
    expect(
      text('<script type="module" defer>const a = 1;</script><p>keep</p>'),
    ).toBe("keep");
  });

  it("does not stop at a </scriptfoo> that is a different element", () => {
    expect(text("<script>a</scriptfoo>b</script><p>keep</p>")).toBe("keep");
  });

  it("drops style bodies too", () => {
    expect(text("<style>body{color:red}</style><p>keep</p>")).toBe("keep");
  });

  it("drops a doctype declaration", () => {
    // `readTag` does not recognise `<!doctype html>` as a tag, so without an
    // explicit branch it survived as literal text — and a markup-only doctype
    // change would have moved the policy revision.
    expect(text("<!doctype html><p>Directory</p>")).toBe("Directory");
    expect(text("<!DOCTYPE HTML><p>Directory</p>")).toBe("Directory");
  });

  it("drops comments rather than treating them as content", () => {
    // A build id in a comment would otherwise make every rebuild look like a
    // policy change.
    expect(text("<p>keep</p><!-- build 4f21a --><p>also</p>")).toBe(
      "keep also",
    );
  });

  it("does not end a tag at a > inside a quoted attribute", () => {
    expect(text('<a title="a > b" href="/x">link</a>')).toBe("link");
    expect(text("<a title='a > b'>link</a>")).toBe("link");
  });

  it("treats a bare < in prose as content", () => {
    expect(text("<p>use a < b for comparison</p>")).toBe(
      "use a < b for comparison",
    );
  });

  it("collapses whitespace and decodes non-breaking spaces", () => {
    expect(text("<p>a&nbsp;b</p>\n\n   <p>c</p>")).toBe("a b c");
  });

  it("survives an unterminated tag without hanging or throwing", () => {
    expect(text("<p>keep</p><div class=\"x")).toBe("keep");
  });

  it("is stable across markup that changes but text that does not", () => {
    // This is the property the whole manifest rests on.
    const a = text('<main><p class="prose-a">Connectors must use HTTPS.</p></main>');
    const b = text('<main id="r2"><p class="prose-b" data-v="9">Connectors must use HTTPS.</p></main>');
    expect(a).toBe(b);
  });

  it("changes when the text changes", () => {
    expect(text("<p>Connectors must use HTTPS.</p>")).not.toBe(
      text("<p>Connectors may use HTTPS.</p>"),
    );
  });
});
