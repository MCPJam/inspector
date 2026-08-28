// Uploaded into the desktop sandbox and run there by the M0 spike (probe #7).
//
// Launches the template's baked Chromium HEADED on DISPLAY=:0 via playwright-core
// and drives the experimental WebMCP CDP domain, asserting the load-bearing facts
// from the LOCAL contract suite (server/services/webmcp-inspector/__tests__/
// webmcp-cdp.spike.test.ts). The point is to prove the pinned browser behaves
// identically headed-under-Xfce inside E2B as it does headless on a dev machine —
// so a Chromium bump that breaks WebMCP fails here rather than in production.
//
// WebMCP does NOT initialize document.modelContext on opaque (data:) origins, so
// the fixture is served over a real http origin, exactly like the local suite's
// startWebMcpFixtureServer. Emits a single `RESULT:<json>` line on stdout.
import pw from "/opt/mcpjam/browserd/node_modules/playwright-core/index.js";
import { writeFileSync } from "node:fs";
import http from "node:http";

const { chromium } = pw; // playwright-core is CommonJS — default import, not named.

const out = { probe: "in-sandbox-cdp", ok: false, steps: {} };

const HTML = `<!doctype html><meta charset=utf8><title>fx</title><script>
const mc = document.modelContext || navigator.modelContext;
window.__hasApi = !!(mc && mc.registerTool);
if (mc && mc.registerTool) {
  mc.registerTool({ name:'echo', description:'Echoes its input back',
    inputSchema:{type:'object',properties:{text:{type:'string'}}},
    async execute(input){ return { content:[{type:'text', text:'echo:'+JSON.stringify(input)}] }; } });
}
</script>`;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});
await new Promise((r) => server.listen(8099, "127.0.0.1", r));
const FIXTURE = "http://127.0.0.1:8099/";

let browser;
try {
  browser = await chromium.launch({
    headless: false, // HEADED on DISPLAY=:0 — the whole point of probe #7.
    executablePath: process.env.PW_CHROME_PATH || undefined,
    // Matches server/services/webmcp-inspector/launch-args.ts: the minimal
    // switch set for which document.modelContext is defined. --no-sandbox is a
    // spike-only concession to running inside the E2B sandbox.
    args: [
      "--enable-features=WebMCP",
      "--no-first-run",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
    env: { ...process.env, DISPLAY: ":0" },
  });
  out.steps.launched = true;
  out.chromiumVersion = browser.version();

  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  const added = [];
  const responded = [];
  cdp.on("WebMCP.toolsAdded", (e) => added.push(...(e.tools || [])));
  cdp.on("WebMCP.toolResponded", (e) => responded.push(e));
  await cdp.send("WebMCP.enable");
  out.steps.webmcpEnableResolved = true;

  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  out.steps.hasPageApi = await page.evaluate("window.__hasApi");

  const deadline = Date.now() + 8000;
  while (!added.some((t) => t.name === "echo") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  out.steps.echoRegistered = added.some((t) => t.name === "echo");
  out.toolNames = added.map((t) => t.name);

  if (out.steps.echoRegistered) {
    const frameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    const { invocationId } = await cdp.send("WebMCP.invokeTool", {
      frameId,
      toolName: "echo",
      input: { text: "hi" },
    });
    // Local contract: invokeTool returns the id BEFORE the tool settles.
    out.steps.invokeReturnedIdBeforeSettle =
      !!invocationId && !responded.some((r) => r.invocationId === invocationId);
    const d2 = Date.now() + 8000;
    while (!responded.some((r) => r.invocationId === invocationId) && Date.now() < d2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = responded.find((r) => r.invocationId === invocationId);
    out.steps.invokeCompleted = done?.status === "Completed";
    out.invokeOutput = JSON.stringify(done?.output)?.slice(0, 120);
  }

  out.ok =
    out.steps.launched &&
    out.steps.hasPageApi &&
    out.steps.echoRegistered &&
    out.steps.invokeReturnedIdBeforeSettle &&
    out.steps.invokeCompleted;
} catch (e) {
  out.error = String(e).slice(0, 400);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
writeFileSync("/tmp/cdp-result.json", JSON.stringify(out));
console.log("RESULT:" + JSON.stringify(out));
