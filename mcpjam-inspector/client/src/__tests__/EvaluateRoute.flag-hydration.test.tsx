import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

// Controls the tri-state PostHog flag the route guard reads. `undefined`
// models the pre-hydration window; the guard must NOT redirect during it
// (only on an explicit `false`). Mirror of ComputerRoute.flag-hydration.
let flagState: boolean | undefined = undefined;

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

vi.mock("../hooks/useEvaluateEnabled", () => ({
  EVALUATE_FEATURE_FLAG: "evaluate-enabled",
  useEvaluateEnabledState: () => flagState,
  useEvaluateEnabled: () => flagState === true,
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

afterEach(() => {
  flagState = undefined;
  vi.clearAllMocks();
});

describe("EvaluateRoute — evaluate-enabled guard", () => {
  it("does not redirect while the flag is still loading (undefined)", () => {
    flagState = undefined;
    render(<EvaluateRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("evaluate-tab")).not.toBeInTheDocument();
  });

  it("renders the redesigned tab once the flag resolves true", () => {
    flagState = undefined;
    const { rerender } = render(<EvaluateRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();

    flagState = true;
    rerender(<EvaluateRoute />);

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByTestId("evaluate-tab")).toBeInTheDocument();
  });

  it("bounces to the shipped Evaluate tab on an explicit false", () => {
    // The sidebar hides the nav item, but `/evaluate` is a plain route and
    // `ui_navigate` knows the segment — the flag has to gate the route too.
    flagState = false;
    render(<EvaluateRoute />);
    const nav = screen.getByTestId("navigate");
    expect(nav).toHaveAttribute("data-to", routePaths.evals);
    expect(screen.queryByTestId("evaluate-tab")).not.toBeInTheDocument();
  });
});
