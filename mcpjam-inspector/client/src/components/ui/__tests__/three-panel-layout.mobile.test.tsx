import { useState, type ReactNode, type CSSProperties } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreePanelLayout } from "../three-panel-layout";

const mobile = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("@/components/logger-view", () => ({
  LoggerView: () => <div>Request logs</div>,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => <div style={style}>{children}</div>,
  ResizableHandle: () => null,
}));

function EditablePane() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Parameters"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

function Workspace({ sidebarVisible = true }: { sidebarVisible?: boolean }) {
  const [selection, setSelection] = useState("");
  return (
    <ThreePanelLayout
      id="test"
      sidebar={
        <>
          <button onClick={() => setSelection("item")}>Select item</button>
          <EditablePane />
        </>
      }
      content={<div>Selected detail</div>}
      right={<textarea aria-label="Activity filter" />}
      sidebarVisible={sidebarVisible}
      rightVisible={false}
      onSidebarVisibilityChange={vi.fn()}
      onRightVisibilityChange={vi.fn()}
      mobileNavigation={{
        selectionKey: selection,
        selectionPanel: "content",
        onBack: () => setSelection(""),
      }}
    />
  );
}

describe("ThreePanelLayout mobile navigation", () => {
  beforeEach(() => {
    mobile.value = true;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    localStorage.clear();
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  it("keeps edited panes mounted while switching views and resizing", () => {
    const { rerender } = render(<Workspace />);
    const input = screen.getByRole("textbox", { name: "Parameters" });
    fireEvent.change(input, { target: { value: "preserved value" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Results" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(input).not.toBeVisible();
    expect(input).toBeInTheDocument();
    expect(screen.getByText("Selected detail")).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Logs" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.getByRole("textbox", { name: "Activity filter" }),
    ).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(input).toHaveValue("preserved value");
    mobile.value = false;
    rerender(<Workspace />);
    mobile.value = true;
    rerender(<Workspace />);
    expect(screen.getByRole("textbox", { name: "Parameters" })).toBe(input);
    expect(input).toHaveValue("preserved value");
  });

  it("opens selected center details and returns to the visible list with focus", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Select item" }));
    expect(screen.getByRole("tab", { name: "Results" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByRole("tabpanel", { name: "Results" })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select item" })).toBeVisible(),
    );
    await waitFor(() =>
      expect(screen.getByRole("tabpanel", { name: "Browse" })).toHaveFocus(),
    );
  });

  it("leaves the cursor alone across a breakpoint crossing", async () => {
    const { rerender } = render(<Workspace />);
    const input = screen.getByRole("textbox", { name: "Parameters" });
    input.focus();
    fireEvent.change(input, { target: { value: "half typed" } });
    expect(input).toHaveFocus();

    // Rotating a tablet, or dragging a window past 768px, re-runs the pane
    // effect because `isMobile` is one of its dependencies. That is a resize,
    // not a navigation: the selection has not changed, so focus must stay in
    // the field the user is typing into.
    act(() => {
      mobile.value = false;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1440,
      });
    });
    rerender(<Workspace />);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(input).toHaveFocus();

    act(() => {
      mobile.value = true;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 375,
      });
    });
    rerender(<Workspace />);
    // The pane effect focuses inside requestAnimationFrame, so the assertion
    // has to outlive one frame or it races the bug it is guarding.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(input).toHaveValue("half typed");
    expect(input).toHaveFocus();
  });

  it("allows mobile Browse and Logs despite collapsed desktop preferences", () => {
    localStorage.setItem("mcpjam-inspector-jsonrpc-panel-visible", "false");
    const changeSidebar = vi.fn();
    render(
      <ThreePanelLayout
        id="collapsed"
        sidebar={<div>List</div>}
        content={<div>Result</div>}
        sidebarVisible={false}
        onSidebarVisibilityChange={changeSidebar}
      />,
    );
    expect(screen.getByText("List")).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Logs" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("Request logs")).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(changeSidebar).not.toHaveBeenCalled();
    expect(localStorage.getItem("mcpjam-inspector-jsonrpc-panel-visible")).toBe(
      "false",
    );
  });

  it.each(["true", "false"])(
    "retains the %s desktop logger preference after a phone-first render",
    (saved) => {
      localStorage.setItem("mcpjam-inspector-jsonrpc-panel-visible", saved);
      const { rerender } = render(
        <ThreePanelLayout
          id="preference"
          sidebar={<div>List</div>}
          content={<div>Result</div>}
          sidebarVisible
          onSidebarVisibilityChange={vi.fn()}
        />,
      );
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Logs" }), {
        button: 0,
        ctrlKey: false,
      });
      act(() => {
        mobile.value = false;
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: 1440,
        });
      });
      rerender(
        <ThreePanelLayout
          id="preference"
          sidebar={<div>List</div>}
          content={<div>Result</div>}
          sidebarVisible
          onSidebarVisibilityChange={vi.fn()}
        />,
      );
      expect(
        localStorage.getItem("mcpjam-inspector-jsonrpc-panel-visible"),
      ).toBe(saved);
    },
  );

  it("uses caller labels for the WebMCP browser and activity panes", () => {
    render(
      <ThreePanelLayout
        id="webmcp"
        sidebar={<div>Tools</div>}
        content={<div>Page viewport</div>}
        right={<div>Activity events</div>}
        sidebarVisible
        onSidebarVisibilityChange={vi.fn()}
        mobileNavigation={{
          selectionKey: "",
          contentLabel: "Browser",
          rightLabel: "Activity",
        }}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browser" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("Page viewport")).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("Activity events")).toBeVisible();
  });
});
