import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MCPJAM_EVENTS_EXTENSION_ID } from "@mcpjam/sdk/browser";
import type { HostListItem } from "@/hooks/useClients";
import { resolveEventsHostChoice, useEventsHost } from "../use-events-host";

function listed(overrides: Partial<HostListItem>): HostListItem {
  return {
    hostId: "host",
    name: "Client",
    hostConfigId: "config",
    modelId: "model",
    serverCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      {
        hostId: "host_work",
        name: "ChatGPT Work",
        hostStyle: "chatgpt-work",
        eventDeliveryModes: ["webhook"],
      },
      { hostId: "host_old", name: "Old client", hostStyle: "mcpjam" },
    ],
    isLoading: false,
  }),
}));

const work = {
  mcpProfile: {
    profileVersion: 1,
    extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: { webhook: true } },
  },
};

describe("useEventsHost", () => {
  it("makes hosted Playground subscriptions as the chat's client", () => {
    const { result } = renderHook(() =>
      useEventsHost({
        hosted: true,
        projectId: "project",
        activeHostId: "host_work",
        activeHost: work,
        subscribeAsActiveClient: true,
      }),
    );
    expect(result.current.hostId).toBe("host_work");
    expect(result.current.choice).toMatchObject({
      id: "host_work",
      name: "ChatGPT Work",
      modes: ["webhook"],
    });
  });

  it("keeps the hosted Events tab on MCPJam (built-in)", () => {
    const { result } = renderHook(() =>
      useEventsHost({
        hosted: true,
        projectId: "project",
        activeHostId: "host_work",
        activeHost: work,
      }),
    );
    expect(result.current.hostId).toBeNull();
    expect(result.current.choice).toMatchObject({
      id: null,
      modes: ["poll", "push", "webhook"],
    });
  });

  it("uses the active client locally either way", () => {
    for (const subscribeAsActiveClient of [false, true]) {
      const { result } = renderHook(() =>
        useEventsHost({
          hosted: false,
          projectId: "project",
          activeHostId: "host_work",
          activeHost: work,
          subscribeAsActiveClient,
        }),
      );
      expect(result.current.hostId).toBe("host_work");
    }
  });
});

describe("resolveEventsHostChoice", () => {
  it("names the vendor harness that runs a client, for its refusals", () => {
    expect(
      resolveEventsHostChoice({
        hostId: "host_codex",
        hosts: [],
        activeHostId: "host_codex",
        activeHost: { ...work, harness: "codex" },
      }),
    ).toMatchObject({ modes: [], harnessName: "Codex" });
    expect(
      resolveEventsHostChoice({
        hostId: "host_cc",
        hosts: [listed({ hostId: "host_cc", agentLoop: "claude-code" })],
      })?.harnessName,
    ).toBe("Claude Code");
  });

  it("gives a listed client with no modes from the backend none, not a style default", () => {
    expect(
      resolveEventsHostChoice({
        hostId: "host_old",
        hosts: [
          listed({
            hostId: "host_old",
            name: "Old client",
            hostStyle: "mcpjam",
          }),
        ],
      })?.modes,
    ).toEqual([]);
  });
});
