/**
 * Test-only fixture pages that register real WebMCP tools.
 *
 * Served over loopback HTTP rather than `setContent`/`data:` because WebMCP is
 * only available in origin-isolated documents, and an opaque origin has no
 * origin to isolate. Two servers on two ports give two genuinely distinct
 * origins, which is what the cross-origin-frame case needs.
 *
 * The fixture registers through `document.modelContext` — the current API.
 * (Chromium 151 still aliases `navigator.modelContext` to the same object; the
 * spike asserts that, so the day it stops being true is a test failure and not
 * a mystery.)
 *
 * WIDE ON PURPOSE. The routes below exist so the spike MEASURES the platform
 * rather than confirming a guess about it: every navigation shape a WebMCP tool
 * can take (same document, a named frame, a new tab, an imperative
 * `location.href`, a real value returned before navigation lands, a form that
 * waits for a person), against every shape of JSON-LD result document (one
 * block, several, malformed beside valid, none at all).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface WebMcpFixture {
  /** Main page: registers echo/slow/boom/big/annotated/hinted plus the imperative navigation tools, and a cross-origin subframe. */
  url: string;
  /** A second page on the SAME origin, registering `page2_tool`. */
  nextUrl: string;
  /** DECLARATIVE registrations: `<form toolname>` in markup, no script. */
  declarativeUrl: string;
  /** Result document with ONE `application/ld+json` block. */
  resultUrl: string;
  /** Result document with SEVERAL blocks, so the array shape is asserted. */
  resultMultiUrl: string;
  /** Result document with an unparseable block beside a valid one. */
  resultMalformedUrl: string;
  /** Result document with no `application/ld+json` block at all. */
  resultNoneUrl: string;
  /** The cross-origin (different port) document embedded as a subframe. */
  subOriginUrl: string;
  /** The cross-origin document that itself embeds a THIRD-origin frame. */
  nestedOuterUrl: string;
  /** The innermost origin in the nested cross-origin chain. */
  nestedInnerUrl: string;
  close(): Promise<void>;
}

/**
 * Tool names the fixture pages register, for assertions.
 *
 * Exported as names rather than written as bare literals at each call site so
 * a rename is one edit and a typo is a compile error.
 */
export const FIXTURE_TOOLS = {
  echo: "echo",
  slow: "slow",
  boom: "boom",
  big: "big",
  /** NEGATIVE CONTROL: bare `readOnly`/`untrustedContent` keys Blink never reads. */
  annotated: "annotated",
  /** The real keys: `readOnlyHint`/`untrustedContentHint`/`consequentialHint`. */
  hinted: "hinted",
  // --- declarative (`/declarative`) ---
  /** `action="/result"`, `toolautosubmit`: navigates its own document. */
  submitOrder: "submit_order",
  /** Same, but `target="resultframe"` — a named same-origin iframe. */
  frameOrder: "frame_order",
  /** Same, but `target="_blank"` — a new tab. */
  openReport: "open_report",
  /** NO `toolautosubmit`: settles only once a person submits the form. */
  confirmOrder: "confirm_order",
  /** A range of typed `<input>`s, so the schema Blink derives is real. */
  typedFields: "typed_fields",
  // --- imperative navigation (main page) ---
  /** Sets `location.href` and returns a promise that never settles. */
  goElsewhere: "go_elsewhere",
  /** Submits cross-document AND returns a real string before it lands. */
  submitAndReturn: "submit_and_return",
  /** Returns a validation-error value without navigating at all. */
  validateFirst: "validate_first",
  // --- other origins ---
  sub: "sub_tool",
  page2: "page2_tool",
  nestedOuter: "nested_outer_tool",
  nestedInner: "nested_inner_tool",
} as const;

/** Bytes the `big` tool returns — deliberately over the 256 KiB result cap. */
export const FIXTURE_BIG_OUTPUT_BYTES = 300_000;

/** The exact string `submit_and_return` resolves with, before its form lands. */
export const FIXTURE_SUBMIT_AND_RETURN_TEXT = "returned-before-navigation";
/** The exact string `validate_first` resolves with when it refuses to navigate. */
export const FIXTURE_VALIDATION_TEXT = "sku is required";

