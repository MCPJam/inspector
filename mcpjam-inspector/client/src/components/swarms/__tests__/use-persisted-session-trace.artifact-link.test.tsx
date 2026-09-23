import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The transcript is fetched once per TRANSCRIPT, not once per link to it.
 *
 * Artifact links expire and are re-minted with a new expiry for the same
 * object, so a session row can come back with a different `messagesBlobUrl`
 * that names the same transcript. Refetching then would reload unchanged
 * content and flash the pane's loading state; only a different transcript is
 * new content.
 */
const { mockThread, NO_SNAPSHOTS, NO_TRACES } = vi.hoisted(() => ({
  mockThread: { current: undefined as Record<string, unknown> | undefined },
  // Stable identities, as the real Convex hooks hold a reference across
  // renders: a fresh literal per render re-runs the effects keyed on them.
  NO_SNAPSHOTS: [] as unknown[],
  NO_TRACES: [] as unknown[],
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({ thread: mockThread.current }),
  useSharedChatWidgetSnapshots: () => ({ snapshots: NO_SNAPSHOTS }),
  useSharedChatTurnTraces: () => ({ traces: NO_TRACES }),
  useSessionBrowserArtifacts: () => ({ artifacts: undefined }),
}));

vi.mock("@/components/evals/trace-viewer-adapter", () => ({
  snapshotsToTraceWidgetSnapshots: (s: unknown[]) => s,
}));

import { usePersistedSessionTrace } from "../use-persisted-session-trace";

type Seen = ReturnType<typeof usePersistedSessionTrace>;
let last: Seen | null = null;

function Probe({ threadId }: { threadId: string | null }) {
  last = usePersistedSessionTrace(threadId);
  return null;
}

/** A link shaped like the backend's; the signature is opaque to the client. */
function signedLink(storageId: string, expiresAt: number) {
  const body = btoa(
    JSON.stringify({ v: 1, s: storageId, k: "json", e: expiresAt }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `https://test.convex.site/web/artifact?t=${body}.c2ln`;
}

const T0 = 1_800_000_000;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  last = null;
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [{ role: "assistant", content: [] }],
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("usePersistedSessionTrace — transcript links", () => {
  it("does not refetch when the link is re-minted or the row changes otherwise", async () => {
    mockThread.current = { messagesBlobUrl: signedLink("kg-transcript", T0) };
    const { rerender } = render(<Probe threadId="t1" />);
    await waitFor(() => expect(last?.trace).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same transcript, renewed link, new row object.
    mockThread.current = {
      messagesBlobUrl: signedLink("kg-transcript", T0 + 3600),
      messageCount: 2,
    };
    rerender(<Probe threadId="t1" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(last?.trace).not.toBeNull();

    // A different transcript is new content.
    mockThread.current = {
      messagesBlobUrl: signedLink("kg-next", T0 + 3600),
    };
    rerender(<Probe threadId="t1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("stops loading once the row arrives without a transcript", async () => {
    mockThread.current = undefined;
    const { rerender } = render(<Probe threadId="t1" />);
    expect(last?.loading).toBe(true);

    mockThread.current = { messageCount: 0 };
    rerender(<Probe threadId="t1" />);
    await waitFor(() => expect(last?.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
