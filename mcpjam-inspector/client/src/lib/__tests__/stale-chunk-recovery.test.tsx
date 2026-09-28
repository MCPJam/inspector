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
import { toast } from "sonner";
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

  afterEach(() => {
    uninstall();
    toast.dismiss();
    cleanup();
  });

  it("offers a reload when a chunk from an older build fails to load", async () => {
    failChunkLoad();

    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("shows one prompt however many chunks fail", async () => {
    failChunkLoad();
    failChunkLoad();
    failChunkLoad();

    await screen.findByRole("button", { name: "Reload" });
    expect(screen.getAllByRole("button", { name: "Reload" })).toHaveLength(1);
  });

  it("leaves the import rejection to its caller", () => {
    // Cancelling the event would make the import resolve to undefined, and
    // the lazy component would fail later with a less useful error.
    expect(failChunkLoad().defaultPrevented).toBe(false);
  });
});
