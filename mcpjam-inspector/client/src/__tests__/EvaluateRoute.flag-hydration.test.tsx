import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// Public Evaluate, and the redirect every legacy `/evals` URL now takes.

const { mockRouteContext } = vi.hoisted(() => ({
  mockRouteContext: {
    billingUiEnabled: false,
    activeTabBillingLocked: false,
    activeTabBillingFeature: null as string | null,
    convexProjectId: "project-1" as string | null,
    ensureServersReady: vi.fn(),
    handleContinueEvalInChat: vi.fn(),
    handleConnect: vi.fn(),
  },
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
    // Sentinel so a redirect is observable without a real router.
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="navigate" data-to={to} />
    ),
  };
});

vi.mock("../components/EvaluateTab", () => ({
  EvaluateTab: () => <div data-testid="evaluate-tab" />,
}));

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom.
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

import { EvaluateRoute } from "../App";
import { LegacyEvalRedirect } from "../components/routing/legacy-eval-redirect";

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * The route's redirect goes through `ScopedNavigate`, which carries the active
 * project into a project-owned target — so it needs a router context to read
 * the current location from. Mounting inside a `MemoryRouter` gives it one;
 * the `Navigate` marker mocked above still renders, and with no project in the
 * URL the target is the plain logical path these assertions expect.
 */
function renderRoute(element: React.ReactElement, initialPath = "/evaluate") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>{element}</MemoryRouter>
  );
}

describe("public Evaluate and legacy redirects", () => {
  it("renders Evaluate", () => {
    renderRoute(<EvaluateRoute />);
    expect(screen.getByTestId("evaluate-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
  });

  // The legacy Evals and CI Evals tabs are gone; the route table sends their
  // URLs here so bookmarks land on the same suite or run in Evaluate.
  const project = "k5700000000000000000000000a";
  it.each([
    [
      `/p/${project}/evals/suite/S/runs/R?iteration=I&case=C#trace`,
      `/p/${project}/evaluate/suite/S/runs/R?iteration=I&case=C#trace`,
    ],
    [
      `/p/${project}/evals/runs/suite/S/runs/R`,
      `/p/${project}/evaluate/suite/S/runs/R`,
    ],
    [`/p/${project}/evals`, `/p/${project}/evaluate`],
    [`/p/${project}/evals/runs`, `/p/${project}/evaluate`],
  ])("redirects %s to %s", (from, to) => {
    renderRoute(<LegacyEvalRedirect />, from);
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", to);
  });
});
