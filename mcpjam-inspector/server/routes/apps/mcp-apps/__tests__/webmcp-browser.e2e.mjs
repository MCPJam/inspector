/** Manual end-to-end suite; run with node --import tsx. Not a CI Vitest target. */
import { build } from "esbuild";
import { chromium, _electron } from "playwright";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { renderSandboxProxyHtml } from "../sandbox-proxy-html.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const fixtures = path.join(
  root,
  "mcpjam-inspector/server/routes/apps/mcp-apps/__tests__/fixtures/webmcp",
);
const baselineCommit = "4dbef72d18e15e24316b090e853ec1123d7be53f";
const pin = "efcc19c377770f64d4844485bb2be73a6c4b813c";
const upstream = process.env.MCPJAM_EXT_APPS_FIXTURE_REPO;
if (!upstream)
  throw new Error(
    "Set MCPJAM_EXT_APPS_FIXTURE_REPO to an ext-apps checkout containing the pinned commit",
  );
const temp = await mkdtemp(path.join(tmpdir(), "mcpjam-webmcp-spike-"));
async function makeTemporaryDirectoriesWritable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await makeTemporaryDirectoriesWritable(path.join(directory, entry.name));
  }
}
const results = [];
const source = path.join(temp, "upstream");
await mkdir(source);
execFileSync("tar", ["-x", "-C", source], {
  input: execFileSync("git", ["-C", upstream, "archive", pin], {
    maxBuffer: 64 * 1024 * 1024,
  }),
});

async function bundle(entry, app, minify = false) {
  const output = await build({
    entryPoints: [path.join(fixtures, entry)],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify,
    alias: {
      "spike-app": app,
      "spike-runtime": path.join(root, "sdk/src/widget-runtime/index.ts"),
    },
    nodePaths: [path.join(root, "node_modules")],
  });
  return output.outputFiles[0].text;
}
const require = createRequire(import.meta.url);
const installedApp = require.resolve("@modelcontextprotocol/ext-apps");
const host = await bundle("host.mjs", installedApp);
const views = {
  legacy: await bundle("view.mjs", installedApp),
  direct: await bundle("view.mjs", installedApp),
  v3: await bundle("view.mjs", path.join(source, "src/app.ts")),
};
let proxy = renderSandboxProxyHtml();
const baseline = execFileSync(
  "git",
  [
    "show",
    `${baselineCommit}:mcpjam-inspector/server/routes/apps/mcp-apps/sandbox-proxy.html`,
  ],
  { cwd: root, encoding: "utf8" },
)
  .replace('"__MCPJAM_RECORDER_SHIM__"', '""')
  .replace(
    '"__MCPJAM_HOST_ORIGINS__"',
    JSON.stringify(["http://127.0.0.1:*", "http://localhost:*"]),
  );
const escapeHtml = (text) => text.replace(/[&<>]/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
const escapeScript = (text) => text.replace(/<\/script/gi, "<\\/script");
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/host.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(host);
  } else if (url.pathname === "/proxy") {
    response.end(
      url.searchParams.get("baseline") === "true" ? baseline : proxy,
    );
  } else if (url.pathname === "/view") {
    const settings = {
      id: url.searchParams.get("id") || "A",
      source: url.searchParams.get("source") || "direct",
    };
    const code = views[settings.source.startsWith("v3") ? "v3" : settings.source];
    if (typeof code !== "string") { response.writeHead(400); response.end("Unknown fixture"); return; }
    response.end(
      `<!doctype html><html><head></head><body><pre id="settings">${escapeHtml(JSON.stringify(settings))}</pre><script>${escapeScript(code)}</script></body></html>`,
    );
  } else
    response.end(
      '<!doctype html><html><body><script src="/host.js"></script></body></html>',
    );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;

