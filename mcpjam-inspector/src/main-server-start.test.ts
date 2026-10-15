import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Drives the real `main.ts` lifecycle against a real `@hono/node-server` bind
 * on a real port, with Electron and the side-effecting modules stubbed. The
 * desktop app must never start a second server when macOS emits `activate`
 * during launch, never bootstrap in an instance that lost the single-instance
 * lock, and turn any server `error` into a dialog or a log line, not a crash.
 */
const h = vi.hoisted(() => ({
  gotLock: true,
  ready: (): void => undefined,
  windows: [] as object[],
  onCreateHonoApp: (): Promise<void> | void => undefined,
  createHonoApp: vi.fn(),
  injectWebSocket: vi.fn((_server: NodeJS.EventEmitter) => undefined),
  dialog: vi.fn((_options: { message: string; detail: string }) => 2),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  userData: "",
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getVersion: () => "0.0.0-test",
    getPath: () => h.userData,
    getAppPath: () => h.userData,
    getName: () => "MCPJam Inspector",
    commandLine: { appendSwitch: vi.fn() },
    isDefaultProtocolClient: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    setAppUserModelId: vi.fn(),
    requestSingleInstanceLock: () => h.gotLock,
    whenReady: () => new Promise<void>((resolve) => (h.ready = resolve)),
    quit: vi.fn(),
    relaunch: vi.fn(),
  });
  class BrowserWindow extends EventEmitter {
    static getAllWindows = () => h.windows;
    webContents = Object.assign(new EventEmitter(), {
      openDevTools: vi.fn(),
      send: vi.fn(),
    });
    loadURL = vi.fn();
    constructor() {
      super();
      h.windows.push(this);
    }
  }
  const guestSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  return {
    app,
    BrowserWindow,
    dialog: { showMessageBoxSync: h.dialog },
    ipcMain: new EventEmitter(),
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    session: { fromPartition: () => guestSession },
    shell: { openPath: vi.fn(async () => ""), openExternal: vi.fn() },
  };
});
vi.mock("electron-log", () => ({
  default: { ...h.log, transports: { file: {}, console: {} } },
}));
vi.mock("./strict-sentry.js", () => ({ initDesktopSentry: vi.fn() }));
// Stubbed so an uncaught exception reaches the test instead of a logger.
vi.mock("./crash-reporting.js", () => ({
  registerMainProcessCrashHandlers: vi.fn(),
}));
vi.mock("./log-console-safety.js", () => ({
  retireConsoleOnStreamError: vi.fn(),
}));
vi.mock("./sentry-installation.js", () => ({
  loadSentryInstallationId: () => "installation:test",
}));
vi.mock("../shared/desktop-sentry-state.js", () => ({
  initializeDesktopSentryIdentity: () => ({ id: "installation:test" }),
}));
vi.mock("./sentry-identity-electron.js", () => ({
  installDesktopSentryIdentity: () => ({ bind: vi.fn() }),
}));
vi.mock("./desktop-diagnostics-electron.js", () => ({
  installDesktopDiagnostics: () => ({ bind: vi.fn() }),
}));
vi.mock("./ipc/update/update-shutdown.js", () => ({
  recordUpdateShutdown: vi.fn(),
}));
vi.mock("./ipc/update/update-listeners.js", () => ({
  installUpdateOnQuit: () => false,
  setTrustedUpdateWindow: vi.fn(),
  setupAutoUpdaterEvents: vi.fn(),
  startUpdatePolling: vi.fn(),
}));
vi.mock("./ipc/listeners-register.js", () => ({ registerListeners: vi.fn() }));
vi.mock("./ipc/local-harness/local-harness-listeners.js", () => ({
  createSafeStorageKeyStore: vi.fn(),
}));
vi.mock("./ipc/agent-browser/agent-browser-listeners.js", () => ({
  setAgentBrowserRendererOrigin: vi.fn(),
}));
vi.mock("../server/services/browserd/local/security-policy.js", () => ({
  registerBrowserController: vi.fn(),
}));
vi.mock("../server/services/inspector-runtime", () => ({
  writeInspectorRuntime: () => () => undefined,
}));
vi.mock("../server/utils/harness/local/instance-key.js", () => ({
  setInstanceKeyStore: vi.fn(),
}));
vi.mock("../server/services/session-token.js", () => ({
  getSessionToken: () => "session-token",
}));
vi.mock("../server/app.js", () => ({ createHonoApp: h.createHonoApp }));

