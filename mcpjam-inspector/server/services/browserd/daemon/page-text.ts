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
  // INPUT/SELECT/TEXTAREA hold no text of the page's own — a control's value is
  // the user's, and the a11y tree already reports it next to the control it
  // belongs to. BUTTON is NOT here: its label ("Continue", "Delete everything")
  // is often the most important sentence on a confirmation page.
  const DROP = new Set(["IMG","PICTURE","VIDEO","AUDIO","SOURCE","TRACK","INPUT","SELECT","TEXTAREA"]);
  const BLOCK = new Set(["P","DIV","SECTION","ARTICLE","MAIN","HEADER","FOOTER","NAV","BLOCKQUOTE","TABLE","TR","UL","OL","DL","DT","DD","FORM","FIELDSET","FIGURE","FIGCAPTION","ASIDE","HR","ADDRESS","DETAILS","SUMMARY"]);
  // Far above the observation's byte budget, so it never changes what a caller
  // sees — it only stops a pathological page from building a huge string in
  // the renderer before anything gets the chance to trim it.
  const MAX_CHARS = 400000;
  const chunks = [];
  let total = 0;
  let pre = 0;
  const push = (t, isPre) => {
    if (!t || total >= MAX_CHARS) return;
    total += t.length;
    chunks.push({ t: t, pre: !!isPre });
  };
  const hidden = (el) => {
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    if (el.hidden) return true;
    if (typeof el.checkVisibility === "function") {
      // opacityProperty included: text at opacity 0 is invisible to the person
      // whose page this is, and reading it back is how a page says something to
      // the model that it never said to anyone else.
      return !el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true, opacityProperty: true });
    }
    const style = window.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  };
  const absolute = (href) => {
    try { return new URL(href, document.baseURI).href; } catch (e) { return href; }
  };
  // An EXPLICIT stack, not recursion. DOM depth is unbounded, and a page nested
  // deeply enough to overflow the in-page call stack would fail the whole
  // observation rather than returning a long page — the same reason the node
  // counter in the observation budget is iterative.
  const stack = [{ k: "node", n: document.body }];
  while (stack.length > 0) {
    const job = stack.pop();
    if (job.k === "text") { push(job.t, false); continue; }
    if (job.k === "preEnd") { pre -= 1; push("\\n" + job.fence + "\\n\\n", false); continue; }
    if (job.k === "linkEnd") {
      // The label may be several nodes deep, so it is collected and re-emitted
      // as one unit once its children are done.
      const parts = chunks.splice(job.start);
      let label = "";
      for (let i = 0; i < parts.length; i++) label += parts[i].t;
      label = label.trim();
      if (label) push(job.href ? "[" + label + "](" + absolute(job.href) + ")" : label, false);
      continue;
    }
    const node = job.n;
    if (!node) continue;
    if (node.nodeType === 3) {
      const raw = node.nodeValue || "";
      push(pre > 0 ? raw : raw.replace(/\\s+/g, " "), pre > 0);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName;
    if (SKIP.has(tag) || DROP.has(tag)) continue;
    if (hidden(node)) continue;
    if (tag === "BR") { push("\\n", false); continue; }
    const kids = node.childNodes;
    // Pushed in reverse so the first child is the next thing popped, and any
    // closing job pushed before them pops last.
    const descend = () => { for (let i = kids.length - 1; i >= 0; i--) stack.push({ k: "node", n: kids[i] }); };
    if (tag === "A") {
      stack.push({ k: "linkEnd", start: chunks.length, href: node.getAttribute("href") });
      descend();
      continue;
    }
    if (/^H[1-6]$/.test(tag)) {
      push("\\n\\n" + "#".repeat(Number(tag[1])) + " ", false);
      stack.push({ k: "text", t: "\\n\\n" });
      descend();
      continue;
    }
    if (tag === "LI") {
      push("\\n- ", false);
      stack.push({ k: "text", t: "\\n" });
      descend();
      continue;
    }
    if (tag === "PRE") {
      // A fence long enough that the content cannot close it. Page text
      // containing three backticks would otherwise end the block early and the
      // prose after it would read as code.
      const body = node.textContent || "";
      let fence = "\\u0060\\u0060\\u0060";
      while (body.indexOf(fence) !== -1) fence += "\\u0060";
      push("\\n\\n" + fence + "\\n", false);
      pre += 1;
      stack.push({ k: "preEnd", fence: fence });
      descend();
      continue;
    }
    if (tag === "TD" || tag === "TH") {
      stack.push({ k: "text", t: " | " });
      descend();
      continue;
    }
    if (BLOCK.has(tag)) {
      push("\\n\\n", false);
      stack.push({ k: "text", t: "\\n\\n" });
      descend();
      continue;
    }
    descend();
  }
  // Collapse whitespace only OUTSIDE fenced runs, where it is markup rather
  // than content. Tracked as the walk goes rather than recovered afterwards by
  // splitting on the fence: page content can contain a fence, and a split
  // would then mistake ordinary prose for code.
  let out = "";
  let buffer = "";
  let bufferPre = false;
  const flush = () => {
    out += bufferPre
      ? buffer
      : buffer.replace(/[ \\t]+/g, " ").replace(/ ?\\n ?/g, "\\n").replace(/\\n{3,}/g, "\\n\\n");
    buffer = "";
  };
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].pre !== bufferPre) { flush(); bufferPre = chunks[i].pre; }
    buffer += chunks[i].t;
  }
  flush();
  return out.trim();
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