async function check(page, runtime, name, body) {
  const started = Date.now();
  let timeout;
  try {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.spike));
    await Promise.race([
      body(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Scenario timed out")),
          12000,
        );
      }),
    ]);
    results.push({
      runtime,
      name,
      status: "pass",
      durationMs: Date.now() - started,
    });
    process.stdout.write(`PASS ${runtime} ${name}\n`);
  } catch (error) {
    results.push({ runtime, name, status: "fail", error: error.message });
    process.stdout.write(`FAIL ${runtime} ${name}: ${error.message}\n`);
  } finally {
    clearTimeout(timeout);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function exercise(page, runtime) {
  for (const mode of ["write", "srcdoc", "opaque"]) {
    for (const source of ["legacy", "direct", "v3", "v3-tools"]) {
      await check(page, runtime, `${mode}/${source}`, async () => {
        const result = await page.evaluate(
          async ({ mode, source }) => {
            const found = await window.spike.mount({ id: "A", mode, source });
            return {
              found,
              result: await window.spike.call("A", { move: "e4" }),
            };
          },
          { mode, source },
        );
        assert(result.found.tools.length === 1, "Expected one tool");
        assert(
          result.found.source === (source === "legacy" ? "mcp-apps" : "webmcp"),
          "Wrong source",
        );
        assert(
          result.result.content[0].text.includes('"board":"A"'),
          "Missing board identity in model text",
        );
      });
    }
    for (const enabled of [false, null]) {
      for (const source of ["legacy", "direct"]) {
        await check(
          page,
          runtime,
          `${mode}/${source}/${enabled === null ? "absent" : "disabled"}`,
          async () => {
            const result = await page.evaluate(
              (settings) => window.spike.mount({ id: "A", ...settings }),
              { mode, source, enabled },
            );
            assert(
              result.tools.length === (source === "legacy" ? 1 : 0),
              "Disabled capability changed tool exposure",
            );
          },
        );
      }
    }
    await check(page, runtime, `${mode}/permissive`, async () => {
      const result = await page.evaluate(async (mode) => {
        await window.spike.mount({ id: "A", mode, permissive: true });
        return window.spike.call("A");
      }, mode);
      assert(
        result.structuredContent.board === "A",
        "Permissive CSP blocked the relay",
      );
    });
    await check(page, runtime, `${mode}/csp-enforcement`, async () => {
      await page.evaluate(
        (mode) => window.spike.mount({ id: "A", mode }),
        mode,
      );
      const rootFrame =
        typeof page.mainFrame === "function" ? page.mainFrame() : page;
      const view = rootFrame.childFrames()[0].childFrames()[0];
      const allowed = await view.evaluate(async (url) => {
        try {
          await fetch(url);
          return true;
        } catch (error) {
          return false;
        }
      }, url + "/probe");
      assert(!allowed, "Restrictive CSP allowed an undeclared network request");
    });
    await check(page, runtime, `${mode}/remount`, async () => {
      const result = await page.evaluate(async (mode) => {
        await window.spike.mount({ id: "A", mode });
        await window.spike.call("A");
        await window.spike.remount("A");
        await window.spike.list("A");
        return window.spike.call("A");
      }, mode);
      assert(
        result.structuredContent.moves === 1,
        "Remount retained stale app state",
      );
    });
  }
  await check(page, runtime, "two-apps/out-of-order", async () => {
    const result = await page.evaluate(async () => {
      await window.spike.mount({ id: "A", mode: "opaque" });
      await window.spike.mount({ id: "B", mode: "write" });
      const calls = await Promise.all([
        window.spike.call("A", { delay: 100 }),
        window.spike.call("B"),
      ]);
      await window.spike.close("A");
      return { calls, surviving: await window.spike.call("B") };
    });
    assert(
      result.calls[0].structuredContent.board === "A",
      "A received wrong result",
    );
    assert(
      result.calls[1].structuredContent.board === "B",
      "B received wrong result",
    );
    assert(
      result.surviving.structuredContent.moves === 2,
      "Closing A affected B",
    );
  });
  await check(page, runtime, "cancel-and-size", async () => {
    const result = await page.evaluate(async () => {
      await window.spike.mount({ id: "A", mode: "opaque" });
      let cancelled = false;
      try {
        await window.spike.call("A", { kind: "wait" }, 100);
      } catch (error) {
        cancelled = true;
      }
      return {
        cancelled,
        large: await window.spike.call("A", { kind: "large" }),
        cycle: await window.spike.call("A", { kind: "cycle" }),
      };
    });
    assert(result.cancelled, "Cancellation did not settle");
    assert(
      result.large.isError && result.cycle.isError,
      "Encoding failures were not bounded errors",
    );
    const rootFrame =
      typeof page.mainFrame === "function" ? page.mainFrame() : page;
    const view = rootFrame
      .childFrames()
      .flatMap((frame) => frame.childFrames())[0];
    await view.waitForFunction(
      () => document.body.dataset.cancelled === "true",
    );
  });
  await check(page, runtime, "registration-change", async () => {
    await page.evaluate(() => window.spike.mount({ id: "A", mode: "opaque" }));
    const rootFrame =
      typeof page.mainFrame === "function" ? page.mainFrame() : page;
    const view = rootFrame
      .childFrames()
      .flatMap((frame) => frame.childFrames())[0];
    assert(view, "App frame missing");
    await view.evaluate(async () => {
      const controller = new AbortController();
      Reflect.set(window, "temporaryTool", controller);
      await document.modelContext.registerTool(
        { name: "temporary", description: "Temporary", execute: () => null },
        { signal: controller.signal },
      );
    });
    assert(
      (await page.evaluate(() => window.spike.list("A"))).length === 2,
      "Late registration missing",
    );
    await view.evaluate(() => Reflect.get(window, "temporaryTool").abort());
    assert(
      (await page.evaluate(() => window.spike.list("A"))).length === 1,
      "Unregistered tool retained",
    );
    await view.evaluate(() => Reflect.get(window, "initialTool").abort());
    assert(
      (await page.evaluate(() => window.spike.list("A"))).length === 0,
      "Expected an empty registry",
    );
    await view.evaluate(() =>
      document.modelContext.registerTool({
        name: "make_move",
        description: "Recovered",
        execute: () => ({ board: "A", recovered: true }),
      }),
    );
    await page.evaluate(() => window.spike.list("A"));
    assert(
      (await page.evaluate(() => window.spike.call("A"))).structuredContent
        .recovered,
      "Empty registry did not recover",
    );
  });
  await check(page, runtime, "sibling-spoof", async () => {
    await page.evaluate(async () => {
      await window.spike.mount({ id: "A", mode: "opaque" });
      await window.spike.mount({ id: "B", mode: "write" });
    });
    const rootFrame =
      typeof page.mainFrame === "function" ? page.mainFrame() : page;
    const view = rootFrame.childFrames()[0].childFrames()[0];
    const pending = page.evaluate(() => window.spike.call("B", { delay: 250 }));
    await view.evaluate(() =>
      window.parent.parent.frames[1].postMessage(
        {
          type: "mcpjam:webmcp/call-result",
          requestId: "1:2",
          ok: true,
          value: { board: "forged" },
        },
        "*",
      ),
    );
    assert(
      (await pending).structuredContent.board === "B",
      "A sibling forged B's tool result",
    );
  });
  await check(page, runtime, "opaque-navigation", async () => {
    await page.evaluate(() => window.spike.mount({ id: "A", mode: "opaque" }));
    const pending = page.evaluate(async () => {
      try {
        await window.spike.call("A", { kind: "wait" });
        return false;
      } catch (error) {
        return true;
      }
    });
    const rootFrame =
      typeof page.mainFrame === "function" ? page.mainFrame() : page;
    const view = rootFrame.childFrames()[0].childFrames()[0];
    await view.goto("about:blank");
    assert(await pending, "Navigation left the tool request pending");
    await page.evaluate(() => window.spike.remount("A"));
    await page.evaluate(() => window.spike.list("A"));
    assert(
      (await page.evaluate(() => window.spike.call("A"))).structuredContent
        .board === "A",
      "Fresh mount did not recover",
    );
  });
  await check(page, runtime, "malformed-list-and-timeout", async () => {
    await page.evaluate(() => window.spike.mount({ id: "A", mode: "opaque" }));
    const rootFrame =
      typeof page.mainFrame === "function" ? page.mainFrame() : page;
    const view = rootFrame.childFrames()[0].childFrames()[0];
    await view.evaluate(() => {
      // An untrusted view can alter its own builtins and bypass the polyfill's
      // descriptor shape. The proxy must independently validate the reply.
      Array.from = () => "invalid";
    });
    const malformed = await page.evaluate(async () => {
      try {
        await window.spike.list("A");
        return null;
      } catch (error) {
        return error.code;
      }
    });
    assert(malformed === -32603, "Malformed list was accepted");
    await view.evaluate(() => {
      // An uncloneable reply never leaves the view, exercising the actual
      // proxy timeout rather than a mocked timer or transport failure.
      Array.from = () => () => {};
    });
    const timedOut = await page.evaluate(async () => {
      try {
        await window.spike.list("A");
        return null;
      } catch (error) {
        return error.code;
      }
    });
    assert(
      timedOut === -32603,
      "Unresponsive view did not settle with an error",
    );
  });
  await check(page, runtime, "legacy-baseline", async () => {
    const run = async (baseline) =>
      page.evaluate(async (baseline) => {
        await window.spike.mount({ id: "A", source: "legacy", baseline });
        const result = await window.spike.call("A");
        const reserved = window.spike.traffic.filter((message) =>
          message.method?.startsWith("ui/sandbox-"),
        );
        return { result, reserved: reserved.length };
      }, baseline);
    const before = await run(true);
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.spike));
    const after = await run(false);
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      "Legacy behavior changed from baseline",
    );
  });
}

