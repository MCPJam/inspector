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

const sessionState = {
  sessionId: "chat-1" as string | null,
};

// Which mint the panel reached for is the whole question, so the two are told
// apart by the token they return rather than by a call count.
vi.mock("@/hooks/useProjectComputer", () => ({
  useMintBrowserToken: () => async () => ({
    token: "project-tok",
    expiresAt: Date.now() + 60_000,
  }),
  useMintConversationBrowserToken: () => async () => ({
    token: "conversation-tok",
    expiresAt: Date.now() + 60_000,
  }),
}));

vi.mock("@/stores/active-chat-session-store", () => ({
  useActiveChatSessionStore: (
    select: (s: { sessionId: string | null }) => unknown,
  ) => select({ sessionId: sessionState.sessionId }),
}));

// Both bodies are exercised in their own suites; here they only have to say
// which one the panel mounted and whether it considers itself watched.
vi.mock("@/components/browser/LocalBrowserBody", () => ({
  LocalBrowserBody: ({
    active,
    sessionId,
  }: {
    active?: boolean;
    sessionId?: string;
  }) => (
    <div
      data-testid="browser-pane"
      data-engine="local"
      data-active={String(active)}
      data-session={sessionId ?? ""}
    />
  ),
}));

vi.mock("@/components/browser/HostedBrowserBody", () => ({
  HostedBrowserBody: ({
    active,
    sessionId,
    mintToken,
  }: {
    active?: boolean;
    sessionId?: string;
    mintToken?: (args: { projectId: string }) => Promise<{ token: string }>;
  }) => (
    <div
      data-testid="browser-pane"
      data-engine="hosted"
      data-active={String(active)}
      data-session={sessionId ?? ""}
      onClick={() => {
        void mintToken?.({ projectId: "proj-1" }).then((t) => {
          document
            .querySelector("[data-testid=browser-pane]")
            ?.setAttribute("data-token", t.token);
        });
      }}
    />
  ),
}));

const { browserPanelAvailable, PlaygroundBrowserPanel } = await import(
  "../PlaygroundBrowserPanel"
);
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
  sessionState.sessionId = "chat-1";
  useBrowserWorkspaceStore.setState({
    conversations: { "chat-1": { open: true, expanded: false } },
    size: DEFAULT_BROWSER_PANEL_SIZE,
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
      <PlaygroundBrowserPanel projectId="proj-1" visible onClose={() => {}} />,
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
    expect(
      useBrowserWorkspaceStore.getState().conversations["chat-1"]?.expanded,
    ).toBe(true);
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
    expect(
      useBrowserWorkspaceStore.getState().conversations["chat-1"]?.expanded,
    ).toBe(true);

    rerender(
      <PlaygroundBrowserPanel
        projectId="proj-1"
        visible={false}
        onClose={() => {}}
      />,
    );
    expect(
      useBrowserWorkspaceStore.getState().conversations["chat-1"]?.expanded,
    ).toBe(false);
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

describe("the browser a chat owns", () => {
  /**
   * The panel REPLACES the rail's Browser tab whenever the workspace flag is
   * on, so anything the tab wired and the panel does not is not a difference
   * between two surfaces — it is a capability that disappears the moment the
   * flag flips. Durable sessions and saved profiles both hang off the chat's
   * session id travelling with the browser, and the panel shipped without it:
   * turning the workspace on quietly handed you a fresh anonymous browser.
   */
  it("hands the local body the chat's session", () => {
    renderPanel();
    expect(screen.getByTestId("browser-pane")).toHaveAttribute(
      "data-session",
      "chat-1",
    );
  });

  it("hands the hosted body the chat's session", () => {
    engineState.engine = "cloud";
    engineState.selectedEngine = "cloud";
    renderPanel();
    expect(screen.getByTestId("browser-pane")).toHaveAttribute(
      "data-session",
      "chat-1",
    );
  });

  it("mints the CONVERSATION token, not the project one", async () => {
    // The identity rides on the token. A project-scoped mint returns a browser
    // with no memory of this chat, which is the same bug one layer down.
    engineState.engine = "cloud";
    engineState.selectedEngine = "cloud";
    renderPanel();
    const pane = screen.getByTestId("browser-pane");
    fireEvent.click(pane);
    await vi.waitFor(() =>
      expect(pane).toHaveAttribute("data-token", "conversation-tok"),
    );
  });

  it("waits for conversation hydration without minting a project token", () => {
    sessionState.sessionId = null;
    engineState.selectedEngine = "cloud";
    renderPanel();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading conversation",
    );
    expect(screen.queryByTestId("browser-pane")).toBeNull();
  });
});