/**
 * Targets for forwarded input, at FIXED coordinates.
 *
 * Fixed-positioned and given generous hit areas on purpose: a test that clicked
 * at coordinates derived from layout would be a test about CSS. Each one
 * registers a WebMCP tool when it is used, so a forwarded click or keystroke is
 * observable through the inspector's OWN surface — no page evaluation, and no
 * second channel that could pass while the real one is broken.
 */
export const FIXTURE_INPUT_TARGETS = {
  /** Clicking here registers `clicked_tool`. */
  button: { x: 100, y: 100 },
  /** Clicking here focuses a field; typing `hi` registers `typed_hi_tool`. */
  field: { x: 100, y: 260 },
  clickedTool: "clicked_tool",
  typedTool: "typed_hi_tool",
} as const;

/**
 * The `@type` values the result documents publish, so an assertion names the
 * block it expects instead of matching on shape.
 */
export const FIXTURE_RESULT_TYPES = {
  single: "OrderConfirmation",
  multiFirst: "OrderConfirmation",
  multiSecond: "DeliveryEstimate",
  multiThird: "Receipt",
  malformedValid: "OrderConfirmation",
} as const;

const MAIN_HTML = (subOrigin: string) => `<!doctype html><html><body>
<h1>WebMCP fixture</h1>
<iframe id="sub" src="${subOrigin}" allow="tools"></iframe>
<!-- Target for \`submit_and_return\`: a real cross-document form submission
     issued from script, so the navigation is genuine and the tool's own
     returned value has something to race against. -->
<form id="return-form" action="/result" method="get">
  <input name="sku" value="ABC">
</form>
<script>
  const mc = document.modelContext;
  window.__webmcpReady = false;
  window.__navigatorAliasesDocument = navigator.modelContext === mc;

  // NEGATIVE CONTROL. These are the keys the MCP tool-annotation vocabulary
  // uses WITHOUT the "Hint" suffix. Blink reads \`readOnlyHint\` and
  // \`untrustedContentHint\`, so a tool declared this way reports both as
  // FALSE — which is what makes it the control for \`hinted\` below.
  mc.registerTool({
    name: "${FIXTURE_TOOLS.annotated}",
    description: "Declares annotations under the bare (unread) key names",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnly: true, untrustedContent: true, consequential: true },
    async execute() { return { content: [{ type: "text", text: "annotated" }] }; },
  });
  // The keys the page API actually reads. \`consequentialHint\` is declared
  // deliberately even though the pinned Chromium does not copy it: the spike
  // asserts its ABSENCE, so a future Chromium that starts copying it fails
  // loudly here rather than changing the product's meaning in silence.
  mc.registerTool({
    name: "${FIXTURE_TOOLS.hinted}",
    description: "Declares annotations under the *Hint key names the API reads",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true,
      consequentialHint: true,
    },
    async execute() { return { content: [{ type: "text", text: "hinted" }] }; },
  });
  mc.registerTool({
    name: "${FIXTURE_TOOLS.echo}",
    description: "Echoes its input back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(args) {
      return { content: [{ type: "text", text: "echo:" + JSON.stringify(args) }] };
    },
  });
  // Hangs until released, so a test can observe a pending invocation and cancel
  // or time out against it deterministically.
  mc.registerTool({
    name: "${FIXTURE_TOOLS.slow}",
    description: "Never settles until released",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      await new Promise((resolve) => { window.__releaseSlow = resolve; });
      return { content: [{ type: "text", text: "released" }] };
    },
  });
  mc.registerTool({
    name: "${FIXTURE_TOOLS.boom}",
    description: "Throws",
    inputSchema: { type: "object", properties: {} },
    async execute() { throw new Error("intentional failure"); },
  });
  mc.registerTool({
    name: "${FIXTURE_TOOLS.big}",
    description: "Returns more than the result cap",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "x".repeat(${FIXTURE_BIG_OUTPUT_BYTES}) }] };
    },
  });

  // --- imperative navigation --------------------------------------------
  // The three shapes that separate "navigated" from "finished". Only the
  // browser can say which of them produced a result, which is the whole
  // reason they exist.

  // Navigates and NEVER resolves. The document that ran this handler is gone,
  // so nothing in it can ever answer.
  mc.registerTool({
    name: "${FIXTURE_TOOLS.goElsewhere}",
    description: "Navigates away and never settles",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" } },
    },
    async execute(args) {
      location.href = (args && args.to) || "/result";
      return new Promise(() => {});
    },
  });
  // Returns a REAL value first, then navigates. Navigation is not evidence of
  // anything: this invocation's true outcome is the string below, and anything
  // reconstructed from the destination document would be wrong.
  mc.registerTool({
    name: "${FIXTURE_TOOLS.submitAndReturn}",
    description: "Returns a value, then submits a form cross-document",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      // Queued so the return below wins the race deterministically; the
      // submission is still a genuine cross-document navigation.
      setTimeout(() => document.getElementById("return-form").submit(), 0);
      return {
        content: [{ type: "text", text: "${FIXTURE_SUBMIT_AND_RETURN_TEXT}" }],
      };
    },
  });
  // Refuses and stays put — the "the tool ran and said no" case, which must
  // never be confused with a navigation.
  mc.registerTool({
    name: "${FIXTURE_TOOLS.validateFirst}",
    description: "Returns a validation error without navigating",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" } },
    },
    async execute(args) {
      if (!args || !args.sku) {
        return {
          isError: true,
          content: [{ type: "text", text: "${FIXTURE_VALIDATION_TEXT}" }],
        };
      }
      return { content: [{ type: "text", text: "ok:" + args.sku }] };
    },
  });

  // Input targets. Each registers a tool when it is used, so a forwarded click
  // or keystroke is observable through the tool registry rather than through a
  // second channel that could pass while the registry path is broken.
  const button = document.createElement("button");
  button.id = "click-target";
  button.textContent = "click me";
  button.style.cssText =
    "position:fixed;left:0;top:0;width:400px;height:200px;z-index:9999;font-size:40px";
  button.addEventListener("click", () => {
    mc.registerTool({
      name: "${FIXTURE_INPUT_TARGETS.clickedTool}",
      description: "Registered when the fixture button was clicked",
      inputSchema: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "clicked" }] }; },
    });
  });
  document.body.appendChild(button);

  const field = document.createElement("input");
  field.id = "type-target";
  field.style.cssText =
    "position:fixed;left:0;top:220px;width:400px;height:80px;z-index:9999;font-size:40px";
  field.addEventListener("input", () => {
    if (field.value !== "hi") return;
    mc.registerTool({
      name: "${FIXTURE_INPUT_TARGETS.typedTool}",
      description: "Registered when 'hi' was typed into the fixture field",
      inputSchema: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: field.value }] }; },
    });
  });
  document.body.appendChild(field);

  window.__webmcpReady = true;
</script></body></html>`;

