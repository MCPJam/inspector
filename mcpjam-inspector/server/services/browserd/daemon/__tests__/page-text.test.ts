/**
 * `PAGE_TEXT_FN` — the extraction rules, run against a real DOM.
 *
 * The function is a STRING evaluated inside the page, so nothing else in the
 * suite can typecheck it or catch a rule that quietly stopped firing: the fake
 * page returns whatever text a test hands it, and the engines just forward the
 * string. This file is the only place the rules themselves are pinned.
 *
 * jsdom, not a real Chromium, deliberately: these are DOM-walking rules, and a
 * spike that needs a downloaded browser would not run in CI — which is exactly
 * when a regression here would land. jsdom also has no `checkVisibility`, so
 * this exercises the `getComputedStyle` fallback, the path an older engine
 * takes.
 */
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { PAGE_TEXT_FN } from "../page-text";

function extract(body: string): string {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    url: "https://example.test/docs/",
    runScripts: "dangerously",
  });
  try {
    return dom.window.eval(`(${PAGE_TEXT_FN})()`) as string;
  } finally {
    dom.window.close();
  }
}

describe("PAGE_TEXT_FN — structure", () => {
  it("renders headings, paragraphs and list items as markdown-ish text", () => {
    const text = extract(`
      <h1>Release notes</h1>
      <p>Two things changed.</p>
      <ul><li>First</li><li>Second</li></ul>
    `);
    expect(text).toContain("# Release notes");
    expect(text).toContain("Two things changed.");
    expect(text).toContain("- First");
    expect(text).toContain("- Second");
  });

  it("renders a link with its destination, not just its label", () => {
    // A bare label tells the model a link exists but not where it goes — and
    // the next act is usually "follow it".
    const text = extract(`<p>See <a href="/pricing">the pricing page</a>.</p>`);
    expect(text).toContain("[the pricing page](https://example.test/pricing)");
  });

  it("keeps a link whole when its label is several nodes deep", () => {
    const text = extract(`<a href="/x"><span>Sign</span> <b>in</b></a>`);
    expect(text).toContain("[Sign in](https://example.test/x)");
  });

  it("drops a link with no text rather than emitting an empty target", () => {
    const text = extract(`<a href="/x"><img src="/i.png"></a><p>after</p>`);
    expect(text).not.toContain("](");
    expect(text).toContain("after");
  });

  it("separates table cells so a row is not one run-on word", () => {
    const text = extract(`<table><tr><td>Plan</td><td>Price</td></tr></table>`);
    expect(text).toContain("Plan | Price");
  });
});

describe("PAGE_TEXT_FN — what it refuses to read", () => {
  it("skips script and style content", () => {
    const text = extract(`
      <script>var secret = "do not read me";</script>
      <style>.a { color: red }</style>
      <p>visible</p>
    `);
    expect(text).toBe("visible");
  });

  it("skips what CSS hides", () => {
    // Hidden text is not text the user is reading, and a model that reads it
    // acts on a page nobody can see.
    const text = extract(`
      <div style="display:none">hidden by display</div>
      <div style="visibility:hidden">hidden by visibility</div>
      <p>shown</p>
    `);
    expect(text).toBe("shown");
  });

  it("skips what ARIA and the hidden attribute hide", () => {
    const text = extract(`
      <div aria-hidden="true">decorative</div>
      <div hidden>collapsed</div>
      <p>shown</p>
    `);
    expect(text).toBe("shown");
  });

  it("drops media, which a text mode cannot convey", () => {
    const text = extract(`<img alt="a chart"><video></video><p>caption</p>`);
    expect(text).toBe("caption");
  });
});

describe("PAGE_TEXT_FN — whitespace", () => {
  it("collapses HTML indentation, which is not content", () => {
    const text = extract(`<p>one
        two          three</p>`);
    expect(text).toBe("one two three");
  });

  it("preserves whitespace inside a fenced <pre>, and only there", () => {
    const text = extract(`<p>before</p><pre>a
  indented
    more</pre><p>after</p>`);
    expect(text).toContain("```\na\n  indented\n    more\n```");
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  it("never leaves more than one blank line between blocks", () => {
    const text = extract(`
      <div><div><div><p>deep</p></div></div></div>
      <div><p>next</p></div>
    `);
    expect(text).not.toMatch(/\n\n\n/);
    expect(text).toBe("deep\n\nnext");
  });

  it("answers an empty string for a page with nothing to read", () => {
    expect(extract("")).toBe("");
    expect(extract("<script>1</script>")).toBe("");
  });
});
