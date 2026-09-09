/**
 * The browser panel, in its new home beside chat.
 *
 * Most of what is here moved from `PlaygroundRightRail.test.tsx` when the
 * Browser stopped being the rail's third tab: which body each engine gets,
 * when the panel is offered at all, and — the one that costs real money — that
 * a pane nobody is looking at stops claiming somebody is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const engineState = {
  engine: "local" as "local" | "cloud",
  selectedEngine: "local" as "local" | "cloud",
  granted: true,
};

vi.mock("@/hooks/useComputerEngine", () => ({
  useComputerEngine: () => ({
    engine: engineState.engine,
    selectedEngine: engineState.selectedEngine,
    toggleVisible: true,
    localTerminalAvailable: true,
    consent: { granted: engineState.granted, token: "consent-token" },
  }),
}));

vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () => async () => ({
    token: "tok",
    expiresAt: Date.now() + 60_000,
  }),
}));

// Both bodies are exercised in their own suites; here they only have to say
// which one the panel mounted and whether it considers itself watched.
vi.mock("@/components/browser/LocalBrowserBody", () => ({
  LocalBrowserBody: ({ active }: { active?: boolean }) => (
    <div
      data-testid="browser-pane"
      data-engine="local"
      data-active={String(active)}
    />
  ),
}));

vi.mock("@/components/browser/HostedBrowserBody", () => ({
  HostedBrowserBody: ({ active }: { active?: boolean }) => (
    <div
      data-testid="browser-pane"
      data-engine="hosted"
      data-active={String(active)}
    />
  ),
}));

const {
  browserPanelAvailable,
  PlaygroundBrowserPanel,
} = await import("../PlaygroundBrowserPanel");
const { useBrowserWorkspaceStore, DEFAULT_BROWSER_PANEL_SIZE } = await import(
  "@/stores/browser-workspace-store"
);

function renderPanel(visible = true) {
  const onClose = vi.fn();
  const utils = render(
    <PlaygroundBrowserPanel
      projectId="proj-1"
      visible={visible}
      onClose={onClose}
    />,
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  engineState.engine = "local";
  engineState.selectedEngine = "local";
  engineState.granted = true;
  useBrowserWorkspaceStore.setState({
    open: true,
    size: DEFAULT_BROWSER_PANEL_SIZE,
    expanded: false,
    collapsedRailForBrowser: false,
  });
});

describe("which body the panel mounts", () => {
  it("follows the SELECTED engine, not the resolved one", () => {
    // Somebody who picked "This machine" but has not authorized it yet must
    // see the local body's pointer, not a cloud browser they did not ask for.
    engineState.selectedEngine = "local";
    engineState.engine = "cloud";
    engineState.granted = false;
    renderPanel();
    expect(screen.getByTestId("browser-pane").dataset.engine).toBe("local");
  });

  it("swaps the body when the engine changes", () => {
    const { rerender } = renderPanel();
    expect(screen.getByTestId("browser-pane").dataset.engine).toBe("local");

    engineState.selectedEngine = "cloud";
    engineState.engine = "cloud";
    rerender(
      <PlaygroundBrowserPanel
        projectId="proj-1"
        visible
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("browser-pane").dataset.engine).toBe("hosted");
  });
});

describe("claiming that somebody is watching", () => {
  it("stops when the panel is off screen", () => {
    // On the hosted engine that claim keeps a METERED box awake, and the
    // person pays for a picture nobody has on screen.
    renderPanel(false);
    expect(screen.getByTestId("browser-pane").dataset.active).toBe("false");
  });

  it("keeps the body MOUNTED while hidden", () => {
    // Dropping the socket would stop the screencast and lose whatever the
    // agent was mid-way through.
    renderPanel(false);
    expect(screen.getByTestId("browser-pane")).toBeInTheDocument();
  });
});

describe("expand and close", () => {
  it("toggles expanded, and says which state it is in", () => {
    renderPanel();
    const button = screen.getByTestId("browser-expand");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(useBrowserWorkspaceStore.getState().expanded).toBe(true);
    expect(screen.getByTestId("browser-expand")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("un-expands a panel that has gone off screen", () => {
    // Left set, it would take over the window the next time the panel opened,
    // with the control to undo it in the corner of a panel nobody expected.
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByTestId("browser-expand"));
    expect(useBrowserWorkspaceStore.getState().expanded).toBe(true);

    rerender(
      <PlaygroundBrowserPanel
        projectId="proj-1"
        visible={false}
        onClose={() => {}}
      />,
    );
    expect(useBrowserWorkspaceStore.getState().expanded).toBe(false);
  });

  it("hands the close back to the workspace", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByTestId("browser-panel-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("browserPanelAvailable", () => {
  it("needs the host to carry the browser built-in", () => {
    // A panel offering a browser the model cannot use would be a promise the
    // host config does not keep.
    expect(
      browserPanelAvailable({
        hostHasBrowser: false,
        selectedEngine: "local",
        isAuthenticated: true,
        localBrowserRunning: false,
      }),
    ).toBe(false);
  });

  it("offers one anyway when this machine simply has a browser running", () => {
    // An outside agent can open one through `mcpjam browser open`, and hiding
    // the panel would mean the browser somebody is driving is visible in no
    // window in this app.
    expect(
      browserPanelAvailable({
        hostHasBrowser: false,
        selectedEngine: "local",
        isAuthenticated: false,
        localBrowserRunning: true,
      }),
    ).toBe(true);
  });

  it("withholds the hosted browser until there is a user to mint for", () => {
    // Every hosted call carries a minted browser token; before auth is ready
    // it can only fail, into a state with nothing to retry it.
    expect(
      browserPanelAvailable({
        hostHasBrowser: true,
        selectedEngine: "cloud",
        isAuthenticated: false,
        localBrowserRunning: false,
      }),
    ).toBe(false);
    expect(
      browserPanelAvailable({
        hostHasBrowser: true,
        selectedEngine: "cloud",
        isAuthenticated: true,
        localBrowserRunning: false,
      }),
    ).toBe(true);
  });

  it("needs no signed-in user for the local engine", () => {
    expect(
      browserPanelAvailable({
        hostHasBrowser: true,
        selectedEngine: "local",
        isAuthenticated: false,
        localBrowserRunning: false,
      }),
    ).toBe(true);
  });
});
