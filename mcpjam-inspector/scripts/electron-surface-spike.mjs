/**
 * Does Electron actually let us show the agent's browser?
 *
 * ── Why a spike and not a unit test ──────────────────────────────────────
 * The native surface (`server/services/browserd/electron/`) is built on six
 * behaviours of Electron itself, and every one of them is a claim about a
 * C++ implementation rather than about our code. A fake `WebContentsView` in
 * a suite proves the surface calls `addChildView` in the right order; it
 * cannot prove that moving a live view between windows keeps the page's
 * JavaScript alive, and if that is false the whole design is wrong in a way
 * no amount of unit testing would have caught.
 *
 * So this runs against the real thing:
 *
 *   RUN_BROWSERD_SPIKE=true npx electron scripts/electron-surface-spike.mjs
 *
 * It prints ONE JSON object and exits non-zero if any check failed, so it can
 * be read by a person or gated on by a machine. It opens a visible window for
 * a moment and then quits; it downloads nothing and touches no profile.
 *
 * ── The six checks ───────────────────────────────────────────────────────
 * (a) The constructors exist at all. Older Electron has neither, and the
 *     engine falls back to a hidden window per tab.
 * (b) A view parented into a HIDDEN `BaseWindow` still loads and paints.
 *     This is what lets a tab exist before any pane is looking at it — an
 *     unrendered page starves the screencast and stops running timers.
 * (c) Reparenting into a VISIBLE window keeps the page. The premise of the
 *     whole feature: `show()` moves the view rather than rebuilding it, so a
 *     person opening the rail does not reload the agent's half-filled form.
 * (d) `setBounds` is honoured — the page reports the size we asked for. If it
 *     were not, every coordinate in the pane would be off.
 * (e) Taking the view back OUT keeps the page alive. `hide()` must not be a
 *     tab close: the agent is still driving it while nobody watches.
 * (f) The holder is not counted as a `BrowserWindow`. `src/main.ts` quits the
 *     app on `window-all-closed`, so a holder that counted would keep the
 *     app running forever with no window a person can reach.
 */
if (process.env.RUN_BROWSERD_SPIKE !== "true") {
  // A skip is not a failure: this is the same gate the daemon's own launch
  // spike uses, so an accidental `npm test` never starts a browser.
  console.log(
    JSON.stringify(
      { spike: "electron-surface", skipped: "set RUN_BROWSERD_SPIKE=true" },
      null,
      2,
    ),
  );
  process.exit(0);
}

// `process.versions.electron` FIRST, because importing the specifier is not the
// same question: in a plain Node process the `electron` package resolves to a
// STRING — the path to a binary — so the import succeeds and then everything
// built on it fails somewhere less obvious.
if (!process.versions.electron) {
  console.error(
    "electron-surface-spike: run this with Electron, not Node —\n" +
      "  RUN_BROWSERD_SPIKE=true npx electron scripts/electron-surface-spike.mjs",
  );
  process.exit(1);
}

// Imported dynamically, and AFTER the two gates above, so both of them can
// answer under plain Node: a static named import of `electron` is a parse
// error there, which would fire before either check ran.
const { app, BaseWindow, BrowserWindow, WebContentsView } =
  await import("electron");

// This is a hand-run diagnostic, and the boxes it gets run in (CI images,
// containers) have no user namespace for Chromium's sandbox. Never a pattern
// for shipped code — the engine's own windows keep `sandbox: true`.
app.commandLine.appendSwitch("no-sandbox");

/** A page that REMEMBERS things, so "did it reload?" has an answer. */
const PAGE = `data:text/html,${encodeURIComponent(
  `<!doctype html><title>spike</title>
   <body style="margin:0;background:#123">
   <script>
     window.__spikeMark = Math.random().toString(36).slice(2);
     window.__spikeFrames = 0;
     const tick = () => { window.__spikeFrames += 1; requestAnimationFrame(tick); };
     requestAnimationFrame(tick);
   </script>`,
)}`;

