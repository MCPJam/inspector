/**
 * The DRIVER, over the Electron engine.
 *
 * The unit suites beside this one check that `electron-page.ts` sends the right
 * CDP; this one checks the thing that actually matters — that `ChromiumDriver`,
 * written for Playwright and never touched for this, drives an Electron context
 * without noticing the difference. Same commands, same shapes, same lease.
 *
 * That is the claim I-8 makes ("one abstraction, three engines"), and it is the
 * kind of claim that is easy to state and easy to be wrong about: a `DriverPage`
 * can satisfy the TYPE and still not satisfy the driver, which reads `url` off
 * every observation, classifies thrown prose, and pins a state token to a DOM
 * signal. Nothing here mocks the driver.
 */
import { describe, expect, it } from "vitest";
import { ChromiumDriver } from "../../daemon/chromium-driver";
import { HandoffLease } from "../../daemon/lease";
import type { BrowserCommand } from "../../protocol";
import { launchElectronContext } from "../electron-context";
import {
  elementAt,
  fakeElectron,
  FakeBrowserWebContents,
} from "./fake-electron-browser";

let sequence = 0;
function cmd(action: BrowserCommand["action"], tabId?: string): BrowserCommand {
  sequence += 1;
  return {
    commandId: `c${sequence}`,
    source: "chat",
    action,
    ...(tabId ? { tabId } : {}),
  } as BrowserCommand;
}

/** A page whose DOM signal and screenshot answer, so observations are real. */
function pageContents(signal = "0BODY>1DIV"): FakeBrowserWebContents {
  const contents = new FakeBrowserWebContents({
    evaluate: (code) => (code.includes("parts.join") ? signal : undefined),
  });
  contents.debugger.replies.set("Page.captureScreenshot", { data: "aGk=" });
  return contents;
}

async function electronDriver(
  contents: FakeBrowserWebContents[],
  lease?: HandoffLease,
) {
  const electron = fakeElectron(contents);
  const context = await launchElectronContext({ electron });
  const driver = new ChromiumDriver(context, ...(lease ? [{ lease }] : []));
  return { driver, electron, context };
}

describe("the driver over Electron — it does not notice the engine", () => {
  it("navigates and folds the observation in", async () => {
    const contents = pageContents();
    const { driver } = await electronDriver([contents]);

    const result = await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ url: "https://example.test/" });
    // Settled, and carrying a state token the NEXT act can be pinned to —
    // which means the DOM signal and the URL both came back from a fake
    // Electron the driver knows nothing about.
    expect(result.settled).toBe(true);
    expect(result.stateToken).toBeTruthy();
  });

  it("clicks by selector through the same act verb", async () => {
    const contents = pageContents();
    for (const [method, reply] of elementAt(120, 240)) {
      contents.debugger.replies.set(method, reply);
    }
    const { driver } = await electronDriver([contents]);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    const result = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { selector: "#submit" } }),
    );

    expect(result.ok).toBe(true);
    const pressed = contents.debugger.calls.find(
      (c) =>
        c.method === "Input.dispatchMouseEvent" &&
        (c.params as { type?: string }).type === "mousePressed",
    );
    expect(pressed?.params).toMatchObject({ x: 120, y: 240 });
  });

  it("turns an element that is not there into an answer, not a fault", async () => {
    // `target_not_found` is something the model can act on ("the button isn't
    // there"); `act_failed` says the daemon broke. Electron's prose has to land
    // on the same side of that classifier as Playwright's.
    const contents = pageContents();
    contents.debugger.replies.set("DOM.getDocument", { root: { nodeId: 1 } });
    contents.debugger.replies.set("DOM.querySelector", { nodeId: 0 });
    const { driver } = await electronDriver([contents]);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    const result = await driver.execute(
      cmd({ kind: "act", verb: "click", target: { selector: "#gone" } }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^target_not_found:/);
  });

  it("reads the accessibility tree over CDP", async () => {
    const contents = pageContents();
    contents.debugger.replies.set("Accessibility.getFullAXTree", {
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
        { nodeId: "2", role: { value: "generic" }, childIds: ["4"] },
        { nodeId: "3", role: { value: "button" }, name: { value: "Submit" } },
        {
          nodeId: "4",
          role: { value: "StaticText" },
          name: { value: "Hello" },
        },
      ],
    });
    const { driver } = await electronDriver([contents]);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    const result = await driver.execute(cmd({ kind: "observe", mode: "a11y" }));

    expect(result.ok).toBe(true);
    const tree = (result.output as { a11y?: unknown }).a11y;
    // The `generic` wrapper folds away — a tree of `generic > generic`
    // describes nothing and spends the whole node budget doing it. The text
    // node goes with it here because the default view is the INTERACTIVE one;
    // prose is what `mode:"text"` answers.
    expect(tree).toBe('- button "Submit" [ref=e1]');
  });

  it("carries the console the page wrote", async () => {
    const contents = pageContents();
    const { driver } = await electronDriver([contents]);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );
    contents.logConsole("error", "boom");

    const result = await driver.execute(
      cmd({ kind: "observe", mode: "console" }),
    );

    expect(JSON.stringify(result.output)).toContain("boom");
  });

  it("gives the pane a viewport, because the viewport speaks CDP not Playwright", async () => {
    // This is what makes the Electron engine cheap: `daemon/viewport.ts` was
    // written against `CdpLike`, so the screencast, the quality governor and
    // input forwarding all work here the moment `cdp()` answers.
    const contents = pageContents();
    const { driver } = await electronDriver([contents]);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    const viewport = await driver.viewport();

    expect(viewport).not.toBeNull();
    viewport!.subscribe(() => {});
    await Promise.resolve();
    expect(contents.debugger.methods()).toContain("Page.startScreencast");
  });

  it("observes nothing while a person holds the browser", async () => {
    // The lease is engine-independent by construction — it lives above the
    // driver — but "by construction" is exactly the kind of claim that wants a
    // test on each engine rather than an argument.
    const contents = pageContents();
    const lease = new HandoffLease();
    const { driver } = await electronDriver([contents], lease);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    lease.acquire("rail-1", 60_000);
    const result = await driver.execute(
      cmd({ kind: "observe", mode: "screenshot" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^lease_held/);
    expect(JSON.stringify(result.output ?? {})).not.toContain("aGk=");
  });

  it("closes every window when the driver closes", async () => {
    const { driver, electron } = await electronDriver([pageContents()]);
    await driver.execute(
      cmd({ kind: "navigate", url: "https://example.test/" }),
    );

    await driver.close();

    expect(electron.windows.map((w) => w.isDestroyed())).toEqual([true]);
  });
});
