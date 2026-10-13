import { expect, it, vi } from "vitest";
import {
  beginUpdateShutdown,
  recordUpdateShutdown,
  updateShutdownSnapshot,
} from "../../src/ipc/update/update-shutdown.js";
it("captures the first safe shutdown stage timing without changing shutdown", () => {
  vi.useFakeTimers();
  beginUpdateShutdown();
  vi.advanceTimersByTime(5);
  recordUpdateShutdown("before_quit");
  vi.advanceTimersByTime(10);
  recordUpdateShutdown("browser_cleanup_started");
  vi.advanceTimersByTime(100);
  recordUpdateShutdown("window_close_blocked");
  recordUpdateShutdown("before_quit");
  expect(updateShutdownSnapshot()).toEqual({
    native_install_requested: 0,
    before_quit: 5,
    browser_cleanup_started: 15,
    window_close_blocked: 115,
  });
  recordUpdateShutdown("browser_cleanup_finished");
  recordUpdateShutdown("will_quit");
  expect(updateShutdownSnapshot()).toMatchObject({
    browser_cleanup_finished: 115,
    will_quit: 115,
  });
  beginUpdateShutdown();
  expect(updateShutdownSnapshot()).toEqual({ native_install_requested: 0 });
  vi.useRealTimers();
});
