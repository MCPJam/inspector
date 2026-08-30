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