try {
  for (const native of process.env.MCPJAM_SPIKE_RUNTIME === "electron"
    ? []
    : [false, true]) {
    const browser = await chromium.launch({
      headless: true,
      args: [native ? "--enable-features=WebMCP" : "--disable-features=WebMCP"],
    });
    try {
      await exercise(
        await browser.newPage(),
        `chromium-${browser.version()}-native-${native}`,
      );
    } finally {
      await browser.close();
    }
  }
  if (process.env.MCPJAM_SPIKE_ELECTRON === "1") {
    const main = path.join(temp, "electron.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('enable-features','WebMCP');app.commandLine.appendSwitch('enable-blink-features','WebMCP');app.whenReady().then(()=>{const w=new BrowserWindow({show:false});w.loadURL(process.env.MCPJAM_E2E_URL);});`,
    );
    const app = await _electron.launch({
      executablePath: require("electron"),
      args: [main],
      env: { ...process.env, MCPJAM_E2E_URL: url },
    });
    try {
      await exercise(await app.firstWindow(), "electron-native-true");
    } finally {
      await app.close();
    }
  }
  if (process.env.MCPJAM_SPIKE_PACKAGED_APP) {
    const profile = path.join(temp, "packaged-profile");
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const debugPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const app = spawn(
      path.resolve(process.env.MCPJAM_SPIKE_PACKAGED_APP),
      [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`],
      {
        env: { ...process.env, SERVER_PORT: "16274" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const bootErrors = [];
    const capture = (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!/error|failed|cannot find/i.test(line)) continue;
        bootErrors.push(
          line
            .replace(/https?:\/\/\S+/g, "[url]")
            .replace(/[A-Za-z0-9_.-]{48,}/g, "[redacted]")
            .slice(0, 400),
        );
      }
    };
    app.stdout.on("data", capture);
    app.stderr.on("data", capture);
    let browser;
    try {
      const deadline = Date.now() + 30000;
      let connected = false;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${debugPort}/json/version`,
            { signal: AbortSignal.timeout(1000) },
          );
          if (response.ok) {
            connected = true;
            break;
          }
        } catch (error) {
          if (app.exitCode !== null)
            throw new Error(`Packaged app exited with code ${app.exitCode}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(connected, "Packaged browser debugging endpoint did not start");
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const context = browser.contexts()[0];
      let main = context.pages()[0];
      if (!main) {
        try {
          main = await context.waitForEvent("page", { timeout: 15000 });
        } catch (error) {
          throw new Error(
            `Packaged app did not create a window: ${bootErrors.slice(-5).join("; ")}`,
          );
        }
      }
      main.on("dialog", (dialog) => {
        void dialog.dismiss().catch((error) => {
          process.stderr.write(
            `QA window dialog cleanup failed: ${error.name}\n`,
          );
        });
      });
      await main.waitForURL(/http:\/\/127\.0\.0\.1:\d+/, { timeout: 60000 });
      const response = await main.request.get(
        new URL("/api/apps/mcp-apps/sandbox-proxy", main.url()).href,
      );
      assert(response.ok(), `Packaged proxy response: ${response.status()}`);
      proxy = await response.text();
      assert(
        proxy.includes("createWebmcpRelay"),
        "Packaged proxy is missing WebMCP relay",
      );
      await main.evaluate((url) => {
        const frame = document.createElement("iframe");
        frame.id = "webmcp-spike-host";
        frame.src = url;
        document.body.appendChild(frame);
      }, url);
      const element = await main.$("#webmcp-spike-host");
      const harnessFrame = await element.contentFrame();
      assert(harnessFrame, "Packaged test frame was not created");
      await exercise(
        harnessFrame,
        `packaged-electron-chromium-${browser.version()}`,
      );
    } finally {
      if (browser) await browser.close();
      if (app.exitCode === null) {
        const exited = new Promise((resolve) => app.once("exit", resolve));
        app.kill("SIGTERM");
        const stopped = await Promise.race([
          exited.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        if (!stopped) {
          app.kill("SIGKILL");
          await exited;
        }
      }
    }
  }
} catch (error) {
  results.push({
    runtime: "startup",
    name: "browser-launch",
    status: "fail",
    error: error.message,
  });
  process.stderr.write(`Spike could not complete: ${error.message}\n`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await makeTemporaryDirectoriesWritable(temp);
  await rm(temp, { recursive: true, force: true });
  const output = path.join(
    root,
    process.env.MCPJAM_SPIKE_PACKAGED_APP
      ? "mcpjam-inspector/.playwright/webmcp-packaged-spike.json"
      : "mcpjam-inspector/.playwright/webmcp-app-tools-spike.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ baselineCommit, pin, results }, null, 2));
  process.stdout.write(`Baseline: ${baselineCommit}\n`);
  process.stdout.write(`Evidence: ${output}\n`);
}
if (results.some((result) => result.status !== "pass")) process.exitCode = 1;
