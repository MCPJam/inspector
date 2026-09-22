/** Synthetic fixtures only. Run through run-local-browser-security-smoke.mjs. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowserdContext } from "../server/services/browserd/daemon/chromium-launch";
import { launchElectronContext } from "../server/services/browserd/electron/electron-context";
import { createLocalBrowserSecurityPolicy } from "../server/services/browserd/local/security-policy";

async function main() {
  const electron = Boolean(process.versions.electron);
  const directory =
    process.env.MCPJAM_SECURITY_SMOKE_DIR ??
    (await mkdtemp(join(tmpdir(), "mcpjam-security-smoke-")));
  let app: Electron.App | undefined;
  if (electron) {
    app = (await import("electron")).app;
    app.setPath("userData", join(directory, "electron"));
    app.commandLine.appendSwitch("enable-features", "WebMCP");
    app.commandLine.appendSwitch("enable-blink-features", "WebMCP");
    app.on("window-all-closed", () => {});
    await app.whenReady();
  }
  let controllerHits = 0;
  const controller = createServer((_req, res) => {
    controllerHits++;
    res.end("synthetic-secret");
  });
  controller.on("upgrade", (_req, socket) => {
    controllerHits++;
    socket.destroy();
  });
  const website = createServer((req, res) => {
    if (req.url === "/worker.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `fetch(${JSON.stringify(
          controllerUrl,
        )}).catch(()=>{}); new WebSocket(${JSON.stringify(
          controllerUrl.replace("http:", "ws:"),
        )}); postMessage("started");`,
      );
      return;
    }
    if (req.url === "/sw.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `self.addEventListener("install", e => e.waitUntil(fetch(${JSON.stringify(
          controllerUrl,
        )}).catch(()=>{})));`,
      );
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: controllerUrl });
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<body>Local development works</body>");
  });
  website.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(
        String(req.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", () => socket.end());
  });
  const listen = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listen(controller);
  await listen(website);
  const controllerUrl = `http://127.0.0.1:${
    (controller.address() as import("node:net").AddressInfo).port
  }`;
  const websiteUrl = `http://127.0.0.1:${
    (website.address() as import("node:net").AddressInfo).port
  }`;
  let valid = true;
  const callbacks = new Set<() => void | Promise<void>>();
  const policy = createLocalBrowserSecurityPolicy({
    controllerUrls: [controllerUrl],
    isActive: () => valid,
    assertActive: async () => {
      assert(valid, "permission revoked");
    },
    onRevoked: (callback) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  });
  const context = electron
    ? await launchElectronContext({ securityPolicy: policy })
    : await launchBrowserdContext({
        userDataDir: "",
        headless: true,
        contextMode: "ephemeral",
        channel: "chromium",
        securityPolicy: policy,
      });
  try {
    const page = await context.newPage();
    await page.goto("https://example.com/");
    assert.match(await page.pageText(), /Example Domain/);
    await page.goto(websiteUrl);
    assert.match(await page.pageText(), /Local development works/);
    const secret = join(directory, "synthetic-secret.txt");
    await writeFile(secret, "synthetic-secret");
    for (const url of [
      pathToFileURL(secret).href,
      "javascript:document.body.textContent='unsafe'",
      "data:text/html,unsafe",
      controllerUrl,
    ]) {
      await assert.rejects(page.goto(url));
    }
    const cdp = await page.cdp();
    assert(cdp);
    const socketCheck = (await cdp.send("Runtime.evaluate", {
      expression: `new Promise(resolve => { const ws = new WebSocket(${JSON.stringify(
        websiteUrl.replace("http:", "ws:"),
      )}); ws.onopen=()=>{ws.close();resolve(true)};ws.onerror=()=>resolve(false);setTimeout(()=>resolve(false),5000); })`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value: boolean } };
    assert.equal(
      socketCheck.result.value,
      true,
      "localhost WebSocket/HMR must work",
    );
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
      fetch(${JSON.stringify(controllerUrl)}).catch(()=>{});
      new WebSocket(${JSON.stringify(controllerUrl.replace("http:", "ws:"))});
      new Worker("/worker.js"); navigator.serviceWorker.register("/sw.js").catch(()=>{});
      const frame = document.createElement("iframe"); frame.src=${JSON.stringify(
        controllerUrl,
      )}; document.body.append(frame);
      window.open(${JSON.stringify(controllerUrl)});
      if (document.modelContext) document.modelContext.registerTool({name:"smoke_tool",description:"Synthetic smoke tool",inputSchema:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"ok"}]})});
      return Boolean(document.modelContext);
    })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const bridge = await page.webmcp();
    assert(bridge, "WebMCP CDP bridge required");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(controllerHits, 0, "controller received managed traffic");
    if (!bridge.isSupported()) {
      process.stdout.write(
        JSON.stringify({
          engine: electron ? "electron" : "node",
          versions: process.versions,
          url: page.url(),
          probe: await cdp.send("Runtime.evaluate", {
            expression:
              "({document:typeof document.modelContext,navigator:typeof navigator.modelContext,secure:isSecureContext})",
            returnByValue: true,
          }),
          domain: await cdp
            .send("WebMCP.enable")
            .catch((error) => String(error)),
        }) + "\n",
      );
    }
    assert(bridge.isSupported(), "shipping engine must support WebMCP");
    // Redirects must be denied below the model/API URL validator too.
    await page.goto(websiteUrl + "/redirect").catch(() => {});
    assert.equal(controllerHits, 0);
    valid = false;
    await Promise.all([...callbacks].map((callback) => callback()));
    await assert.rejects(page.goto(websiteUrl));
    await assert.rejects(cdp.send("Runtime.evaluate", { expression: "1" }));
    process.stdout.write(
      JSON.stringify({
        engine: electron ? "electron" : "node",
        versions: process.versions,
        controllerHits,
        navigation: "blocked",
        workers: "blocked",
        revocation: "blocked",
        localhost: "passed",
        webmcp: "supported",
      }) + "\n",
    );
  } finally {
    await context.close();
    for (const server of [controller, website]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!process.env.MCPJAM_SECURITY_SMOKE_DIR)
      await rm(directory, { recursive: true, force: true });
  }
  app?.quit();
}
main().catch(async (error) => {
  process.stderr.write(String(error) + "\n");
  if (process.versions.electron) (await import("electron")).app.exit(1);
  else process.exit(1);
});