/**
 * DECLARATIVE registrations — markup only, not one `registerTool` call.
 *
 * `toolname` is what makes a `<form>` a tool; `tooldescription` and
 * `toolautosubmit` are the other two attributes Blink reads. The tool's
 * `inputSchema` is DERIVED from the form's controls, which is why the typed
 * form below carries one of nearly every input type.
 */
const DECLARATIVE_HTML = `<!doctype html><html><body>
<h1>declarative fixture</h1>
<!-- Same-tab: the form's own document is replaced by the result. -->
<form toolname="${FIXTURE_TOOLS.submitOrder}"
      tooldescription="Places an order in this document"
      toolautosubmit action="/result" method="get">
  <input name="sku" type="text" required>
  <input name="qty" type="number" min="1" max="99">
  <button type="submit">order</button>
</form>

<!-- Named target: the result lands in a same-origin child frame, so the
     invoking document survives and a DIFFERENT document answers. -->
<form toolname="${FIXTURE_TOOLS.frameOrder}"
      tooldescription="Places an order into a named frame"
      toolautosubmit action="/result" method="get" target="resultframe">
  <input name="sku" type="text" required>
  <button type="submit">order</button>
</form>
<iframe name="resultframe" id="resultframe" width="200" height="80"></iframe>

<!-- New tab: the result document is not in this page's frame tree at all. -->
<form toolname="${FIXTURE_TOOLS.openReport}"
      tooldescription="Opens the report in a new tab"
      toolautosubmit action="/result" method="get" target="_blank">
  <input name="sku" type="text" required>
  <button type="submit">report</button>
</form>

<!-- NO toolautosubmit: filled in by the invocation, submitted by a PERSON.
     The shape that distinguishes "waiting for a human" from "stuck". -->
<form id="confirm-form" toolname="${FIXTURE_TOOLS.confirmOrder}"
      tooldescription="Fills the form and waits for a person to submit it"
      action="/result" method="get">
  <input name="sku" type="text" required>
  <button id="confirm-submit" type="submit"
          style="position:fixed;left:0;top:320px;width:400px;height:80px;z-index:9999;font-size:32px">
    confirm
  </button>
</form>

<!-- One of nearly every input type, so the schema Blink derives — including
     its \`format\` values — is a real artifact rather than a hand-written
     guess. \`toolautosubmit\` so it can also be invoked end to end. -->
<form toolname="${FIXTURE_TOOLS.typedFields}"
      tooldescription="Every input type, for the derived schema"
      toolautosubmit action="/result-none" method="get">
  <input name="text" type="text">
  <input name="num" type="number" min="1" max="99" step="0.5">
  <input name="range" type="range" min="0" max="10">
  <input name="date" type="date">
  <input name="time" type="time">
  <input name="datetime" type="datetime-local">
  <input name="month" type="month">
  <input name="week" type="week">
  <input name="color" type="color">
  <input name="search" type="search" pattern="[a-z]+">
  <input name="agree" type="checkbox">
  <input name="tier" type="radio" value="basic">
  <input name="tier" type="radio" value="pro">
  <textarea name="note"></textarea>
  <select name="ship"><option>standard</option><option>express</option></select>
  <select name="addons" multiple><option>gift</option><option>rush</option></select>
  <button type="submit">go</button>
</form>
</body></html>`;

