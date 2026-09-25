import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopErrorCategory,
  observeDesktopOperation,
  recordDesktopActivity,
  startDesktopOperation,
} from "../desktop-diagnostics";
afterEach(() => {
  delete window.electronAPI;
});
describe("desktop activity", () => {
  it("preserves results and captures HTTP failures without payloads", async () => {
    const record = vi.fn();
    window.electronAPI = { diagnostics: { record } } as any;
    const payload = { success: false, error: "secret url" };
    expect(
      await observeDesktopOperation("connect", async (status) => {
        status(403);
        return payload;
      }),
    ).toBe(payload);
    expect(record.mock.calls[1][0]).toMatchObject({
      phase: "failure",
      status: 403,
      error: "access_denied",
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("secret");
    expect(record.mock.calls[0][0].operationId).toBe(
      record.mock.calls[1][0].operationId,
    );
  });
  it("rethrows original errors and reports structured status", async () => {
    const record = vi.fn();
    window.electronAPI = { diagnostics: { record } } as any;
    const error = Object.assign(new Error("secret"), { status: 404 });
    await expect(
      observeDesktopOperation("token_import", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(record.mock.calls[1][0]).toMatchObject({
      error: "not_found",
      status: 404,
    });
  });
  it("does not affect browser or disconnected IPC work", async () => {
    expect(() =>
      recordDesktopActivity({ kind: "auth", phase: "state" }),
    ).not.toThrow();
    window.electronAPI = {
      diagnostics: {
        record: () => {
          throw Error();
        },
      },
    } as any;
    expect(
      await observeDesktopOperation("connect", async () => ({ success: true })),
    ).toEqual({ success: true });
  });
  it("deduplicates operation completion", () => {
    const record = vi.fn();
    window.electronAPI = { diagnostics: { record } } as any;
    const finish = startDesktopOperation("oauth_callback");
    finish(true);
    finish(false);
    expect(record).toHaveBeenCalledTimes(2);
  });
  it("does not call arbitrary TypeErrors network failures", () => {
    expect(desktopErrorCategory(new TypeError("broken code"))).toBe("other");
    expect(desktopErrorCategory(new TypeError("Failed to fetch"))).toBe(
      "network",
    );
    expect(
      desktopErrorCategory(
        new Error(
          "Connection attempt timed out after 20 seconds. The server may not exist",
        ),
      ),
    ).toBe("timeout");
  });
  it("does not treat a malformed connection response as recovery", async () => {
    const record = vi.fn();
    window.electronAPI = { diagnostics: { record } } as any;
    expect(await observeDesktopOperation("connect", async () => ({}))).toEqual(
      {},
    );
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failure" }),
    );
  });
});
