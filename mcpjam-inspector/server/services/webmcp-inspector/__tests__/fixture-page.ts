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
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface WebMcpFixture {
  /** Main page: registers echo/slow/boom/big plus a cross-origin subframe. */
  url: string;
  /** A second page on the SAME origin, registering `page2_tool`. */
  nextUrl: string;
  /** The cross-origin (different port) document embedded as a subframe. */
  subOriginUrl: string;
  close(): Promise<void>;
}

/** Tool names the main fixture page registers, for assertions. */
export const FIXTURE_TOOLS = {
  echo: "echo",
  slow: "slow",
  boom: "boom",
  big: "big",
  annotated: "annotated",
} as const;

/** Bytes the `big` tool returns — deliberately over the 256 KiB result cap. */
export const FIXTURE_BIG_OUTPUT_BYTES = 300_000;

const MAIN_HTML = (subOrigin: string) => `<!doctype html><html><body>
<h1>WebMCP fixture</h1>
<iframe id="sub" src="${subOrigin}" allow="tools"></iframe>
<script>
  const mc = document.modelContext;
  window.__webmcpReady = false;
  window.__navigatorAliasesDocument = navigator.modelContext === mc;

  mc.registerTool({
    name: "annotated",
    description: "Declares every annotation the CDP Annotation type carries",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnly: true, untrustedContent: true },
    async execute() { return { content: [{ type: "text", text: "annotated" }] }; },
  });
  mc.registerTool({
    name: "echo",
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
    name: "slow",
    description: "Never settles until released",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      await new Promise((resolve) => { window.__releaseSlow = resolve; });
      return { content: [{ type: "text", text: "released" }] };
    },
  });
  mc.registerTool({
    name: "boom",
    description: "Throws",
    inputSchema: { type: "object", properties: {} },
    async execute() { throw new Error("intentional failure"); },
  });
  mc.registerTool({
    name: "big",
    description: "Returns more than the result cap",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "x".repeat(${FIXTURE_BIG_OUTPUT_BYTES}) }] };
    },
  });
  window.__webmcpReady = true;
</script></body></html>`;

const NEXT_HTML = `<!doctype html><html><body>
<h1>second page</h1>
<script>
  document.modelContext.registerTool({
    name: "page2_tool",
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
      name: "sub_tool",
      description: "Registered inside a cross-origin subframe",
      inputSchema: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "sub" }] }; },
    });
    window.__subRegistered = "registered";
  } catch (error) {
    window.__subRegistered = "ERROR: " + error.message;
  }
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

export async function startWebMcpFixtureServer(): Promise<WebMcpFixture> {
  const subServer = await listen((_req, res) => send(res, SUB_HTML));
  const subOriginUrl = `http://127.0.0.1:${(subServer.address() as AddressInfo).port}/`;

  const mainServer = await listen((req, res) => {
    send(res, req.url === "/next" ? NEXT_HTML : MAIN_HTML(subOriginUrl));
  });
  const base = `http://127.0.0.1:${(mainServer.address() as AddressInfo).port}`;

  return {
    url: `${base}/`,
    nextUrl: `${base}/next`,
    subOriginUrl,
    async close() {
      await Promise.all([closeServer(mainServer), closeServer(subServer)]);
    },
  };
}