let port = 0;
let holder: net.Server | undefined;
let env: NodeJS.ProcessEnv;
const uncaught = vi.fn();

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port: free } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return free;
}

/** Another process taking the port, as far as the app can tell. */
async function holdPort(): Promise<void> {
  const server = net.createServer().listen(port, "127.0.0.1");
  await once(server, "listening");
  holder = server;
}

async function launch() {
  await import("./main");
  const { app } = await import("electron");
  h.ready();
  return app;
}

const bootstrapped = () =>
  vi.waitFor(() =>
    expect(h.log.info).toHaveBeenCalledWith("MCPJam Electron app ready"),
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

beforeEach(async () => {
  env = { ...process.env };
  vi.resetModules();
  vi.clearAllMocks();
  port = await freePort();
  process.env.SERVER_PORT = String(port);
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "plb336-"));
  h.gotLock = true;
  h.windows.length = 0;
  h.onCreateHonoApp = () => undefined;
  h.createHonoApp.mockImplementation(async () => {
    await h.onCreateHonoApp();
    return {
      app: { fetch: () => new Response("ok") },
      injectWebSocket: h.injectWebSocket,
    };
  });
  process.on("uncaughtException", uncaught);
});

afterEach(async () => {
  process.off("uncaughtException", uncaught);
  // The electron mock outlives `vi.resetModules()`: without this, the last
  // test's `main.ts` would answer this test's events too.
  const { app, ipcMain } = await import("electron");
  app.emit("before-quit", { preventDefault: vi.fn() });
  app.removeAllListeners();
  ipcMain.removeAllListeners();
  await new Promise((resolve) => (holder ? holder.close(resolve) : resolve(0)));
  holder = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  Object.assign(process.env, env);
  fs.rmSync(h.userData, { recursive: true, force: true });
});

it("shows the startup dialog when the port is taken between probe and bind", async () => {
  h.onCreateHonoApp = holdPort;
  await launch();

  await vi.waitFor(() => expect(h.dialog).toHaveBeenCalledTimes(1));
  expect(h.dialog.mock.calls[0][0]).toMatchObject({
    message: "Couldn't start the internal server.",
    detail: expect.stringContaining(
      `EADDRINUSE: address already in use 127.0.0.1:${port}`,
    ),
  });
  expect(uncaught).not.toHaveBeenCalled();
});

it("starts one server when macOS emits activate during launch", async () => {
  // Mid-bootstrap: after the server modules loaded, before any window exists.
  h.onCreateHonoApp = async () => {
    h.onCreateHonoApp = () => undefined;
    const { app } = await import("electron");
    app.emit("activate");
  };
  await launch();

  await bootstrapped();
  await settle();
  expect(h.createHonoApp).toHaveBeenCalledTimes(1);
  expect(h.windows).toHaveLength(1);
  expect(uncaught).not.toHaveBeenCalled();
});

it("does not start a server in an instance that lost the single-instance lock", async () => {
  h.gotLock = false;
  await launch();

  await settle();
  // Written synchronously by the bootstrap's first step, so its absence does
  // not depend on how long the rest of the bootstrap would take.
  expect(fs.existsSync(path.join(h.userData, ".last-launched-version"))).toBe(
    false,
  );
  expect(h.createHonoApp).not.toHaveBeenCalled();
  expect(h.windows).toHaveLength(0);
});

it("logs a server error after the bind instead of crashing", async () => {
  await launch();
  await bootstrapped();
  const [server] = h.injectWebSocket.mock.calls[0];
  const error = Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });

  expect(() => server.emit("error", error)).not.toThrow();
  expect(h.log.error).toHaveBeenCalledWith("Hono server error:", error);
});

it("handles a port held by another process when the dock reopens the window", async () => {
  const app = await launch();
  await bootstrapped();
  h.windows.length = 0;
  app.emit("window-all-closed");
  await vi.waitFor(holdPort);

  app.emit("activate");

  await vi.waitFor(() => expect(h.dialog).toHaveBeenCalledTimes(1));
  expect(h.dialog.mock.calls[0][0]).toMatchObject({
    message: "Couldn't start the internal server.",
  });
  expect(h.windows).toHaveLength(0);
  expect(uncaught).not.toHaveBeenCalled();
});
