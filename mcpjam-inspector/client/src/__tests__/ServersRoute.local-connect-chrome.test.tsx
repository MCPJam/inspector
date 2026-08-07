import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hostedMode, mockRouteContext, mockNavigate } = vi.hoisted(() => ({
  hostedMode: { value: false },
  mockRouteContext: {
    convexProjectId: null as string | null,
    isAuthenticated: false,
    isGuestProjectActor: false,
  },
  mockNavigate: vi.fn(),
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
  };
});

// ServersTabBody lives inside App.tsx and otherwise reaches into auth and
// server-query hooks that are irrelevant to this route-level regression.
vi.mock("../components/ServersTab", () => ({
  ServersTab: () => <div data-testid="servers-view" />,
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

import { ServersRoute } from "../App";

beforeEach(() => {
  hostedMode.value = false;
  mockRouteContext.convexProjectId = null;
  mockRouteContext.isAuthenticated = false;
  mockRouteContext.isGuestProjectActor = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ServersRoute — local Connect chrome", () => {
  it("renders the switcher for a signed-out local user", () => {
    render(<ServersRoute />);

    expect(screen.getByTestId("connect-header")).toBeInTheDocument();
    expect(screen.getByTestId("servers-view")).toBeInTheDocument();
  });

  it("renders the switcher for a guest without a project", () => {
    mockRouteContext.isAuthenticated = true;
    mockRouteContext.isGuestProjectActor = true;

    render(<ServersRoute />);

    expect(screen.getByTestId("connect-header")).toBeInTheDocument();
    expect(screen.getByTestId("servers-view")).toBeInTheDocument();
  });

  it("keeps hosted signed-out users on the bare servers view", () => {
    hostedMode.value = true;

    render(<ServersRoute />);

    expect(screen.queryByTestId("connect-header")).not.toBeInTheDocument();
    expect(screen.getByTestId("servers-view")).toBeInTheDocument();
  });
});
