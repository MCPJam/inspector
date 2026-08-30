import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hostedMode, skillsFlag, mockRouteContext, mockNavigate } = vi.hoisted(
  () => ({
    hostedMode: { value: false },
    skillsFlag: { value: true as boolean | undefined },
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
  useSkillsEnabled: () => skillsFlag.value === true,
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
  SkillsTab: ({ cloudSkillsEnabled }: { cloudSkillsEnabled?: boolean }) => (
    <div
      data-testid="skills-view"
      data-cloud-skills={String(cloudSkillsEnabled)}
    />
  ),
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

/**
 * The project store's gate must be the FLAG, in local mode too.
 *
 * It reached the tab as `!HOSTED_MODE || flag`, which is unconditionally true
 * on the desktop. That was harmless only while the Local/Cloud toggle carried
 * its own separate `computers-enabled` gate; the moment the toggle started
 * reading this prop — which is the correct flag for it — the tautology became
 * "no gate at all", offering every local user a switch to a store the backend
 * gates independently.
 */
describe("SkillsRoute — the project store's gate in local mode", () => {
  it("passes the flag through rather than a local-mode tautology", () => {
    skillsFlag.value = false;

    render(<SkillsRoute />);

    expect(screen.getByTestId("skills-view")).toHaveAttribute(
      "data-cloud-skills",
      "false"
    );
  });

  it("treats the pre-hydration window as off", () => {
    skillsFlag.value = undefined;

    render(<SkillsRoute />);

    expect(screen.getByTestId("skills-view")).toHaveAttribute(
      "data-cloud-skills",
      "false"
    );
  });

  it("turns the store on once the flag resolves true", () => {
    skillsFlag.value = true;

    render(<SkillsRoute />);

    expect(screen.getByTestId("skills-view")).toHaveAttribute(
      "data-cloud-skills",
      "true"
    );
  });
});