/** One JSON-LD block: the ordinary shape a result document publishes. */
const RESULT_HTML = `<!doctype html><html><body>
<h1>result</h1>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"${FIXTURE_RESULT_TYPES.single}","orderNumber":"A-1","status":"confirmed"}
</script>
</body></html>`;

/**
 * SEVERAL blocks. Blink collects every one into a JSON ARRAY rather than
 * taking the first, so the array shape gets asserted instead of assumed.
 */
const RESULT_MULTI_HTML = `<!doctype html><html><body>
<h1>result (multi)</h1>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"${FIXTURE_RESULT_TYPES.multiFirst}","orderNumber":"A-1"}
</script>
<p>prose between the blocks, so they are not adjacent</p>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"${FIXTURE_RESULT_TYPES.multiSecond}","days":3}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"${FIXTURE_RESULT_TYPES.multiThird}","total":"42.00"}
</script>
</body></html>`;

/** An unparseable block beside a valid one — a page's own bug, not ours. */
const RESULT_MALFORMED_HTML = `<!doctype html><html><body>
<h1>result (malformed)</h1>
<script type="application/ld+json">
{ this is not json at all }
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"${FIXTURE_RESULT_TYPES.malformedValid}","orderNumber":"A-2"}
</script>
</body></html>`;

/** No block at all: a perfectly ordinary destination that says nothing. */
const RESULT_NONE_HTML = `<!doctype html><html><body>
<h1>result (no structured data)</h1>
<p>This document publishes no application/ld+json at all.</p>
</body></html>`;

const NEXT_HTML = `<!doctype html><html><body>
<h1>second page</h1>
<script>
  document.modelContext.registerTool({
    name: "${FIXTURE_TOOLS.page2}",
    description: "Registered only by the second page",
    inputSchema: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "page2" }] }; },
  });
</script></body></html>`;

