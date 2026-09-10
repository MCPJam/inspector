/**
 * The browser shell: tabs, the address, the history buttons, the start page.
 *
 * What is pinned here is what a person can DO with the chrome — the two rows'
 * contract with the rest of the pane. The picture itself is
 * `BrowserPaneSurface`'s and is not repeated.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BrowserShell } from "../BrowserShell";
import {
  EMPTY_BROWSER_SESSION_STATE,
  type BrowserSessionState,
  type BrowserTabState,
} from "../../../../../shared/browser-session-state";
import type { BrowserPaneCommand } from "../../../../../shared/browser-pane-command";

function tab(
  id: string,
  patch: Partial<BrowserTabState> = {},
): BrowserTabState {
  return {
    id,
    url: `https://${id}.example/page`,
    title: id.toUpperCase(),
    loading: false,
    ...patch,
  };
}

function state(patch: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    ...EMPTY_BROWSER_SESSION_STATE,
    tabs: [tab("a"), tab("b")],
    activeTabId: "a",
    // Non-zero, because this state came FROM a browser. `seq: 0` means "we
    // have not heard yet", and the shell deliberately draws the engine's
    // picture rather than a start page until it has.
    seq: 1,
    ...patch,
  };
}

function renderShell(
  patch: Partial<BrowserSessionState> = {},
  props: Partial<Parameters<typeof BrowserShell>[0]> = {},
) {
  const commands: BrowserPaneCommand[] = [];
  const utils = render(
    <BrowserShell
      state={state(patch)}
      holderId="pane-1"
      onCommand={(command) => commands.push(command)}
      {...props}
    >
      <div data-testid="page-area" />
    </BrowserShell>,
  );
  return { commands, ...utils };
}

describe("the tab strip", () => {
  it("shows every tab by title", () => {
    renderShell();
    const tabs = screen.getAllByTestId("browser-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("A");
    expect(tabs[1]).toHaveTextContent("B");
  });

  it("marks the active one", () => {
    renderShell();
    const tabs = screen.getAllByTestId("browser-tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("falls back to the host, then to New tab", () => {
    renderShell({
      tabs: [
        tab("a", { title: "" }),
        tab("b", { title: "", url: "about:blank" }),
      ],
    });
    const tabs = screen.getAllByTestId("browser-tab");
    expect(tabs[0]).toHaveTextContent("a.example");
    expect(tabs[1]).toHaveTextContent("New tab");
  });

  it("activates, closes and opens tabs", () => {
    const { commands } = renderShell();
    fireEvent.click(screen.getAllByTestId("browser-tab")[1]!);
    fireEvent.click(
      within(screen.getAllByTestId("browser-tab")[0]!).getByTestId(
        "browser-tab-close",
      ),
    );
    fireEvent.click(screen.getByTestId("browser-new-tab"));
    expect(commands).toEqual([
      { op: "activate_tab", tabId: "b" },
      { op: "close_tab", tabId: "a" },
      { op: "create_tab" },
    ]);
  });

  it("does not activate the tab it is closing", () => {
    // Or the strip spends a frame showing a tab that is on its way out.
    const { commands } = renderShell();
    fireEvent.click(
      within(screen.getAllByTestId("browser-tab")[1]!).getByTestId(
        "browser-tab-close",
      ),
    );
    expect(commands).toEqual([{ op: "close_tab", tabId: "b" }]);
  });

  it("allows closing the last tab to a fresh start page", () => {
    // With one tab the control reads as "close the browser", which it is not.
    renderShell({ tabs: [tab("a")], activeTabId: "a" });
    expect(screen.getByTestId("browser-tab-close")).toBeInTheDocument();
  });

  it("keeps the strip when there is only one tab", () => {
    // A bar that appears when you open a second tab makes the page jump under
    // the pointer at the moment somebody is aiming at something.
    renderShell({ tabs: [tab("a")], activeTabId: "a" });
    expect(screen.getByTestId("browser-tab-strip")).toBeInTheDocument();
  });
});

describe("the address field", () => {
  it("shows the host at rest and the whole url when focused", () => {
    renderShell({
      tabs: [tab("a", { url: "https://a.example/reset?token=abc" })],
      activeTabId: "a",
    });
    const field = screen.getByTestId("browser-address") as HTMLInputElement;
    expect(field.value).toBe("a.example");
    fireEvent.focus(field);
    expect(field.value).toBe("https://a.example/reset?token=abc");
  });

  it("navigates on Enter", () => {
    const { commands } = renderShell();
    const field = screen.getByTestId("browser-address");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "localhost:3000" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(commands).toEqual([
      { op: "navigate", url: "http://localhost:3000/" },
    ]);
  });

  it("restores the current address on Escape, and leaves the field", () => {
    const { commands } = renderShell();
    const field = screen.getByTestId("browser-address") as HTMLInputElement;
    // A REAL focus, so the handler's `blur()` has something to undo:
    // `fireEvent.focus` dispatches the event without moving focus, and then
    // blurring an unfocused element does nothing.
    field.focus();
    fireEvent.change(field, { target: { value: "half-typed" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(commands).toEqual([]);
    expect(field.value).toBe("a.example");
    expect(document.activeElement).not.toBe(field);
  });

  it("searches for text that is not a URL", () => {
    const { commands } = renderShell();
    const field = screen.getByTestId("browser-address");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "how do I center a div" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(commands).toEqual([
      {
        op: "navigate",
        url: "https://www.google.com/search?q=how+do+I+center+a+div",
      },
    ]);
  });

  it("keeps what somebody is typing while the agent navigates", () => {
    // The bug: an agent navigating mid-word deletes what somebody is typing.
    const { rerender } = renderShell();
    const field = screen.getByTestId("browser-address") as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "exa" } });

    rerender(
      <BrowserShell
        state={state({
          tabs: [tab("a", { url: "https://agent-went-here.test/" }), tab("b")],
        })}
        holderId="pane-1"
        onCommand={() => {}}
      >
        <div />
      </BrowserShell>,
    );
    expect(field.value).toBe("exa");
  });

  it("is empty on a blank tab rather than showing about:blank", () => {
    renderShell({
      tabs: [tab("a", { url: "about:blank", title: "" })],
      activeTabId: "a",
    });
    expect(
      (screen.getByTestId("browser-address") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("the history buttons", () => {
  it("are disabled when there is nowhere to go", () => {
    renderShell();
    expect(screen.getByTestId("browser-back")).toBeDisabled();
    expect(screen.getByTestId("browser-forward")).toBeDisabled();
    // Reload always works.
    expect(screen.getByTestId("browser-reload")).not.toBeDisabled();
  });

  it("send their commands", () => {
    const { commands } = renderShell({ canGoBack: true, canGoForward: true });
    fireEvent.click(screen.getByTestId("browser-back"));
    fireEvent.click(screen.getByTestId("browser-forward"));
    fireEvent.click(screen.getByTestId("browser-reload"));
    expect(commands).toEqual([
      { op: "back" },
      { op: "forward" },
      { op: "reload" },
    ]);
  });
});

describe("who is driving", () => {
  it("says the agent is, by default", () => {
    renderShell();
    expect(screen.getByTestId("browser-control-status")).toHaveTextContent(
      "The agent is driving",
    );
    expect(screen.queryByTestId("browser-resume-agent")).toBeNull();
  });

  it("shows control status without a manual hand-back button", () => {
    renderShell({ control: { kind: "human", holder: "pane-1" } });
    expect(screen.getByTestId("browser-control-status")).toHaveTextContent(
      "You’re in control",
    );
    expect(screen.getByTestId("browser-control-status")).toHaveAttribute(
      "title",
      expect.stringContaining("next chat message"),
    );
    expect(screen.queryByTestId("browser-resume-agent")).toBeNull();
  });

  it("names a script holder as a script", () => {
    renderShell({ control: { kind: "script", holder: "cdp" } });
    expect(screen.getByTestId("browser-control-status")).toHaveTextContent(
      "A script is driving",
    );
  });

  it("says a hold is paused when the lease parked", () => {
    renderShell({ control: { kind: "human", holder: "pane-1", parked: true } });
    expect(screen.getByTestId("browser-control-status")).toHaveTextContent(
      "You’re in control (paused)",
    );
  });
});

describe("the page area", () => {
  it("draws the start page for a blank tab, and the picture otherwise", () => {
    const { unmount } = renderShell({
      tabs: [tab("a", { url: "about:blank" })],
      activeTabId: "a",
    });
    expect(screen.getByTestId("browser-start-page")).toBeInTheDocument();
    expect(screen.queryByTestId("page-area")).toBeNull();
    unmount();

    renderShell();
    expect(screen.getByTestId("page-area")).toBeInTheDocument();
    expect(screen.queryByTestId("browser-start-page")).toBeNull();
  });

  it("shows the start page when every tab has closed", () => {
    // Closing the last tab returns here without ending the session.
    renderShell({ tabs: [], activeTabId: null });
    expect(screen.getByTestId("browser-start-page")).toBeInTheDocument();
  });

  it("draws the engine's picture, not a start page, before the browser has said anything", () => {
    // Otherwise the shell covers the page with "type an address above" for the
    // whole first poll of every session, and forever on an engine that cannot
    // report its tabs.
    renderShell({ seq: 0, tabs: [], activeTabId: null });
    expect(screen.getByTestId("page-area")).toBeInTheDocument();
    expect(screen.queryByTestId("browser-start-page")).toBeNull();
  });

  it("shows a notice over the page without covering it", () => {
    renderShell({}, { notice: "The page changed — try that again." });
    expect(screen.getByTestId("browser-notice")).toHaveTextContent(
      "try that again",
    );
    expect(screen.getByTestId("page-area")).toBeInTheDocument();
  });
});

describe("when there is no browser to drive", () => {
  it("goes inert rather than disappearing", () => {
    // A tab bar that vanishes on a reconnect is a browser that looks like it
    // crashed.
    renderShell({ canGoBack: true }, { ready: false });
    expect(screen.getByTestId("browser-tab-strip")).toBeInTheDocument();
    expect(screen.getByTestId("browser-new-tab")).toBeDisabled();
    expect(screen.getByTestId("browser-back")).toBeDisabled();
    expect(screen.getByTestId("browser-address")).toBeDisabled();
  });
});

it("waits for a ready browser before observing its page size", () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  try {
    const report = vi.fn();
    const props = {
      state: state(),
      holderId: "pane-1",
      onCommand: vi.fn(),
      onViewportMeasured: report,
    };
    const view = render(<BrowserShell {...props} ready={false} />);
    expect(observe).not.toHaveBeenCalled();
    view.rerender(<BrowserShell {...props} ready />);
    expect(observe).toHaveBeenCalledWith(
      screen.getByTestId("browser-page-area"),
    );
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
