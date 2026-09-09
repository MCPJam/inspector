import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_PANEL_SIZE,
  MAX_BROWSER_PANEL_SIZE,
  MIN_BROWSER_PANEL_SIZE,
  useBrowserWorkspaceStore,
} from "../browser-workspace-store";

const reset = () =>
  useBrowserWorkspaceStore.setState({
    open: false,
    size: DEFAULT_BROWSER_PANEL_SIZE,
    expanded: false,
    collapsedRailForBrowser: false,
  });

describe("browser workspace layout", () => {
  beforeEach(reset);

  it("starts closed at roughly sixty percent", () => {
    const state = useBrowserWorkspaceStore.getState();
    expect(state.open).toBe(false);
    expect(state.size).toBe(60);
  });

  it("is idempotent to open, because browsing calls it on every tool call", () => {
    const { openBrowser } = useBrowserWorkspaceStore.getState();
    openBrowser();
    const first = useBrowserWorkspaceStore.getState();
    openBrowser();
    expect(useBrowserWorkspaceStore.getState()).toBe(first);
  });

  it("puts an expanded browser away entirely when it closes", () => {
    // Expanded-but-hidden only becomes visible the confusing way: reopening it
    // later takes over the whole window with no obvious cause.
    const store = useBrowserWorkspaceStore.getState();
    store.openBrowser();
    store.setExpanded(true);
    useBrowserWorkspaceStore.getState().closeBrowser();
    expect(useBrowserWorkspaceStore.getState()).toMatchObject({
      open: false,
      expanded: false,
    });
  });

  it("clamps a size to something that is still a browser", () => {
    const { setSize } = useBrowserWorkspaceStore.getState();
    setSize(2);
    expect(useBrowserWorkspaceStore.getState().size).toBe(
      MIN_BROWSER_PANEL_SIZE,
    );
    setSize(99);
    expect(useBrowserWorkspaceStore.getState().size).toBe(
      MAX_BROWSER_PANEL_SIZE,
    );
  });

  it("rounds a fractional drag measurement", () => {
    useBrowserWorkspaceStore.getState().setSize(63.4);
    expect(useBrowserWorkspaceStore.getState().size).toBe(63);
  });

  it("returns the same state for a size that did not change", () => {
    const { setSize } = useBrowserWorkspaceStore.getState();
    setSize(55);
    const before = useBrowserWorkspaceStore.getState();
    setSize(55.2);
    expect(useBrowserWorkspaceStore.getState()).toBe(before);
  });

  it("collapses the rail for the browser exactly once", () => {
    // Doing it again on every reopen would fight a person who deliberately
    // put the rail back.
    const { noteRailCollapsed } = useBrowserWorkspaceStore.getState();
    noteRailCollapsed();
    expect(useBrowserWorkspaceStore.getState().collapsedRailForBrowser).toBe(
      true,
    );
    const after = useBrowserWorkspaceStore.getState();
    noteRailCollapsed();
    expect(useBrowserWorkspaceStore.getState()).toBe(after);
  });

  it("persists the size but never the open or expanded flags", () => {
    // Reopening on load would start a browser session nobody asked for, on a
    // metered box, before the person had said anything.
    const store = useBrowserWorkspaceStore.getState();
    store.openBrowser();
    store.setExpanded(true);
    store.setSize(72);
    const persisted = JSON.parse(
      window.localStorage.getItem("mcpjam.playground.browserWorkspace") ?? "{}",
    );
    expect(persisted.state).toMatchObject({ size: 72 });
    expect(persisted.state).not.toHaveProperty("open");
    expect(persisted.state).not.toHaveProperty("expanded");
  });
});
