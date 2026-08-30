import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

// Controls the tri-state PostHog flag the route guard reads. `undefined` models
// the pre-hydration window; the regression this guards is that the route must
// NOT redirect during it — only on an explicit `false`. A flagged-in user who
// opens /webmcp directly would otherwise be bounced before the flag resolves.
let flagState: boolean | undefined = undefined;

vi.mock("../hooks/useWebmcpInspectorEnabled", () => ({
  WEBMCP_INSPECTOR_FEATURE_FLAG: "webmcp-inspector-enabled",
  useWebmcpInspectorEnabledState: () => flagState,
  useWebmcpInspectorEnabled: () => flagState === true,
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => ({
      convexProjectId: "project-1",
      isAuthenticated: true,
    }),
    // Sentinel so a redirect is observable without a real router.
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="navigate" data-to={to} />
    ),
  };
});

vi.mock("../components/webmcp-inspector/WebmcpInspectorTab", () => ({
  WebmcpInspectorTab: () => <div data-testid="webmcp-tab" />,
}));

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom.
// Mirror of ComputerRoute.flag-hydration.test.tsx.
vi.mock("../components/ui/json-editor/codemirror-json-editor", () => ({
  CodemirrorJsonEditor: () => null,
}));
vi.mock("@codemirror/lang-json", () => ({ json: () => ({}) }));
vi.mock("@codemirror/view", () => ({
  EditorView: class {},
  lineNumbers: () => ({}),
  highlightActiveLine: () => ({}),
  highlightSpecialChars: () => ({}),
  keymap: () => ({}),
}));
vi.mock("@codemirror/state", () => ({ EditorState: { create: vi.fn() } }));
vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  history: () => ({}),
  historyKeymap: [],
}));
vi.mock("@codemirror/language", () => ({
  bracketMatching: () => ({}),
  foldGutter: () => ({}),
  indentOnInput: () => ({}),
  syntaxHighlighting: () => ({}),
  defaultHighlightStyle: {},
}));
vi.mock("@codemirror/lint", () => ({
  linter: () => ({}),
  lintGutter: () => ({}),
}));

import { WebmcpInspectorRoute } from "../App";

afterEach(() => {
  flagState = undefined;
  vi.clearAllMocks();
});

/** `ScopedNavigate` reads the current location, so it needs a router context. */
function renderRoute(element: React.ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe("WebmcpInspectorRoute — flag hydration", () => {
  it("does not redirect while the flag is still loading (undefined)", () => {
    flagState = undefined;
    renderRoute(<WebmcpInspectorRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    // Nothing renders yet either — it waits for the flag to settle rather than
    // flashing the surface at a user who may not have it.
    expect(screen.queryByTestId("webmcp-tab")).not.toBeInTheDocument();
  });

  it("does not redirect across an undefined -> true transition", () => {
    flagState = undefined;
    const { rerender } = renderRoute(<WebmcpInspectorRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();

    flagState = true;
    rerender(
      <MemoryRouter>
        <WebmcpInspectorRoute />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByTestId("webmcp-tab")).toBeInTheDocument();
  });

  it("redirects to servers only on an explicit false", () => {
    flagState = false;
    renderRoute(<WebmcpInspectorRoute />);
    const nav = screen.getByTestId("navigate");
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveAttribute("data-to", routePaths.servers);
    expect(screen.queryByTestId("webmcp-tab")).not.toBeInTheDocument();
  });
});
