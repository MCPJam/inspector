import { app, BaseWindow } from "electron";
import { createServer } from "node:http";

import { launchElectronContext } from "../server/services/browserd/electron/electron-context";
import { createContextSurface } from "../server/services/browserd/electron/agent-surface";
import { ChromiumDriver } from "../server/services/browserd/daemon/chromium-driver";
// Bundle with esbuild --platform=node --external:electron, then run with Electron.
setTimeout(() => {
  process.stderr.write("Electron navigation smoke timed out\n");
  app.exit(2);
}, 30000).unref();
app.whenReady().then(async () => {
  let driver: ChromiumDriver | undefined;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<title>${req.url}</title><a style="display:block;width:400px;height:300px" href="/popup" target="_blank" rel="opener">Popup</a>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const surface = createContextSurface({ authority: "shared" });
    const context = await launchElectronContext({
      nativeSurface: true,
      contextMode: "ephemeral",
      surface,
    });
    const popupSeen: any[] = [];
    let parentPage: any;
    context.onPageCreated!((event) => popupSeen.push(event));
    const originalNewPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await originalNewPage();
      parentPage ??= page;
      return page;
    };
    driver = new ChromiumDriver(context);
    const url = `http://127.0.0.1:${(server.address() as any).port}/parent`;
    const window = new BaseWindow({ show: false, width: 1100, height: 900 });
    surface.show({
      holder: window,
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
    });
    if (!surface.inputAllowed())
      throw new Error("shared surface refused input");
    const result = await driver.execute({
      commandId: "nav",
      source: "inspector",
      action: { kind: "navigate", url },
    });
    if (!result.ok) throw new Error(result.error);
    const parentCdp = await parentPage.cdp();
    await parentCdp.send("Runtime.evaluate", {
      expression: 'document.querySelector("a").click()',
      userGesture: true,
    });
    const deadline = Date.now() + 10000;
    while (driver.tabsSnapshot().list.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    const opened = await driver.stateSnapshot();
    if (opened.tabs.length !== 2 || !popupSeen[0])
      throw new Error("popup was not adopted");
    const child = opened.tabs.find((t) => t.id === opened.activeTabId)!;
    if (child.openerId !== "@session")
      throw new Error("missing opener identity");
    const cdp = await popupSeen[0].page.cdp();
    const opener = await cdp.send("Runtime.evaluate", {
      expression: "window.opener.location.pathname",
      returnByValue: true,
    });
    if (opener.result?.value !== "/parent")
      throw new Error("window.opener was lost");
    await driver.execute({
      commandId: "close",
      source: "inspector",
      tabId: child.id,
      action: { kind: "act", verb: "close_tab" },
    });
    if (driver.tabsSnapshot().active !== "@session")
      throw new Error("did not return to opener");
    process.stdout.write(
      JSON.stringify({
        ok: true,
        electron: process.versions.electron,
        popup: child.url,
        opener: opener.result.value,
        sharedInput: true,
      }) + "\n",
    );
    window.destroy();
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: String(error) }) + "\n",
    );
    process.exitCode = 1;
  } finally {
    await driver?.close();
    server.close();
    app.quit();
  }
});