const SUB_HTML = `<!doctype html><html><body>
<p>cross-origin subframe</p>
<script>
  try {
    document.modelContext.registerTool({
      name: "${FIXTURE_TOOLS.sub}",
      description: "Registered inside a cross-origin subframe",
      inputSchema: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "sub" }] }; },
    });
    window.__subRegistered = "registered";
  } catch (error) {
    window.__subRegistered = "ERROR: " + error.message;
  }
</script></body></html>`;

/**
 * A cross-origin document that itself embeds a THIRD origin.
 *
 * The nested-target case: attaching to this frame's session is not enough to
 * see the inner frame's tools, which is what makes attachment recursive.
 */
const NESTED_OUTER_HTML = (innerOrigin: string) => `<!doctype html><html><body>
<p>nested outer</p>
<iframe id="inner" src="${innerOrigin}" allow="tools"></iframe>
<script>
  document.modelContext.registerTool({
    name: "${FIXTURE_TOOLS.nestedOuter}",
    description: "Registered by the middle frame of a nested cross-origin chain",
    inputSchema: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "outer" }] }; },
  });
</script></body></html>`;

const NESTED_INNER_HTML = `<!doctype html><html><body>
<p>nested inner</p>
<script>
  document.modelContext.registerTool({
    name: "${FIXTURE_TOOLS.nestedInner}",
    description: "Registered by the innermost frame of a nested cross-origin chain",
    inputSchema: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "inner" }] }; },
  });
</script></body></html>`;

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** `Origin-Agent-Cluster: ?1` requests the origin isolation WebMCP requires. */
function send(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "origin-agent-cluster": "?1",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Route table for the main origin.
 *
 * A map rather than the ternary this replaced: the fixture now serves eight
 * documents, and every one of them still has to go through `send()` for the
 * `Origin-Agent-Cluster` header — a route that answered directly would look
 * like the others and quietly have no WebMCP at all.
 */
function mainRoutes(subOrigin: string): Record<string, string> {
  return {
    "/": MAIN_HTML(subOrigin),
    "/next": NEXT_HTML,
    "/declarative": DECLARATIVE_HTML,
    "/result": RESULT_HTML,
    "/result-multi": RESULT_MULTI_HTML,
    "/result-malformed": RESULT_MALFORMED_HTML,
    "/result-none": RESULT_NONE_HTML,
  };
}

export async function startWebMcpFixtureServer(): Promise<WebMcpFixture> {
  const nestedInnerServer = await listen((_req, res) =>
    send(res, NESTED_INNER_HTML),
  );
  const nestedInnerUrl = `http://127.0.0.1:${(nestedInnerServer.address() as AddressInfo).port}/`;

  const nestedOuterServer = await listen((_req, res) =>
    send(res, NESTED_OUTER_HTML(nestedInnerUrl)),
  );
  const nestedOuterUrl = `http://127.0.0.1:${(nestedOuterServer.address() as AddressInfo).port}/`;

  const subServer = await listen((_req, res) => send(res, SUB_HTML));
  const subOriginUrl = `http://127.0.0.1:${(subServer.address() as AddressInfo).port}/`;

  const routes = mainRoutes(subOriginUrl);
  const mainServer = await listen((req, res) => {
    // Query strings are how a submitted form arrives, so route on the PATH.
    const path = (req.url ?? "/").split("?")[0];
    send(res, routes[path] ?? routes["/"]);
  });
  const base = `http://127.0.0.1:${(mainServer.address() as AddressInfo).port}`;

  return {
    url: `${base}/`,
    nextUrl: `${base}/next`,
    declarativeUrl: `${base}/declarative`,
    resultUrl: `${base}/result`,
    resultMultiUrl: `${base}/result-multi`,
    resultMalformedUrl: `${base}/result-malformed`,
    resultNoneUrl: `${base}/result-none`,
    subOriginUrl,
    nestedOuterUrl,
    nestedInnerUrl,
    async close() {
      await Promise.all([
        closeServer(mainServer),
        closeServer(subServer),
        closeServer(nestedOuterServer),
        closeServer(nestedInnerServer),
      ]);
    },
  };
}
