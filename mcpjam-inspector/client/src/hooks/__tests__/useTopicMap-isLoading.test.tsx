/**
 * isLoading must not treat a done run without a topic-map blob as "still
 * fetching" — that permanently blocks the empty/CTA branch for legacy swarm
 * rebuilds that never wrote topicMapBlobId.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTopicMap } from "@/hooks/useScenarioTopicMap";

const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const DONE_WITHOUT_BLOB = {
  latestRun: {
    _id: "run-1",
    status: "done" as const,
    startedAt: 1,
    finishedAt: 2,
    sessionCount: 10,
    clusterCount: 3,
    errorMessage: null,
    topicMapReady: false,
    isStale: false,
  },
  snapshot: {
    runId: "run-1",
    topicMapBlobUrl: null,
    topicMapVersion: 2,
    edgeCount: 0,
    sampleNodeCount: 0,
    unmappedSessionCount: 0,
    isSampled: false,
    sessionCount: 10,
    clusterCount: 3,
  },
  clusters: [],
};

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseQuery.mockImplementation((name: string) => {
    if (name === "chatSessions:getSwarmTopicMapSnapshot") {
      return DONE_WITHOUT_BLOB;
    }
    return "skip";
  });
});

describe("useTopicMap isLoading", () => {
  it("is false when snapshot metadata exists but topicMapBlobUrl is null", async () => {
    const { result } = renderHook(() =>
      useTopicMap({ scope: { kind: "swarm", projectId: "proj-1" } }),
    );

    await waitFor(() => {
      expect(result.current.metadata).toEqual(DONE_WITHOUT_BLOB);
    });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("is true while waiting for a blob fetch that has a URL", async () => {
    // Keep fetch pending so snapshotLoading stays true.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    mockUseQuery.mockImplementation((name: string) => {
      if (name === "chatSessions:getSwarmTopicMapSnapshot") {
        return {
          ...DONE_WITHOUT_BLOB,
          snapshot: {
            ...DONE_WITHOUT_BLOB.snapshot,
            topicMapBlobUrl: "https://storage.example.com/map.json",
          },
          latestRun: {
            ...DONE_WITHOUT_BLOB.latestRun,
            topicMapReady: true,
          },
        };
      }
      return "skip";
    });

    const { result } = renderHook(() =>
      useTopicMap({ scope: { kind: "swarm", projectId: "proj-1" } }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });
    vi.unstubAllGlobals();
  });
});
