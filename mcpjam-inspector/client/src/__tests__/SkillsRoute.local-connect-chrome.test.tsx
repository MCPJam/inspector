import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hostedMode, skillsFlag, mockRouteContext, mockNavigate } = vi.hoisted(
  () => ({
    hostedMode: { value: false },
    skillsFlag: { value: true },
    mockRouteContext: {
      convexProjectId: "project-1" as string | null,
      isAuthenticated: true,
      isGuestProjectActor: true,
      appState: { servers: {} },
    },
    mockNavigate: vi.fn(),
  })
);

vi.mock("../hooks/useSkillsEnabled", () => ({
  SKILLS_FEATURE_FLAG: "skills-enabled",
  useSkillsEnabledState: () => skillsFlag.value,
  useSkillsEnabled: () => skillsFlag.value,
}));

vi.mock("../hooks/useComputersEnabled", () => ({
  COMPUTERS_FEATURE_FLAG: "computers-enabled",
  useComputersEnabledState: () => true,
  useComputersEnabled: () => true,
}));

vi.mock("../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedMode.value;
    },
  };
});

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="navigate" data-to={to} />
    ),
  };
});

vi.mock("../components/SkillsTab", () => ({
  SkillsTab: () => <div data-testid="skills-view" />,
}));

// SkillsRoute resolves hosted server ids through this hook. Local mode keys by
// name and never reads the map, but the hook still runs — stub it so it does
// not reach a real Convex query under jsdom.
vi.mock("../hooks/useViews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useViews")>();
  return {
    ...actual,
    useProjectServers: () => ({
      serversByName: new Map<string, string>(),
      serversById: new Map<string, string>(),
      isLoading: false,
    }),
  };
});

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

import { SkillsRoute } from "../App";

beforeEach(() => {
  hostedMode.value = false;
  skillsFlag.value = true;
  mockRouteContext.convexProjectId = "project-1";
  mockRouteContext.isAuthenticated = true;
  mockRouteContext.isGuestProjectActor = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsRoute — local Connect chrome", () => {
  it("renders the switcher for a local guest with a project", () => {
    render(<SkillsRoute />);

    expect(screen.getByTestId("connect-header")).toBeInTheDocument();
    expect(screen.getByTestId("skills-view")).toBeInTheDocument();
  });

  it("renders the switcher for a signed-out local user without a project", () => {
    mockRouteContext.convexProjectId = null;
    mockRouteContext.isAuthenticated = false;

    render(<SkillsRoute />);

    expect(screen.getByTestId("connect-header")).toBeInTheDocument();
    expect(screen.getByTestId("skills-view")).toBeInTheDocument();
  });

  it("keeps hosted guests on the bare skills view", () => {
    hostedMode.value = true;

    render(<SkillsRoute />);

    expect(screen.queryByTestId("connect-header")).not.toBeInTheDocument();
    expect(screen.getByTestId("skills-view")).toBeInTheDocument();
  });
});
