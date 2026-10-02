import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  enabled: true,
  processors: [] as any[],
  scopeProcessor: undefined as any,
  context: {} as any,
  capture: vi.fn(),
}));
vi.mock("@sentry/electron/main", () => ({
  setContext: (_name: string, context: any) => {
    sdk.context = context;
  },
  setTag: vi.fn(),
  getClient: () => ({ getOptions: () => ({ enabled: sdk.enabled }) }),
  addEventProcessor: (fn: any) => sdk.processors.push(fn),
  withScope: (fn: any) =>
    fn({
      addEventProcessor: (processor: any) => {
        sdk.scopeProcessor = processor;
      },
    }),
  captureEvent: (event: any) =>
    sdk.capture(
      sdk.scopeProcessor({
        ...event,
        user: { email: "secret" },
        request: { url: "secret" },
        extra: { token: "secret" },
        breadcrumbs: [{ message: "secret" }],
      }),
    ),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), { getVersion: () => "1.2.3" }),
    ipcMain: new EventEmitter(),
  };
});
import { app, ipcMain } from "electron";
import { installDesktopDiagnostics } from "./desktop-diagnostics-electron";
const exit = {
  type: "Utility",
  serviceName: "proxy_resolver.mojom.ProxyResolverFactory",
  reason: "killed",
  exitCode: 9,
};
beforeEach(() => {
  vi.useFakeTimers();
  sdk.enabled = true;
  sdk.capture.mockClear();
  sdk.processors = [];
});
afterEach(() => {
  app.removeAllListeners();
  ipcMain.removeAllListeners();
  vi.useRealTimers();
});
function setup() {
  const integration = installDesktopDiagnostics();
  const frame = { url: "http://localhost:6274/" };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  integration.bind(window as any, frame.url);
  const send = (event: any, data: any) =>
    ipcMain.emit("desktop:diagnostic", event, data);
  const sender = { sender: contents, senderFrame: frame };
  return { contents, frame, sender, send };
}
it("accepts only trusted main-frame telemetry and rate-limits messages", () => {
  const { sender, send, frame } = setup();
  const data = { kind: "auth", phase: "state", auth: "signed_in" };
  send({ ...sender, sender: {} }, data);
  send({ ...sender, senderFrame: { url: frame.url } }, data);
  frame.url = "https://untrusted.test/";
  send(sender, data);
  expect(sdk.context.activity).toHaveLength(0);
  frame.url = "http://localhost:6274/";
  send(sender, data);
  expect(sdk.context.auth).toBe("signed_in");
  for (let i = 0; i < 150; i++) send(sender, { ...data, auth: "guest" });
  send(sender, data);
  expect(sdk.context.auth).toBe("guest");
});
it("reports allowlisted follow-up and correlates native context", () => {
  const { sender, send, contents } = setup();
  send(sender, { kind: "oauth_callback", phase: "start" });
  app.emit("child-process-gone", {}, exit);
  const native = {
    event_id: "native",
    platform: "native",
    contexts: {
      desktop_diagnostics: sdk.context,
      electron: { details: exit },
    },
  };
  sdk.processors[0](native);
  contents.emit("did-navigate"); // A reload is not a renderer death.
  send(sender, { kind: "connect", phase: "success" });
  vi.advanceTimersByTime(60000);
  expect(sdk.capture).toHaveBeenCalledTimes(1);
  const event = sdk.capture.mock.calls[0][0];
  expect(event.level).toBe("info");
  expect(event.contexts.desktop_diagnostics).toMatchObject({
    native_event_ids: ["native"],
    renderer_exits: 0,
    outcome: "connection_succeeded_afterward",
    main_version: "1.2.3",
  });
  expect(JSON.stringify(event)).not.toContain("secret");
});
it("preserves previous-run context and ignores disabled transport", () => {
  setup();
  sdk.enabled = false;
  const event = {
    platform: "native",
    contexts: { desktop_diagnostics: { run_id: "previous", auth: "guest" } },
  };
  expect(sdk.processors[0](event).contexts.desktop_diagnostics).toEqual({
    run_id: "previous",
    auth: "guest",
  });
  app.emit("child-process-gone", {}, exit);
  app.emit("will-quit");
  expect(sdk.capture).not.toHaveBeenCalled();
});
