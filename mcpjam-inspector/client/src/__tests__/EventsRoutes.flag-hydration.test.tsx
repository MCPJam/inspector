import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

const state = vi.hoisted(() => ({
  flag: undefined as boolean | undefined,
  keys: [] as string[],
}));
vi.mock("posthog-js/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("posthog-js/react")>()),
  useFeatureFlagEnabled: (key: string) => {
    state.keys.push(key);
    return state.flag;
  },
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useOutletContext: () => ({
    convexProjectId: "project-1",
    isAuthenticated: true,
    isGuestProjectActor: false,
    appState: { selectedServer: "server-1", servers: {} },
  }),
  Navigate: ({ to }: { to: string }) => (
    <div data-testid="navigate" data-to={to} />
  ),
}));
vi.mock("../components/EventsTab", () => ({
  EventsTab: () => <div data-testid="events-tab" />,
}));
vi.mock("../components/EventTriggersTab", () => ({
  EventTriggersTab: () => <div data-testid="triggers-tab" />,
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

import { EventsRoute, EventTriggersRoute } from "../App";

afterEach(() => {
  state.flag = undefined;
  state.keys = [];
});

describe.each([
  { name: "Events", Route: EventsRoute, tab: "events-tab" },
  { name: "Triggers", Route: EventTriggersRoute, tab: "triggers-tab" },
])("$name rollout", ({ Route, tab }) => {
  it("waits on direct navigation and opens when the flag resolves true", () => {
    const { rerender } = render(<MemoryRouter><Route /></MemoryRouter>);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.queryByTestId(tab)).not.toBeInTheDocument();

    state.flag = true;
    rerender(<MemoryRouter><Route /></MemoryRouter>);
    expect(screen.getByTestId(tab)).toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(new Set(state.keys)).toEqual(new Set(["mcp-events-enabled"]));
  });

  it("redirects a direct link when the flag is false", () => {
    state.flag = false;
    render(<MemoryRouter><Route /></MemoryRouter>);
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", routePaths.servers);
    expect(screen.queryByTestId(tab)).not.toBeInTheDocument();
  });

  it("closes an open workspace when the flag turns off", () => {
    state.flag = true;
    const { rerender } = render(<MemoryRouter><Route /></MemoryRouter>);
    expect(screen.getByTestId(tab)).toBeInTheDocument();
    state.flag = false;
    rerender(<MemoryRouter><Route /></MemoryRouter>);
    expect(screen.queryByTestId(tab)).not.toBeInTheDocument();
    expect(screen.getByTestId("navigate")).toBeInTheDocument();
  });
});
