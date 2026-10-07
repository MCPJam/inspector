import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRailBridge } from "../extension-rail-bridge";
import {
  dismissRail,
  ExtensionWorkspaceProvider,
  useExtensionStore,
} from "@/components/host-workspace/ExtensionWorkspaceProvider";

type Store = NonNullable<ReturnType<typeof useExtensionStore>>;
let store: Store | null = null;
function Probe() {
  store = useExtensionStore();
  return null;
}

interface Layout {
  visible: boolean;
  narrow: boolean;
  overlay: boolean;
}
const onCollapse = vi.fn();
function view(layout: Layout) {
  return (
    <ExtensionWorkspaceProvider>
      <Probe />
      <div data-testid="root">
        <form>
          <textarea data-chat-composer-input="" aria-label="Composer" />
        </form>
        <ExtensionRailBridge
          onReveal={() => {}}
          onAppActiveChange={() => {}}
          onCollapse={onCollapse}
          composerRoot={document.body}
          {...layout}
        />
        <div aria-label="Side panel">
          <button type="button">Logs</button>
          <button type="button">Collapse panel</button>
        </div>
      </div>
    </ExtensionWorkspaceProvider>
  );
}
function enterFullscreen() {
  const exit = vi.fn();
  act(() =>
    store!.setState({ modelFullscreen: { label: "Bits & Bolts", exit } }),
  );
  return exit;
}

afterEach(() => {
  cleanup();
  onCollapse.mockReset();
  store = null;
});

describe("ExtensionRailBridge — a model App's fullscreen stays recoverable", () => {
  it.each([
    ["narrow", true],
    ["wide", false],
  ])(
    "collapsing the rail ends the fullscreen it holds (%s)",
    (_name, narrow) => {
      const { rerender } = render(
        view({ visible: false, narrow, overlay: false }),
      );
      const exit = enterFullscreen();
      // The rail opening for the App is not a reason to leave.
      rerender(view({ visible: true, narrow, overlay: narrow }));
      expect(exit).not.toHaveBeenCalled();
      rerender(view({ visible: false, narrow, overlay: false }));
      expect(exit).toHaveBeenCalledTimes(1);
    },
  );

  it("leaving fullscreen collapses a narrow rail and leaves a wide one open", () => {
    const { rerender } = render(
      view({ visible: true, narrow: true, overlay: true }),
    );
    act(() => dismissRail(store!));
    expect(onCollapse).toHaveBeenCalledTimes(1);

    rerender(view({ visible: true, narrow: false, overlay: false }));
    act(() => dismissRail(store!));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("Escape collapses the narrow overlay, unless a menu already used it", () => {
    const { rerender } = render(
      view({ visible: true, narrow: true, overlay: true }),
    );
    // A menu or dialog that closes on this Escape marks it handled.
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    act(() => {
      document.body.dispatchEvent(handled);
    });
    expect(onCollapse).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Logs" }), {
      key: "Escape",
    });
    expect(onCollapse).toHaveBeenCalledTimes(1);

    // Without an overlay Escape belongs to whatever has focus.
    rerender(view({ visible: true, narrow: false, overlay: false }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("hands focus back to the composer when the narrow overlay collapses", () => {
    const { rerender } = render(
      view({ visible: true, narrow: true, overlay: true }),
    );
    screen.getByRole("button", { name: "Collapse panel" }).focus();
    rerender(view({ visible: false, narrow: true, overlay: false }));
    expect(screen.getByRole("textbox", { name: "Composer" })).toHaveFocus();
  });

  it("hands focus back when the control that had it went away with the App", () => {
    const { rerender } = render(
      view({ visible: true, narrow: true, overlay: true }),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(view({ visible: true, narrow: true, overlay: false }));
    expect(screen.getByRole("textbox", { name: "Composer" })).toHaveFocus();
  });

  it("keeps focus the person moved within an open rail, and never moves it in a wide window", () => {
    const { rerender } = render(
      view({ visible: true, narrow: true, overlay: true }),
    );
    const logs = screen.getByRole("button", { name: "Logs" });
    logs.focus();
    // Choosing Logs ends the overlay; the rail stays open beside the chat.
    rerender(view({ visible: true, narrow: true, overlay: false }));
    expect(logs).toHaveFocus();

    rerender(view({ visible: true, narrow: false, overlay: false }));
    const collapse = screen.getByRole("button", { name: "Collapse panel" });
    collapse.focus();
    rerender(view({ visible: false, narrow: false, overlay: false }));
    expect(collapse).toHaveFocus();
  });
});
