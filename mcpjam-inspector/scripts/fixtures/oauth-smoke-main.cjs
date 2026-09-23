const { app, BrowserWindow, ipcMain } = require("electron");
const { OAuthCallbackDelivery } = require("./delivery.cjs");
const assert = require("node:assert/strict");
app.setPath("userData", __dirname + "/profile");
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: __dirname + "/preload.cjs",
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const delivery = new OAuthCallbackDelivery((url) =>
      win.webContents.send("oauth-callback", url),
    );
    ipcMain.on("oauth:listener-ready", (event, ready) => {
      if (
        event.sender === win.webContents &&
        event.senderFrame === win.webContents.mainFrame
      )
        delivery.setReady(ready === true);
    });
    let loads = 0;
    win.webContents.on("did-finish-load", () => loads++);
    win.webContents.on("did-start-navigation", (_, url, inPlace, main) => {
      if (main && !inPlace) delivery.setReady(false);
    });
    delivery.enqueue("cold");
    await win.loadURL("data:text/html,<title>OAuth smoke</title>");
    await win.webContents.executeJavaScript(
      `window.identity = {user:'original'}; window.results=[]; window.electronAPI.oauth.onCallback(url=>window.results.push(url));`,
    );
    async function waitCount(count) {
      for (let n = 0; n < 100; n++) {
        if (
          (await win.webContents.executeJavaScript("window.results.length")) ===
          count
        )
          return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("callback was not delivered");
    }
    await waitCount(1);
    delivery.enqueue("warm");
    await waitCount(2);
    assert.deepEqual(
      await win.webContents.executeJavaScript("window.results"),
      ["cold", "warm"],
    );
    assert.equal(
      await win.webContents.executeJavaScript("window.identity.user"),
      "original",
    );
    assert.equal(loads, 1);
    await win.webContents.executeJavaScript(
      "window.electronAPI.oauth.removeCallback()",
    );
    await new Promise((r) => setTimeout(r, 30));
    delivery.enqueue("queued");
    await win.webContents.executeJavaScript(
      "window.electronAPI.oauth.onCallback(url=>window.results.push(url))",
    );
    await waitCount(3);
    assert.equal(loads, 1);
    process.stdout.write(
      "PASS: cold queue, warm IPC, listener re-registration, identity preserved, no reload\n",
    );
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error) + "\n");
    app.exit(1);
  });
setTimeout(() => app.exit(2), 15000).unref();
