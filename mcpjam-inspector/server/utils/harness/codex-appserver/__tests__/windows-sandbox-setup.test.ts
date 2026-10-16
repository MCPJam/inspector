import { afterEach, expect, it, vi } from "vitest";
import type { AppServerClient } from "../bridge/app-server-client.js";
import { setupWindowsSandbox } from "../bridge/windows-sandbox-setup.js";

function fixture(started = true) {
  let notify: Parameters<AppServerClient["onNotification"]>[0] | undefined;
  const request = vi
    .fn<AppServerClient["request"]>()
    .mockResolvedValue({ started });
  const client = {
    request,
    onNotification: (listener: NonNullable<typeof notify>) => {
      notify = listener;
    },
  };
  return {
    client,
    request,
    finish: (success: boolean) =>
      notify?.({
        method: "windowsSandbox/setupCompleted",
        params: {
          mode: "unelevated",
          success,
          error: success ? null : "setup refused",
        },
      }),
  };
}

afterEach(() => vi.useRealTimers());

it("waits for completed Windows setup after the start acknowledgment", async () => {
  const f = fixture();
  const setup = setupWindowsSandbox(f.client, "C:\\work space");
  expect(f.request).toHaveBeenCalledWith("windowsSandbox/setupStart", {
    mode: "unelevated",
    cwd: "C:\\work space",
  });
  f.finish(true);
  await expect(setup).resolves.toBeUndefined();
});

it("rejects an unsuccessful setup and a refused start", async () => {
  const f = fixture();
  const setup = setupWindowsSandbox(f.client, "C:\\work");
  f.finish(false);
  await expect(setup).rejects.toThrow("setup refused");
  await expect(
    setupWindowsSandbox(fixture(false).client, "C:\\work"),
  ).rejects.toThrow("did not start");
});

it("bounds a missing Windows setup completion notification", async () => {
  vi.useFakeTimers();
  const setup = setupWindowsSandbox(fixture().client, "C:\\work", 20);
  const rejected = expect(setup).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
});
