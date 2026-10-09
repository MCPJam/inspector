import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ setUser: vi.fn(), setTag: vi.fn() }));
vi.mock("@sentry/electron/main", () => sdk);
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter() };
});
import { ipcMain } from "electron";
import { installDesktopSentryIdentity } from "../sentry-identity-electron";
import {
  initializeDesktopSentryIdentity,
  getDesktopSentryIdentity,
} from "../../shared/desktop-sentry-state";
import { SENTRY_ACTOR_CHANNEL } from "../../shared/sentry-identity";

beforeEach(() => {
  initializeDesktopSentryIdentity("installation:test-install");
  vi.clearAllMocks();
});
afterEach(() => ipcMain.removeAllListeners());
function setup(integration = installDesktopSentryIdentity()) {
  const frame = { url: "http://localhost:6274/" };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  integration.bind(window as never, frame.url);
  const sender = { sender: contents, senderFrame: frame };
  const send = (actor: unknown, override = {}) =>
    ipcMain.emit(SENTRY_ACTOR_CHANNEL, { ...sender, ...override }, actor);
  return { window, contents, frame, send, integration };
}
it("switches users, guests, and installation fallback without personal fields", () => {
  const { send } = setup();
  send({ id: "user_A", kind: "signedIn", email: "private@example.com" });
  expect(sdk.setUser).toHaveBeenLastCalledWith({ id: "user_A" });
  send({ id: "guest_A", kind: "guest" });
  expect(getDesktopSentryIdentity()).toEqual({ id: "guest_A", kind: "guest" });
  send(null);
  expect(sdk.setUser).toHaveBeenLastCalledWith({
    id: "installation:test-install",
  });
  expect(sdk.setTag).toHaveBeenLastCalledWith("actor_kind", "installation");
});
it("rejects untrusted frames, origins, and malformed or installation claims", () => {
  const { send, frame } = setup();
  const actor = { id: "user_A", kind: "signedIn" };
  send(actor, { sender: {} });
  send(actor, { senderFrame: { url: frame.url } });
  frame.url = "https://untrusted.test/";
  send(actor);
  frame.url = "http://localhost:6274/";
  for (const value of [
    { id: "email@example.com", kind: "signedIn" },
    { id: "fake", kind: "installation" },
    {},
    "bad",
  ])
    send(value);
  expect(getDesktopSentryIdentity()?.kind).toBe("installation");
});
it("resets on reload and window replacement, but keeps identity on SPA navigation", () => {
  const first = setup();
  first.send({ id: "user_A", kind: "signedIn" });
  first.contents.emit("did-start-navigation", {}, first.frame.url, true, true);
  expect(getDesktopSentryIdentity()?.id).toBe("user_A");
  first.contents.emit("did-start-navigation", {}, first.frame.url, false, true);
  expect(getDesktopSentryIdentity()?.kind).toBe("installation");
  first.send({ id: "user_A", kind: "signedIn" });
  const second = setup(first.integration);
  expect(getDesktopSentryIdentity()?.kind).toBe("installation");
  second.send({ id: "user_B", kind: "signedIn" });
  first.window.emit("closed");
  first.send({ id: "stale", kind: "signedIn" });
  expect(getDesktopSentryIdentity()?.id).toBe("user_B");
  second.window.emit("closed");
  expect(getDesktopSentryIdentity()?.kind).toBe("installation");
});
