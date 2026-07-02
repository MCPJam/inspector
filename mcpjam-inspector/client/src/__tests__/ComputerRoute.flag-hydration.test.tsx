import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

// Controls the tri-state PostHog flag the route guard reads. `undefined`
// models the pre-hydration window; the regression is that the guard must NOT
// redirect during it (only on an explicit `false`).
let flagState: boolean | undefined = undefined;

const { mockRouteContext, mockNavigate } = vi.hoisted(() => ({
  mockRouteContext: {
    convexProjectId: "project-1" as string | null,
    isAuthenticated: true,
  },
  mockNavigate: vi.fn(),
}));

vi.mock("../hooks/useComputersEnabled", () => ({
  COMPUTERS_FEATURE_FLAG: "computers-enabled",
  useComputersEnabledState: () => flagState,
  useComputersEnabled: () => flagState === true,
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

vi.mock("../components/computer/ComputerView", () => ({
  ComputerView: () => <div data-testid="computer-view" />,
}));

vi.mock("../components/hosts/ConnectViewHeader", () => ({
  ConnectViewHeader: () => <div data-testid="connect-header" />,
}));

vi.mock("../hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null],
}));

vi.mock("../lib/app-navigation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => mockNavigate };
});

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom. Mirror
// of ChatboxesRoute.billing.test.tsx.
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

import { ComputerRoute } from "../App";

afterEach(() => {
  flagState = undefined;
  vi.clearAllMocks();
});

describe("ComputerRoute — flag hydration", () => {
  it("does not redirect while the flag is still loading (undefined)", () => {
    flagState = undefined;
    render(<ComputerRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    // Nothing renders yet either — it waits for the flag to settle.
    expect(screen.queryByTestId("computer-view")).not.toBeInTheDocument();
  });

  it("does not redirect across an undefined -> true transition", () => {
    flagState = undefined;
    const { rerender } = render(<ComputerRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();

    // PostHog resolves the flag to enabled.
    flagState = true;
    rerender(<ComputerRoute />);

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByTestId("computer-view")).toBeInTheDocument();
  });

  it("redirects to servers only on an explicit false", () => {
    flagState = false;
    render(<ComputerRoute />);
    const nav = screen.getByTestId("navigate");
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveAttribute("data-to", routePaths.servers);
    expect(screen.queryByTestId("computer-view")).not.toBeInTheDocument();
  });
});
