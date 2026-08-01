import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

// Controls the tri-state PostHog flag the route guard reads. `undefined`
// models the pre-hydration window; the regression is that the guard must NOT
// redirect during it (only on an explicit `false`).
let flagState: boolean | undefined = undefined;

const { mockRouteContext, mockNavigate } = vi.hoisted(() => ({
  mockRouteContext: {
    convexProjectId: "project-1" as string | null,
    isAuthenticated: true,
    isGuestProjectActor: false,
  },
  mockNavigate: vi.fn(),
}));

vi.mock("../hooks/useSkillsEnabled", () => ({
  SKILLS_FEATURE_FLAG: "skills-enabled",
  useSkillsEnabledState: () => flagState,
  useSkillsEnabled: () => flagState === true,
}));

// Skills renders the local/cloud toggle off the computers flag; irrelevant here.
vi.mock("../hooks/useComputersEnabled", () => ({
  COMPUTERS_FEATURE_FLAG: "computers-enabled",
  useComputersEnabledState: () => true,
  useComputersEnabled: () => true,
}));

// The route guard only applies the flag under HOSTED_MODE.
vi.mock("../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config")>();
  return { ...actual, HOSTED_MODE: true };
});

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

vi.mock("../components/SkillsTab", () => ({
  SkillsTab: () => <div data-testid="skills-view" />,
}));

vi.mock("../components/hosts/ConnectViewHeader", () => ({
  ConnectViewHeader: () => <div data-testid="connect-header" />,
}));

vi.mock("../hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null],
}));

vi.mock("../lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => mockNavigate };
});

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom. Mirror
// of ComputerRoute.flag-hydration.test.tsx.
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

import { SkillsRoute } from "../App";

beforeEach(() => {
  mockRouteContext.convexProjectId = "project-1";
  mockRouteContext.isAuthenticated = true;
  mockRouteContext.isGuestProjectActor = false;
});

afterEach(() => {
  flagState = undefined;
  vi.clearAllMocks();
});

describe("SkillsRoute — flag hydration + Connect chrome", () => {
  it("does not redirect while the flag is still loading (undefined)", () => {
    flagState = undefined;
    render(<SkillsRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    // Nothing renders yet either — it waits for the flag to settle.
    expect(screen.queryByTestId("skills-view")).not.toBeInTheDocument();
  });

  it("does not redirect across an undefined -> true transition", () => {
    flagState = undefined;
    const { rerender } = render(<SkillsRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();

    // PostHog resolves the flag to enabled.
    flagState = true;
    rerender(<SkillsRoute />);

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByTestId("skills-view")).toBeInTheDocument();
    expect(screen.getByTestId("connect-header")).toBeInTheDocument();
  });

  it("redirects to servers only on an explicit false", () => {
    flagState = false;
    render(<SkillsRoute />);
    const nav = screen.getByTestId("navigate");
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveAttribute("data-to", routePaths.servers);
    expect(screen.queryByTestId("skills-view")).not.toBeInTheDocument();
  });

  it("renders the bare view without Connect chrome for a guest actor", () => {
    flagState = true;
    mockRouteContext.isGuestProjectActor = true;
    render(<SkillsRoute />);
    expect(screen.getByTestId("skills-view")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-header")).not.toBeInTheDocument();
  });
});
