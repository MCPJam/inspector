import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Toaster } from "@mcpjam/design-system/sonner";
import { installStaleChunkRecovery } from "../stale-chunk-recovery";

const originalLocation = window.location;

// What Vite's preload helper dispatches when a content-hashed chunk from an
// older build is gone.
function failChunkLoad(): Event {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.assign(event, {
    payload: new TypeError(
      "Failed to fetch dynamically imported module: https://app.mcpjam.com/assets/highlighted-body-OFNGDK62-Bl5M65bX.js",
    ),
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeAll(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: vi.fn() },
  });
});

afterAll(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("stale chunk recovery", () => {
  let uninstall: () => void;

  beforeEach(() => {
    vi.mocked(window.location.reload).mockClear();
    uninstall = installStaleChunkRecovery();
    render(<Toaster />);
  });

  afterEach(async () => {
    uninstall();
    // Let sonner's own timers land while the Toaster is still mounted: it adds
    // a toast on a 0 ms timer and removes a closed one (the Refresh click) 200
    // ms later. Unmounting first left those timers to fire after the file's
    // environment was torn down, where React's setState throws "window is not
    // defined" and fails the run. No `toast.dismiss()`: it starts a fresh
    // removal timer of its own, and unmounting already clears the auto-close.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    cleanup();
  });

  it("offers a reload when a chunk from an older build fails to load", async () => {
    failChunkLoad();

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("shows one prompt however many chunks fail", async () => {
    failChunkLoad();
    failChunkLoad();
    failChunkLoad();

    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
  });

  it("leaves the import rejection to its caller", () => {
    // Cancelling the event would make the import resolve to undefined, and
    // the lazy component would fail later with a less useful error.
    expect(failChunkLoad().defaultPrevented).toBe(false);
  });
});
