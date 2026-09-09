/**
 * The four capabilities against a REAL Chromium, on real pages.
 *
 * Refs, occlusion, dialogs and the network ring were each built against a fake
 * CDP session. That proves the daemon does what it was told and nothing about
 * whether Chromium agrees — whether `DOM.getBoxModel` answers in the space we
 * click in, whether `elementFromPoint` sees the banner, whether a `confirm()`
 * really does stop the renderer. This lane is where that is settled.
 *
 * Opt-in (`RUN_BROWSERD_SPIKE=true`) and never part of ordinary CI, the same
 * posture as the adapter spike beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowserdContext } from "../chromium-launch";
import { ChromiumDriver } from "../chromium-driver";
import type { DriverContext } from "../browser-page";
import type { BrowserCommand } from "../../protocol";
import {
  startBrowserFixtures,
  type FixtureServer,
} from "../../__tests__/fixtures/browser-pages";

const RUN = process.env.RUN_BROWSERD_SPIKE === "true";
/** This sandbox's Chromium is at a path Playwright's resolver does not know. */
const EXECUTABLE = process.env.MCPJAM_SPIKE_CHROMIUM_PATH;

function cmd(action: BrowserCommand["action"]): BrowserCommand {
  return { commandId: `c-${Math.random()}`, source: "chat", action };
}

describe.skipIf(!RUN)("browserd capabilities — real browser", () => {
  let userDataDir: string;
  let context: DriverContext;
  let driver: ChromiumDriver;
  let pages: FixtureServer;

  beforeAll(async () => {
    pages = await startBrowserFixtures();
    userDataDir = await mkdtemp(join(tmpdir(), "browserd-caps-"));
    context = await launchBrowserdContext({
      userDataDir,
      headless: true,
      ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
      extraArgs: ["--no-sandbox"],
    });
    driver = new ChromiumDriver(context);
  }, 60_000);

  afterAll(async () => {
    await driver?.close().catch(() => {});
    await pages?.close();
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  it("fills a form BY REF and the page agrees it was submitted", async () => {
    // The whole point of a ref: the model reads `textbox "Email"` and acts on
    // it, with no selector invented and no coordinate guessed off a picture.
    await driver.execute(cmd({ kind: "navigate", url: pages.url("/form") }));
    const observed = await driver.execute(
      cmd({ kind: "observe", mode: "a11y", filter: "all" }),
    );
    const refs = (
      observed.output as {
        refs: Record<string, { role: string; name: string }>;
      }
    ).refs;
    const refFor = (role: string, name: string) =>
      Object.entries(refs).find(
        ([, meta]) => meta.role === role && meta.name === name,
      )?.[0];

    const email = refFor("textbox", "Email");
    const plan = refFor("combobox", "Plan");
    const submit = refFor("button", "Continue");
    expect(email, "the form's fields must be nameable").toBeTruthy();

    const typed = await driver.execute(
      cmd({
        kind: "act",
        verb: "type",
        target: { a11yRef: email! },
        value: "someone@example.com",
      }),
    );
    expect(typed.ok).toBe(true);

    if (plan) {
      // By visible LABEL, which is all a tree ever showed the model.
      const chose = await driver.execute(
        cmd({
          kind: "act",
          verb: "select",
          target: { a11yRef: plan },
          value: "Large",
        }),
      );
      expect(chose.ok).toBe(true);
    }

    const clicked = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { a11yRef: submit! },
        observe: "a11y",
      }),
    );
    expect(clicked.ok).toBe(true);
    const after = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    expect(String((after.output as { text: string }).text)).toContain(
      "someone@example.com",
    );
  }, 60_000);

  it("REFUSES the click the banner would have swallowed", async () => {
    // Without the check this click reports success and the page has not
    // changed — the failure a model cannot detect and cannot explain.
    await driver.execute(cmd({ kind: "navigate", url: pages.url("/covered") }));
    const observed = await driver.execute(
      cmd({ kind: "observe", mode: "a11y" }),
    );
    const refs = (
      observed.output as {
        refs: Record<string, { role: string; name: string }>;
      }
    ).refs;
    const buy = Object.entries(refs).find(
      ([, meta]) => meta.role === "button" && meta.name === "Buy now",
    )?.[0];
    expect(buy).toBeTruthy();
    const res = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { a11yRef: buy! } }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("target_covered");
    // And it names what is on top, which is what makes it recoverable.
    expect(String(res.error)).toMatch(/consent|cookie/i);
  }, 60_000);

  it("CANCELS a confirm and says so, instead of wedging the tab", async () => {
    // A dialog stops the renderer. Before this the tab stayed blocked and
    // every later command reported the page unsettled.
    await driver.execute(cmd({ kind: "navigate", url: pages.url("/dialogs") }));
    const observed = await driver.execute(
      cmd({ kind: "observe", mode: "a11y" }),
    );
    const refs = (
      observed.output as {
        refs: Record<string, { role: string; name: string }>;
      }
    ).refs;
    const del = Object.entries(refs).find(
      ([, meta]) => meta.role === "button" && meta.name === "Delete",
    )?.[0];
    const res = await driver.execute(
      cmd({
        kind: "act",
        verb: "click",
        target: { a11yRef: del! },
        observe: "a11y",
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({ dialog: { choice: "dismissed" } });
    // The page recorded the answer it was given, so this is the page's own
    // account rather than ours.
    const after = await driver.execute(cmd({ kind: "observe", mode: "text" }));
    expect(String((after.output as { text: string }).text)).toContain(
      "cancelled",
    );
  }, 60_000);

  it("shows the 401 behind an empty list", async () => {
    // The layout is right, the console is silent because the fetch is caught,
    // and the only evidence is on the wire.
    await driver.execute(cmd({ kind: "navigate", url: pages.url("/network") }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "network" }));
    expect(res.ok).toBe(true);
    const rows = (
      res.output as {
        network: Array<{ url: string; status?: number }>;
      }
    ).network;
    const api = rows.find((row) => row.url.endsWith("/api/items"));
    expect(api, "the failing request must be in the ring").toBeTruthy();
    expect(api!.status).toBe(401);
  }, 60_000);

  it("keeps no query string and no request headers it was not asked to keep", async () => {
    // The retention rules, against a real response rather than a fake one.
    await driver.execute(cmd({ kind: "navigate", url: pages.url("/network") }));
    const res = await driver.execute(cmd({ kind: "observe", mode: "network" }));
    const rows = (
      res.output as {
        network: Array<{ url: string; headers?: Record<string, string> }>;
      }
    ).network;
    for (const row of rows) {
      expect(row.url).not.toContain("?");
      for (const name of Object.keys(row.headers ?? {})) {
        expect(["authorization", "cookie", "set-cookie"]).not.toContain(name);
      }
    }
  }, 60_000);
});
