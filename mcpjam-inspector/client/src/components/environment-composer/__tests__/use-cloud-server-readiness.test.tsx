/**
 * SUTB-5, mapping half: turning composer state into the targets the rules judge.
 *
 * Getting this wrong in either direction is worse than not checking at all — a
 * group must be judged by its members rather than the client's count, and a row
 * whose servers come from somewhere we can't see must be left to the resolver.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentComposerState } from "@/components/environment-composer/environment-stack";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const { hostsRef, serversRef, attachmentsRef } = vi.hoisted(() => ({
  hostsRef: {
    current: [] as Array<{
      hostId: string;
      name: string;
      serverCount?: number;
    }>,
  },
  serversRef: {
    current: [] as Array<{
      _id: string;
      name: string;
      command?: string;
      url?: string;
    }>,
  },
  attachmentsRef: {
    current: [] as Array<{ _id: string; name: string; serverIds: string[] }>,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: hostsRef.current, isLoading: false }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: serversRef.current, isLoading: false }),
  useProjectServerAttachments: () => ({
    serverAttachments: attachmentsRef.current,
    isLoading: false,
  }),
}));

import { useCloudServerReadiness } from "../use-cloud-server-readiness";

const STDIO = { _id: "s-stdio", name: "Fetch", command: "uvx" };
const REMOTE = {
  _id: "s-remote",
  name: "Notion",
  url: "https://mcp.notion.com/mcp",
};

function composeState(
  stack: Partial<EnvironmentComposerState["stack"]> = {},
): EnvironmentComposerState {
  return {
    environmentIds: [],
    stack: {
      hostIds: ["host-1"],
      serverAttachmentId: null,
      skillSelection: null,
      computerEnvironmentId: null,
      modelSelection: { includeClientDefaults: true, explicitModelIds: [] },
      ...stack,
    },
    customized: false,
  };
}

function environment(
  overrides: Partial<ProjectEnvironmentView> = {},
): ProjectEnvironmentView {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Staging",
    hostId: "host-1",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as ProjectEnvironmentView;
}

function assess(
  state: EnvironmentComposerState,
  environments: ProjectEnvironmentView[] = [],
) {
  return renderHook(() =>
    useCloudServerReadiness({ projectId: "proj-1", state, environments }),
  ).result.current;
}

describe("useCloudServerReadiness", () => {
  it("reads a composed client's own server set", () => {
    hostsRef.current = [{ hostId: "host-1", name: "Claude", serverCount: 0 }];
    serversRef.current = [];
    attachmentsRef.current = [];

    expect(assess(composeState())).toEqual({
      status: "no_servers",
      labels: ["Claude"],
    });
  });

  it("judges a shared server group instead of the clients under it", () => {
    // The client's own count would read as fine; the group is what runs.
    hostsRef.current = [{ hostId: "host-1", name: "Claude", serverCount: 5 }];
    serversRef.current = [STDIO, REMOTE];
    attachmentsRef.current = [
      { _id: "grp-1", name: "Local group", serverIds: [STDIO._id] },
    ];

    expect(assess(composeState({ serverAttachmentId: "grp-1" }))).toEqual({
      status: "unrunnable_servers",
      labels: ["Local group"],
      serverNames: ["Fetch"],
    });
  });

  it("names a saved environment by its own name, not its client's", () => {
    hostsRef.current = [{ hostId: "host-1", name: "Claude", serverCount: 0 }];
    serversRef.current = [];
    attachmentsRef.current = [];

    expect(
      assess(
        {
          environmentIds: ["env-1"],
          stack: composeState().stack,
          customized: false,
        },
        [environment()],
      ),
    ).toEqual({ status: "no_servers", labels: ["Staging"] });
  });

  it("leaves an environment with pinned plugins to the resolver", () => {
    hostsRef.current = [{ hostId: "host-1", name: "Claude", serverCount: 0 }];
    serversRef.current = [];
    attachmentsRef.current = [];

    expect(
      assess(
        {
          environmentIds: ["env-1"],
          stack: composeState().stack,
          customized: false,
        },
        [environment({ pluginVersionIds: ["pv-1"] })],
      ),
    ).toEqual({ status: "ok" });
  });

  it("skips a client it has no row for", () => {
    hostsRef.current = [];
    serversRef.current = [STDIO];
    attachmentsRef.current = [];

    expect(assess(composeState())).toEqual({ status: "ok" });
  });
});
