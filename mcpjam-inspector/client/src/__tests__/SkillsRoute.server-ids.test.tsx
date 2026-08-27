/**
 * The "From MCP servers" section addresses a connection by `serverId`, and
 * what a valid `serverId` IS differs by mode.
 *
 * Locally the manager registers connections under the user-assigned name, so
 * the name is the id. Hosted, the same field travels to Convex
 * `authorizeBatch`, which needs the `servers` table id — a name fails argument
 * validation there and the section renders the backend's "projectId or
 * serverIds are invalid" instead of a catalog. That was the bug: the route
 * passed the name in both modes, so the section could never work hosted.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSkillsSectionServer } from "../components/skills/ServerSkillsSection";

const { hostedMode, mockRouteContext, projectServers, mockNavigate } =
  vi.hoisted(() => ({
    hostedMode: { value: true },
    mockRouteContext: {
      convexProjectId: "project-1" as string | null,
      isAuthenticated: true,
      isGuestProjectActor: false,
      appState: { servers: {} as Record<string, { connectionStatus: string }> },
    },
    projectServers: { byName: new Map<string, string>() },
    mockNavigate: vi.fn(),
  }));

vi.mock("../hooks/useSkillsEnabled", () => ({
  SKILLS_FEATURE_FLAG: "skills-enabled",
  useSkillsEnabledState: () => true,
  useSkillsEnabled: () => true,
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
  return { ...actual, useOutletContext: () => mockRouteContext };
});

vi.mock("../hooks/useViews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useViews")>();
  return {
    ...actual,
    useProjectServers: () => ({
      serversByName: projectServers.byName,
      serversById: new Map<string, string>(),
      isLoading: false,
    }),
  };
});

// Serializes the resolved list so the assertions read the exact `serverId` /
// `label` pairing the section would send.
vi.mock("../components/SkillsTab", () => ({
  SkillsTab: ({ mcpServers }: { mcpServers?: ServerSkillsSectionServer[] }) => (
    <div
      data-testid="skills-view"
      data-servers={JSON.stringify(
        (mcpServers ?? []).map((s) => [s.serverId, s.label, s.connected])
      )}
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

function resolvedServers(): Array<[string, string, boolean]> {
  return JSON.parse(
    screen.getByTestId("skills-view").getAttribute("data-servers") ?? "[]"
  );
}

beforeEach(() => {
  hostedMode.value = true;
  mockRouteContext.convexProjectId = "project-1";
  mockRouteContext.isAuthenticated = true;
  mockRouteContext.isGuestProjectActor = false;
  mockRouteContext.appState.servers = {
    staging: { connectionStatus: "connected" },
  };
  projectServers.byName = new Map([["staging", "p17abc"]]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsRoute — server ids for the MCP skills section", () => {
  it("sends the Convex server id hosted, keeping the name as the label", () => {
    render(<SkillsRoute />);
    expect(resolvedServers()).toEqual([["p17abc", "staging", true]]);
  });

  it("drops a hosted connection with no saved project server behind it", () => {
    // Also covers the window before the Convex query resolves. Sending the
    // name would produce a validation error that reads like a broken feature.
    projectServers.byName = new Map();
    render(<SkillsRoute />);
    expect(resolvedServers()).toEqual([]);
  });

  it("keeps using the name locally, where the manager keys by name", () => {
    hostedMode.value = false;
    projectServers.byName = new Map();
    render(<SkillsRoute />);
    expect(resolvedServers()).toEqual([["staging", "staging", true]]);
  });

  it("reports a disconnected server rather than omitting it", () => {
    mockRouteContext.appState.servers = {
      staging: { connectionStatus: "disconnected" },
    };
    render(<SkillsRoute />);
    expect(resolvedServers()).toEqual([["p17abc", "staging", false]]);
  });
});