const checks = [];
const check = (id, name, ok, detail) => {
  checks.push({ id, name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  return Boolean(ok);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  check(
    "a",
    "WebContentsView and BaseWindow exist",
    typeof WebContentsView === "function" && typeof BaseWindow === "function",
    `electron ${process.versions.electron}`,
  );
  if (!checks[0].ok) return;

  // (b) A hidden holder that still renders.
  const holder = new BaseWindow({
    show: false,
    width: 1024,
    height: 768,
    useContentSize: true,
  });
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The one preference this check is really about: without it a view in a
      // hidden holder is throttled to a crawl and the page stops running.
      backgroundThrottling: false,
    },
  });
  holder.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
  await view.webContents.loadURL(PAGE);
  await wait(500);
  const hiddenMark =
    await view.webContents.executeJavaScript("window.__spikeMark");
  const hiddenFrames = await view.webContents.executeJavaScript(
    "window.__spikeFrames",
  );
  check(
    "b",
    "a view in a hidden holder loads and keeps running",
    typeof hiddenMark === "string" && hiddenFrames > 0,
    `frames=${hiddenFrames}`,
  );

  // (f) …and the holder is not a window as far as the app's accounting goes.
  check(
    "f",
    "a BaseWindow is not counted by BrowserWindow.getAllWindows()",
    !BrowserWindow.getAllWindows().some((w) => w.id === holder.id),
    `windows=${BrowserWindow.getAllWindows().length}`,
  );

  // (c) Reparent into a real, visible window.
  const main = new BrowserWindow({ width: 1200, height: 900, show: true });
  await main.loadURL("data:text/html,<title>host</title><body>host");
  holder.contentView.removeChildView(view);
  main.contentView.addChildView(view);
  const BOUNDS = { x: 40, y: 60, width: 600, height: 400 };
  view.setBounds(BOUNDS);
  await wait(500);
  const movedMark =
    await view.webContents.executeJavaScript("window.__spikeMark");
  check(
    "c",
    "reparenting into a visible window keeps the page",
    movedMark === hiddenMark,
    movedMark === hiddenMark
      ? undefined
      : `reloaded: ${hiddenMark} → ${movedMark}`,
  );

  // (d) The rectangle we asked for is the rectangle the page got.
  const size = await view.webContents.executeJavaScript(
    "[window.innerWidth, window.innerHeight]",
  );
  check(
    "d",
    "setBounds is honoured by the page",
    size[0] === BOUNDS.width && size[1] === BOUNDS.height,
    `asked ${BOUNDS.width}x${BOUNDS.height}, got ${size[0]}x${size[1]}`,
  );

  // (e) Taking it back out is a HIDE, not a close.
  const framesBefore = await view.webContents.executeJavaScript(
    "window.__spikeFrames",
  );
  main.contentView.removeChildView(view);
  await wait(500);
  const detachedMark =
    await view.webContents.executeJavaScript("window.__spikeMark");
  const framesAfter = await view.webContents.executeJavaScript(
    "window.__spikeFrames",
  );
  check(
    "e",
    "a detached view keeps its page alive",
    detachedMark === hiddenMark && !view.webContents.isDestroyed(),
    `frames ${framesBefore} → ${framesAfter}`,
  );

  view.webContents.close();
  main.destroy();
  holder.destroy();
}

app.whenReady().then(async () => {
  let error;
  try {
    await run();
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const ok = !error && checks.length > 0 && checks.every((c) => c.ok);
  console.log(
    JSON.stringify(
      {
        spike: "electron-surface",
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        ok,
        ...(error ? { error } : {}),
        checks,
      },
      null,
      2,
    ),
  );
  // `app.exit` rather than `process.exit`: Electron has windows and a GPU
  // process to tear down, and a bare exit leaves them behind on some
  // platforms.
  app.exit(ok ? 0 : 1);
});
