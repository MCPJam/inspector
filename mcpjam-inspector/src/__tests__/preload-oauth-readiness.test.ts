import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { send, expose } = vi.hoisted(() => ({ send: vi.fn(), expose: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { send, on: vi.fn(), removeAllListeners: vi.fn() },
}));
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
  await import("../preload");
});
afterEach(() => vi.unstubAllGlobals());
describe("OAuth listener readiness", () => {
  it("stays ready when an unload attempt is canceled", () => {
    const oauth = expose.mock.calls.find(([name]) => name === "electronAPI")![1]
      .oauth;
    oauth.onCallback(vi.fn());
    window.addEventListener("beforeunload", (event) => event.preventDefault());
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(false);
    expect(send.mock.calls).toEqual([["oauth:listener-ready", true]]);
  });
  it("clears readiness when the document actually leaves", () => {
    window.dispatchEvent(new Event("pagehide"));
    expect(send).toHaveBeenCalledWith("oauth:listener-ready", false);
  });
});
