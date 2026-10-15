/**
 * Playground Environments section.
 *
 * Covers the parts that are UI decisions rather than state decisions (the
 * override tri-state itself lives in `use-playground-environment.test.tsx`):
 * the modified/reset affordances and the skill-delivery honesty notice.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFlagValue, mockTrack } = vi.hoisted(() => ({
  mockFlagValue: { value: true as boolean | undefined },
  mockTrack: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));
vi.mock("@/lib/analytics", () => ({ track: mockTrack }));
// The plugin selector reads the selected row's pins straight from Convex so it
// can report a pinned version the preview could not resolve.
vi.mock("@/hooks/usePluginImportApi", () => ({
  usePluginRuntimePreview: () => undefined,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironment: () => ({
    environmentId: "env_1",
    pluginVersionIds: [],
  }),
  useProjectEnvironments: () => [
    {
      environmentId: "env_1",
      projectId: "proj_1",
      name: "Staging",
      hostId: "host_1",
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { environments: "/environments", playground: "/playground" },
}));

import { PlaygroundEnvironmentSection } from "../PlaygroundEnvironmentSection";
import type { PlaygroundEnvironmentState } from "@/hooks/use-playground-environment";

function environmentState(
  overrides: Partial<PlaygroundEnvironmentState> = {},
): PlaygroundEnvironmentState {
  const preview = {
    specVersion: 1,
    environment: { environmentId: "env_1", name: "Staging", revision: 3 },
    host: {
      hostId: "host_1",
      hostName: "Codex",
      hostConfigId: "cfg_1",
      modelId: null,
      hostStyle: null,
      harness: "codex",
    },
    servers: [
      { serverId: "srv_a", name: "Alpha", source: "host_or_group" as const },
      { serverId: "srv_plugin", name: "Docs", source: "plugin" as const },
    ],
    skills: [],
    plugins: [],
    capabilities: {
      requireToolApproval: null,
      respectToolVisibility: null,
      progressiveToolDiscovery: null,
      builtInToolIds: [],
      hasComputer: false,
      serverCount: 2,
      skillCount: 4,
      skillDelivery: "harness" as const,
      pluginCount: 1,
      serversOverridden: false,
    },
  };
  return {
    isEnvironmentMode: true,
    environmentId: "env_1",
    preview,
    isPreviewLoading: false,
    previewError: null,
    isResolutionPending: false,
    refreshPreview: vi.fn(),
    serverOverrideIds: null,
    hasExplicitOverride: false,
    servers: preview.servers.map((s) => ({ ...s, enabled: true })),
    executionTarget: { kind: "environment", environmentId: "env_1" },
    environmentOverrides: undefined,
    selectEnvironment: vi.fn(),
    clearEnvironment: vi.fn(),
    resetServersToEnvironment: vi.fn(),
    setServerEnabled: vi.fn(),
    pluginVersionOverrideIds: null,
    hasExplicitPluginOverride: false,
    plugins: [],
    resetPluginsToEnvironment: vi.fn(),
    setPluginVersionEnabled: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFlagValue.value = true;
});

describe("PlaygroundEnvironmentSection", () => {
  it("disables every control while a turn is in flight", () => {
    // Switching environments forks the chat scope and exits comparison mode.
    // Mid-turn that strands the in-flight request: its results vanish and the
    // Stop control goes with them. PlaygroundMain passes
    // `isStreamingActive || isPreparingServerForSend` here.
    render(
      <PlaygroundEnvironmentSection
        projectId="p1"
        environment={environmentState()}
        disabled
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("renders no summary line and no server chips — the composer menu and Tools rail own those", () => {
    render(
      <PlaygroundEnvironmentSection
        projectId="proj_1"
        environment={environmentState()}
      />,
    );
    // The picker still names the selected environment; the header no longer
    // repeats the resolved bundle (rev/host/counts) or the server chips —
    // the composer's "+" menu holds the server rows + per-turn toggles
    // (including Modified/reset) and the Tools rail lists the tools.
    expect(screen.queryByText("Environment: Staging")).toBeNull();
    expect(screen.queryByText("rev 3")).toBeNull();
    expect(screen.queryByTestId("playground-environment-host")).toBeNull();
    expect(screen.queryByTestId("playground-environment-counts")).toBeNull();
    expect(screen.queryByTestId("playground-environment-servers")).toBeNull();
    expect(
      screen.queryByTestId("playground-environment-server-srv_plugin"),
    ).toBeNull();
    expect(
      screen.queryByTestId("playground-environment-modified-badge"),
    ).toBeNull();
    expect(screen.queryByTestId("playground-environment-reset")).toBeNull();
  });

  it("says out loud when the client cannot consume this environment's skills", () => {
    // The count is real but the harness has no skill channel, so the skills
    // would NOT reach the model. Showing "4 skills" alone would be a lie of
    // omission.
    const state = environmentState();
    render(
      <PlaygroundEnvironmentSection
        projectId="proj_1"
        environment={environmentState({
          preview: {
            ...state.preview!,
            capabilities: {
              ...state.preview!.capabilities,
              skillDelivery: "unsupported",
            },
          },
        })}
      />,
    );
    expect(
      screen.getByTestId("playground-environment-skill-limitation").textContent,
    ).toContain("can't consume skills");
  });

  it("does not show the limitation notice when skills are deliverable", () => {
    render(
      <PlaygroundEnvironmentSection
        projectId="proj_1"
        environment={environmentState()}
      />,
    );
    expect(
      screen.queryByTestId("playground-environment-skill-limitation"),
    ).toBeNull();
  });

  it("emits client_selected from the project_environments location", () => {
    render(
      <PlaygroundEnvironmentSection
        projectId="proj_1"
        environment={environmentState()}
      />,
    );
    expect(mockTrack).toHaveBeenCalledWith("client_selected", {
      location: "project_environments",
      client_id: "host_1",
    });
  });

  it("clearing exits environment mode through the caller", () => {
    const clearEnvironment = vi.fn();
    render(
      <PlaygroundEnvironmentSection
        projectId="proj_1"
        environment={environmentState({ clearEnvironment })}
      />,
    );
    fireEvent.click(screen.getByTestId("playground-environment-clear"));
    expect(clearEnvironment).toHaveBeenCalled();
  });
});
