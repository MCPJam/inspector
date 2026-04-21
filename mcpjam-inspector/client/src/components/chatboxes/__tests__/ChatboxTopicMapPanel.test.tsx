import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatboxTopicMapPanel } from "../ChatboxTopicMapPanel";
import type { UsageFilterState } from "@/hooks/chatbox-usage-filters";

const { mockUseChatboxTopicMap } = vi.hoisted(() => ({
  mockUseChatboxTopicMap: vi.fn(),
}));

vi.mock("react-force-graph-2d", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef(function MockForceGraph2D(
      props: {
        graphData?: { nodes?: Array<{ id: string }> };
        onNodeClick?: (node: { id: string }) => void;
      },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        zoomToFit: vi.fn(),
      }));
      return (
        <div data-testid="force-graph">
          {(props.graphData?.nodes ?? []).map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => props.onNodeClick?.(node)}
            >
              Graph node {node.id}
            </button>
          ))}
        </div>
      );
    }),
  };
});

vi.mock("@/hooks/useChatboxTopicMap", () => ({
  useChatboxTopicMap: (...args: unknown[]) => mockUseChatboxTopicMap(...args),
}));

const EMPTY_FILTER: UsageFilterState = {
  preset: "all",
  chips: [],
};

const SNAPSHOT = {
  version: 1,
  chatboxId: "chatbox-1",
  runId: "run-1",
  generatedAt: Date.now(),
  isSampled: false,
  stats: {
    nodeCount: 2,
    edgeCount: 1,
    clusterCount: 2,
    mappedSessionCount: 2,
    unmappedSessionCount: 1,
  },
  clusters: [
    {
      clusterId: "cluster-a",
      label: "Password resets",
      summary: "Reset and account recovery questions.",
      keywords: ["password", "reset"],
      memberCount: 12,
      colorIndex: 0,
    },
    {
      clusterId: "cluster-b",
      label: "Billing issues",
      summary: "Invoice and refund help.",
      keywords: ["billing", "refund"],
      memberCount: 8,
      colorIndex: 1,
    },
  ],
  nodes: [
    {
      sessionId: "session-a",
      x: 0.1,
      y: 0.2,
      degree: 1,
      clusterId: "cluster-a",
      clusterLabel: "Password resets",
      semanticPreview: "User needs to reset a forgotten password.",
      messageCount: 6,
      startedAt: Date.UTC(2026, 2, 20),
      lastActivityAt: Date.now() - 5 * 60 * 1000,
      modelId: "openai/gpt-4o-mini",
    },
    {
      sessionId: "session-b",
      x: -0.1,
      y: -0.2,
      degree: 1,
      clusterId: "cluster-b",
      clusterLabel: "Billing issues",
      semanticPreview: "Refund request after duplicate charge.",
      messageCount: 4,
      startedAt: Date.UTC(2026, 2, 22),
      lastActivityAt: Date.now() - 2 * 60 * 1000,
      modelId: "openai/gpt-4o-mini",
    },
  ],
  edges: [
    {
      source: "session-a",
      target: "session-b",
      score: 0.82,
    },
  ],
};

function createDefaultChatboxTopicMapHookValue() {
  return {
    latestRun: {
      _id: "run-1",
      status: "done" as const,
      startedAt: Date.now() - 10_000,
      finishedAt: Date.now() - 5_000,
      sessionCount: 2,
      clusterCount: 2,
      errorMessage: null,
      model: "openai/gpt-4o-mini",
      topicMapVersion: 1,
      edgeCount: 1,
      sampleNodeCount: 2,
      unmappedSessionCount: 1,
      isSampled: false,
      topicMapReady: true,
      isStale: false,
    },
    snapshot: SNAPSHOT,
    snapshotMetadata: {
      runId: "run-1",
      topicMapBlobUrl: "https://storage.example.com/topic-map.json",
      topicMapVersion: 1,
      edgeCount: 1,
      sampleNodeCount: 2,
      unmappedSessionCount: 1,
      isSampled: false,
      sessionCount: 2,
      clusterCount: 2,
    },
    clusters: [
      {
        _id: "cluster-row-a",
        label: "Password resets",
        summary: "Reset and account recovery questions.",
        keywords: ["password", "reset"],
        memberCount: 12,
        createdAt: Date.now(),
      },
      {
        _id: "cluster-row-b",
        label: "Billing issues",
        summary: "Invoice and refund help.",
        keywords: ["billing", "refund"],
        memberCount: 8,
        createdAt: Date.now(),
      },
    ],
    snapshotError: null,
    isLoading: false,
    metadata: null,
  };
}

beforeEach(() => {
  mockUseChatboxTopicMap.mockReset();
  mockUseChatboxTopicMap.mockReturnValue(createDefaultChatboxTopicMapHookValue());
});

describe("ChatboxTopicMapPanel", () => {
  it("renders the selected node info and semantic preview", () => {
    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />,
    );

    expect(screen.getByText("Historical Topic Map")).toBeInTheDocument();
    expect(screen.queryByText("2 mapped sessions")).not.toBeInTheDocument();
    expect(screen.getByText("session-a")).toBeInTheDocument();
    expect(screen.getByText("Password resets")).toBeInTheDocument();
    expect(
      screen.getByText("User needs to reset a forgotten password."),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 unmapped/i)).toBeInTheDocument();
  });

  it("shows rebuild status in the header while a run is active", () => {
    mockUseChatboxTopicMap.mockReturnValue({
      ...createDefaultChatboxTopicMapHookValue(),
      latestRun: {
        _id: "run-2",
        status: "running" as const,
        startedAt: Date.now(),
        finishedAt: null,
        sessionCount: null,
        clusterCount: null,
        errorMessage: null,
        model: "openai/gpt-4o-mini",
        topicMapVersion: 1,
        edgeCount: null,
        sampleNodeCount: null,
        unmappedSessionCount: null,
        isSampled: false,
        topicMapReady: false,
        isStale: false,
      },
    });

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={vi.fn()}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Updating historical topic map"),
    ).toBeInTheDocument();
  });

  it("lets operators toggle a community chip from the sidebar", async () => {
    const user = userEvent.setup();
    const onToggleChip = vi.fn();

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={EMPTY_FILTER}
        onToggleChip={onToggleChip}
        onClearChip={vi.fn()}
        onRebuild={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Communities" }));
    await user.click(
      screen.getByRole("button", { name: /Billing issues Invoice and refund help/i }),
    );

    expect(onToggleChip).toHaveBeenCalledWith({
      kind: "cluster",
      clusterId: "cluster-b",
      label: "Billing issues",
    });
  });

  it("shows active cluster filters and search matches in the filters tab", async () => {
    const user = userEvent.setup();
    const onClearChip = vi.fn();

    render(
      <ChatboxTopicMapPanel
        chatboxId="chatbox-1"
        filter={{
          preset: "all",
          chips: [{ kind: "cluster", clusterId: "cluster-a", label: "Password resets" }],
        }}
        onToggleChip={vi.fn()}
        onClearChip={onClearChip}
        onRebuild={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search nodes..." }), "refund");
    await user.click(screen.getByRole("tab", { name: "Filters" }));

    expect(screen.getByRole("button", { name: "Password resets" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Password resets" }));
    expect(onClearChip).toHaveBeenCalledWith("cluster:cluster-a");

    await waitFor(() => {
      expect(screen.getByText("Refund request after duplicate charge.")).toBeInTheDocument();
    });
  });
});
