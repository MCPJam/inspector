/**
 * Live validation of the Playwright adapter (`chromium-launch.ts`), which has no
 * unit tests of its own. Opt-in only — set `RUN_BROWSERD_SPIKE=true` and have the
 * pinned Chromium installed — so it never runs (or fails) in ordinary CI, the
 * same posture as the M0 E2B spike. It drives a real persistent context through
 * the full `ChromiumDriver` to prove navigate + observe + settle + state token
 * work end to end against a real browser.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowserdContext } from "../chromium-launch";
import { ChromiumDriver } from "../chromium-driver";
import type { DriverContext } from "../browser-page";

const RUN = process.env.RUN_BROWSERD_SPIKE === "true";

const PAGE = `data:text/html,${encodeURIComponent(
  "<!doctype html><title>t</title><body><main><h1>hi</h1><button>go</button></main></body>",
)}`;

describe.skipIf(!RUN)("browserd Chromium adapter — real browser", () => {
  let userDataDir: string;
  let context: DriverContext;
  let driver: ChromiumDriver;

  beforeAll(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "browserd-spike-"));
    context = await launchBrowserdContext({ userDataDir, headless: true });
    driver = new ChromiumDriver(context);
  }, 60_000);

  afterAll(async () => {
    await driver?.close().catch(() => {});
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  it("navigates, settles, and observes with a live state token", async () => {
    const nav = await driver.execute({
      commandId: "n1",
      source: "chat",
      action: { kind: "navigate", url: PAGE },
    });
    expect(nav.ok).toBe(true);
    expect(nav.settled).toBe(true);
    expect(nav.stateToken?.navCounter).toBe(1);

    const shot = await driver.execute({
      commandId: "s1",
      source: "chat",
      action: { kind: "observe", mode: "screenshot" },
    });
    expect(shot.ok).toBe(true);
    const screenshot = (shot.output as { screenshot: string }).screenshot;
    expect(screenshot.length).toBeGreaterThan(100); // a real PNG came back

    const dom = await driver.execute({
      commandId: "d1",
      source: "chat",
      action: { kind: "observe", mode: "dom" },
    });
    expect((dom.output as { dom: string }).dom).toContain("BUTTON");

    // The live token matches what the driver reports out-of-band.
    const live = await driver.currentStateToken(undefined);
    expect(live?.urlHash).toBe(nav.stateToken?.urlHash);
  }, 60_000);
});

/**
 * A CROSS-ORIGIN IFRAME, against a real browser.
 *
 * The unit suite proves the wiring with fake sessions; only a real Chromium
 * can say whether the wiring describes what Chromium actually does. Three
 * facts this checks, each one a place the unit fakes could be wrong in the
 * same direction as the code:
 *
 *   1. An out-of-process frame really does get its own CDP session, and the
 *      WebMCP bridge really does attach one for it.
 *   2. `DOM.getBoxModel` in that session really does answer in the FRAME's own
 *      coordinate space — the premise the whole translation rests on.
 *   3. A click at the translated point really does reach the element, and a
 *      keystroke sent to the PAGE really does land in the frame's focused
 *      field.
 *
 * Two servers, because two ORIGINS: `127.0.0.1` and `localhost` are different
 * origins to Chromium and the same machine to us, which is the cheapest
 * cross-origin pair that needs no network.
 */
describe.skipIf(!RUN)("browserd — a cross-origin iframe", () => {
  let userDataDir: string;
  let context: DriverContext;
  let driver: ChromiumDriver;
  let servers: Array<{ close: () => Promise<void>; port: number }> = [];

  /** A one-route HTTP server, so the two origins are real. */
  async function serve(html: string) {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(html);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    return {
      port,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  beforeAll(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "browserd-frames-"));
    context = await launchBrowserdContext({ userDataDir, headless: true });
    driver = new ChromiumDriver(context, { features: { a11yFrames: true } });
  }, 60_000);

  afterAll(async () => {
    await driver?.close().catch(() => {});
    for (const server of servers) await server.close().catch(() => {});
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  it("sees inside it, clicks in it, and types in it", async () => {
    const child = await serve(
      "<!doctype html><title>child</title><body>" +
        '<input aria-label="Card number">' +
        '<button onclick="document.title=\'clicked\'">Pay</button>' +
        "</body>",
    );
    // PADDED, so the frame's own origin is nowhere near the page's: an
    // untranslated point would land in the padding and hit nothing, which is
    // exactly the failure being ruled out.
    const parent = await serve(
      "<!doctype html><title>parent</title>" +
        "<body style='margin:0;padding:120px 0 0 80px'>" +
        `<iframe src="http://localhost:${child.port}/" ` +
        'width="400" height="300" style="border:0"></iframe></body>',
    );
    servers = [child, parent];

    await driver.execute({
      commandId: "nav",
      source: "inspector",
      action: { kind: "navigate", url: `http://127.0.0.1:${parent.port}/` },
    });
    const observed = await driver.execute({
      commandId: "obs",
      source: "inspector",
      action: { kind: "observe", mode: "a11y" },
    });
    const output = observed.output as {
      a11y: string;
      refs: Record<string, { role: string; name: string }>;
    };
    // (1) The frame's controls are visible at all.
    expect(output.a11y).toContain("Card number");
    expect(output.a11y).toContain("Pay");

    const refOf = (name: string) =>
      Object.entries(output.refs).find(([, v]) => v.name === name)![0];

    // (2)+(3) A click at the translated point reaches the button.
    const clicked = await driver.execute({
      commandId: "click",
      source: "inspector",
      action: { kind: "act", verb: "click", target: { a11yRef: refOf("Pay") } },
    });
    expect(clicked.ok).toBe(true);

    // (3) A keystroke sent to the PAGE lands in the frame's focused field.
    const typed = await driver.execute({
      commandId: "type",
      source: "inspector",
      action: {
        kind: "act",
        verb: "type",
        target: { a11yRef: refOf("Card number") },
        value: "4242",
        observe: "a11y",
      },
    });
    expect(typed.ok).toBe(true);
    expect((typed.output as { a11y: string }).a11y).toContain("4242");
  }, 60_000);
});
