/**
 * The page as READABLE TEXT — the observation mode a model reaches for when it
 * wants to know what a page says rather than what it looks like.
 *
 * Why this exists next to `screenshot`, `dom` and `a11y`: none of the three
 * answer "what does this page say". A screenshot costs image tokens and cannot
 * be searched; `dom` is a tag skeleton with no text in it at all; the a11y tree
 * carries names, not prose, and drops everything that is neither interactive
 * nor a named landmark. Reading an article, a changelog, an error page or a
 * confirmation screen through any of those is a round-trip the model pays for
 * in tokens and gets a worse answer from.
 *
 * DELIBERATELY NOT A READABILITY SCORER. Article extraction guesses at which
 * subtree is "the content" and is wrong in ways that are invisible from the
 * output — a heuristic that silently drops a page's only paragraph looks
 * exactly like a page with no paragraph. This walks what is rendered, skips
 * what is not, and is the same function on every engine, so two engines
 * observing one page cannot disagree and a run replays what it recorded.
 *
 * NOTE: like `DOM_SIGNAL_FN`, this is evaluated as an EXPRESSION and must be
 * wrapped and self-invoked at the call site — `(${PAGE_TEXT_FN})()`. A bare
 * function literal evaluates to the uncalled function, which serializes to
 * `undefined`.
 */

/**
 * The extraction, as one in-page function shared by every engine.
 *
 * Rules, in the order the walker applies them:
 *  - Non-rendered subtrees are skipped whole: `script`/`style`/`noscript`/
 *    `svg`/`template`/`canvas` and friends by tag, then anything CSS or ARIA
 *    hides. Hidden text is not text the user is reading.
 *  - Links render as `[text](absolute href)`, because a bare label tells the
 *    model a link exists but not where it goes — and the next act is usually
 *    "follow it".
 *  - Headings, list items, block elements and `<br>` carry the structure that
 *    makes prose scannable; table cells are separated so a row does not
 *    collapse into one run-on word.
 *  - `<pre>` is fenced and keeps its whitespace; everywhere else whitespace
 *    collapses, because HTML indentation is not content.
 *  - Images, video and audio contribute nothing: alt text is already in the
 *    a11y tree, and a model cannot see a `<video>` through a text mode.
 */
export const PAGE_TEXT_FN = `() => {
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","SVG","HEAD","TEMPLATE","CANVAS","OBJECT","EMBED","IFRAME","FRAME","MAP","AREA","LINK","META"]);
  const DROP = new Set(["IMG","PICTURE","VIDEO","AUDIO","SOURCE","TRACK","INPUT","SELECT","TEXTAREA","BUTTON"]);
  const BLOCK = new Set(["P","DIV","SECTION","ARTICLE","MAIN","HEADER","FOOTER","NAV","BLOCKQUOTE","TABLE","TR","UL","OL","DL","DT","DD","FORM","FIELDSET","FIGURE","FIGCAPTION","ASIDE","HR","ADDRESS","DETAILS","SUMMARY"]);
  const chunks = [];
  let pre = 0;
  const hidden = (el) => {
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    if (el.hidden) return true;
    if (typeof el.checkVisibility === "function") {
      return !el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
    }
    const style = window.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  };
  const absolute = (href) => {
    try { return new URL(href, document.baseURI).href; } catch (e) { return href; }
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      const raw = node.nodeValue || "";
      chunks.push(pre > 0 ? raw : raw.replace(/\\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (SKIP.has(tag) || DROP.has(tag)) return;
    if (hidden(node)) return;
    if (tag === "BR") { chunks.push("\\n"); return; }
    if (tag === "A") {
      // Collected first, then re-emitted as one unit: a link's text may be
      // several nodes deep, and the markdown form needs it whole.
      const start = chunks.length;
      for (const child of node.childNodes) walk(child);
      const text = chunks.splice(start).join("").trim();
      if (!text) return;
      const href = node.getAttribute("href");
      chunks.push(href ? "[" + text + "](" + absolute(href) + ")" : text);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      chunks.push("\\n\\n" + "#".repeat(Number(tag[1])) + " ");
      for (const child of node.childNodes) walk(child);
      chunks.push("\\n\\n");
      return;
    }
    if (tag === "LI") {
      chunks.push("\\n- ");
      for (const child of node.childNodes) walk(child);
      chunks.push("\\n");
      return;
    }
    if (tag === "PRE") {
      chunks.push("\\n\\n\\u0060\\u0060\\u0060\\n");
      pre += 1;
      for (const child of node.childNodes) walk(child);
      pre -= 1;
      chunks.push("\\n\\u0060\\u0060\\u0060\\n\\n");
      return;
    }
    if (tag === "TD" || tag === "TH") {
      for (const child of node.childNodes) walk(child);
      chunks.push(" | ");
      return;
    }
    if (BLOCK.has(tag)) {
      chunks.push("\\n\\n");
      for (const child of node.childNodes) walk(child);
      chunks.push("\\n\\n");
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  if (document.body) walk(document.body);
  // Collapse only OUTSIDE fences: a fence's whitespace is its content. Odd
  // segments of the split are the fenced runs, so only even ones are squeezed.
  const parts = chunks.join("").split("\\u0060\\u0060\\u0060");
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/[ \\t]+/g, " ")
      .replace(/ ?\\n ?/g, "\\n")
      .replace(/\\n{3,}/g, "\\n\\n");
  }
  return parts.join("\\u0060\\u0060\\u0060").trim();
}`;

/**
 * The byte budget for one text observation.
 *
 * The same 16 KB a WebMCP tool result gets: enough for a long article, small
 * enough that a page which is mostly boilerplate cannot spend a turn's whole
 * context. Over-budget text is CUT (with the counted marker naming the
 * narrowing verbs) rather than omitted — unlike a tree, prose has no subtree
 * boundary to drop at, and a cut string is unambiguous about what happened.
 */
export const DEFAULT_PAGE_TEXT_MAX_BYTES = 16_000;

/** What the truncation marker tells the model to do about the rest. */
export const PAGE_TEXT_RETRIEVAL_HINT =
  'narrow with observe {mode:"a11y", rootSelector} or scroll and re-read';
