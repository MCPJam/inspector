import { beforeEach, describe, expect, it } from "vitest";
import { ELECTRON_TAB_CAP, launchElectronContext } from "../electron-context";
import { fakeElectron, FakeBrowserWebContents } from "./fake-electron-browser";
import {
  agentBrowserWindowCount,
  isAgentBrowserWindow,
  resetAgentWindowsForTests,
} from "../agent-windows";

beforeEach(() => resetAgentWindowsForTests());

describe("electron context — the windows it opens", () => {
  it("opens them hidden, so the agent does not steal the user's screen", async () => {
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();

    expect(electron.windows[0]?.options).toMatchObject({ show: false });
  });

  it("gives the page a renderer that cannot reach the machine", async () => {
    // The agent browses the OPEN WEB. Every one of these is what keeps a page
    // it lands on inside the renderer: no Node, no shared context, its own
    // partition. This is a hostile-content surface, not an app window.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();

    expect(electron.windows[0]?.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });

  it("sizes the CONTENT to the observation viewport, not the frame", async () => {
    // Without this, a framed platform makes the content smaller than the
    // 1024x768 surface the model was told about (L5) — so every coordinate it
    // was handed from a screenshot lands somewhere other than where it aimed.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();

    expect(electron.windows[0]?.options).toMatchObject({
      useContentSize: true,
      width: 1024,
      height: 768,
    });
  });

  it("does not let a hidden window be throttled to a crawl", async () => {
    // Electron throttles hidden windows by default, and a throttled renderer
    // starves the screencast the pane is watching.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();

    expect(electron.windows[0]?.options.webPreferences).toMatchObject({
      backgroundThrottling: false,
    });
  });

  it("refuses every permission a page asks for", async () => {
    const electron = fakeElectron();
    await launchElectronContext({ electron });

    const granted: boolean[] = [];
    for (const handler of electron.permissionRequestHandlers) {
      (
        handler as unknown as (
          wc: unknown,
          p: string,
          cb: (g: boolean) => void,
        ) => void
      )(null, "media", (g) => granted.push(g));
    }
    expect(granted).toEqual([false]);
    expect(
      (electron.permissionCheckHandlers[0] as unknown as () => boolean)(),
    ).toBe(false);
  });

  it("denies a popup rather than putting a visible window on screen", async () => {
    // Electron's default for `window.open` is a REAL, visible browser window
    // running a page the agent is driving — and one the driver has no handle
    // on, so nothing would ever close it.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();

    const handler = electron.windows[0]?.webContents.windowOpenHandler;
    expect(handler?.({ url: "https://popup.test/" })).toEqual({
      action: "deny",
    });
  });
});

describe("electron context — profiles", () => {
  it("keeps one profile across boots for a project", async () => {
    const electron = fakeElectron();
    await launchElectronContext({
      electron,
      contextMode: "persistent",
      partitionKey: "proj-a",
    });
    expect(electron.partitions).toEqual(["persist:mcpjam-browser-proj-a"]);
  });

  it("gives an unattended run a partition that dies with it", async () => {
    // No `persist:` prefix is what makes Electron keep it in memory. Two runs
    // sharing one would share cookies, which is the whole point of ephemeral.
    const electron = fakeElectron();
    await launchElectronContext({ electron, contextMode: "ephemeral" });
    const [partition] = electron.partitions;
    expect(partition).toBeDefined();
    expect(partition!.startsWith("persist:")).toBe(false);

    const second = fakeElectron();
    await launchElectronContext({ electron: second, contextMode: "ephemeral" });
    expect(second.partitions[0]).not.toBe(partition);
  });
});

describe("electron context — lifecycle", () => {
  it("destroys every window it opened", async () => {
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();
    await context.newPage();

    await context.close();

    expect(electron.windows.map((w) => w.isDestroyed())).toEqual([true, true]);
    expect(context.isConnected()).toBe(false);
  });

  it("drops a window when its page closes, not only at teardown", async () => {
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    const page = await context.newPage();

    await page.close();

    expect(electron.windows[0]?.isDestroyed()).toBe(true);
    // ...and the slot is free again, which is what makes the cap a cap on
    // LIVE tabs rather than on tabs ever opened.
    for (let i = 0; i < ELECTRON_TAB_CAP; i += 1) await context.newPage();
    expect(electron.windows).toHaveLength(ELECTRON_TAB_CAP + 1);
  });

  it("refuses a new tab once teardown has begun", async () => {
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.close();
    await expect(context.newPage()).rejects.toThrow(/shutting down/);
  });

  it("caps the tabs, because each one is a renderer process", async () => {
    // A runaway `window.open` loop inside the user's desktop app spawns
    // processes until the machine gives up. Refuse in prose the driver reports.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    for (let i = 0; i < ELECTRON_TAB_CAP; i += 1) await context.newPage();

    await expect(context.newPage()).rejects.toThrow(
      /timeout|not found|no element|strict mode/i,
    );
    expect(electron.windows).toHaveLength(ELECTRON_TAB_CAP);
  });

  it("survives a window the app already tore down", async () => {
    // Quitting the app destroys windows underneath us; teardown must not throw
    // on the way out or the server's shutdown stops there.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();
    electron.windows[0]!.destroy();

    await expect(context.close()).resolves.toBeUndefined();
  });
});

describe("electron context — the page it hands back", () => {
  it("drives the webContents the window was built with", async () => {
    const contents = new FakeBrowserWebContents();
    const electron = fakeElectron([contents]);
    const context = await launchElectronContext({ electron });

    const page = await context.newPage();
    await page.goto("https://example.test/");

    expect(contents.navigations).toEqual(["https://example.test/"]);
    expect(page.url()).toBe("https://example.test/");
  });

  it("brings the window forward for activate_tab", async () => {
    const contents = new FakeBrowserWebContents();
    const electron = fakeElectron([contents]);
    const context = await launchElectronContext({ electron });
    const page = await context.newPage();

    await page.bringToFront();

    expect(electron.windows[0]?.focusCount).toBe(1);
    expect(contents.focused).toBe(1);
  });
});

describe("electron context — the app's own windows still work", () => {
  it("marks its windows so the app can tell them from a person's", async () => {
    // These are real `BrowserWindow`s, so Electron counts them. An open agent
    // tab therefore stopped `window-all-closed` firing — on Windows and Linux
    // the app never quit — and stopped `activate`'s zero-window check passing,
    // so a dock click on macOS rebuilt nothing and left the app running with
    // no way to reach its UI.
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    await context.newPage();
    await context.newPage();

    expect(agentBrowserWindowCount()).toBe(2);
    expect(isAgentBrowserWindow(electron.windows[0]!)).toBe(true);
    // A window with an id nothing registered is a person's.
    expect(isAgentBrowserWindow({ id: 99_999 })).toBe(false);
  });

  it("stops counting a window once it is gone", async () => {
    const electron = fakeElectron();
    const context = await launchElectronContext({ electron });
    const page = await context.newPage();
    await context.newPage();

    await page.close();
    expect(agentBrowserWindowCount()).toBe(1);

    await context.close();
    expect(agentBrowserWindowCount()).toBe(0);
  });
});

describe("electron context — outside Electron", () => {
  it("fails at launch rather than at the first act", async () => {
    // The session module picks the factory from ELECTRON_APP. A mismatch means
    // it picked wrong, and that should be loud where it happened.
    //
    // It also has to be decided WITHOUT importing the specifier: in a plain
    // Node process `electron` resolves to a string — the path to a binary — so
    // the import succeeds and the failure moves somewhere less obvious. This
    // test runs in exactly that process, so a regression to an import-based
    // check shows up here as a slow test that reaches for the filesystem.
    expect(process.versions.electron).toBeUndefined();
    await expect(launchElectronContext({})).rejects.toThrow(/not Electron/i);
  });
});
