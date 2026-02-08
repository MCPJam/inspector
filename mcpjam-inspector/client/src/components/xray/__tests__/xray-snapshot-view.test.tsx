import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import type { UIMessage } from "ai";

const { mockGetXRayPayload } = vi.hoisted(() => ({
  mockGetXRayPayload: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-xray-api", () => ({
  getXRayPayload: mockGetXRayPayload,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("lucide-react", () => {
  const s = (props: any) => <div {...props} />;
  return {
    Copy: s,
    X: s,
    RefreshCw: s,
    AlertCircle: s,
    ScanSearch: s,
  };
});

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: any) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { XRaySnapshotView } from "../xray-snapshot-view";

const PAYLOAD_RESPONSE = {
  system: "You are helpful",
  tools: {},
  messages: [{ role: "user", content: "hello" }],
};

function makeMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("XRaySnapshotView debounced fetching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetXRayPayload.mockResolvedValue(PAYLOAD_RESPONSE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fetch immediately — waits for debounce", () => {
    render(
      <XRaySnapshotView
        systemPrompt="test"
        messages={[makeMessage("1", "hi")]}
        selectedServers={["s1"]}
      />,
    );

    expect(mockGetXRayPayload).not.toHaveBeenCalled();
  });

  it("fetches once after debounce period", async () => {
    render(
      <XRaySnapshotView
        systemPrompt="test"
        messages={[makeMessage("1", "hi")]}
        selectedServers={["s1"]}
      />,
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetXRayPayload).toHaveBeenCalledTimes(1);
  });

  it("resets debounce on rapid message changes — only fetches once", async () => {
    const { rerender } = render(
      <XRaySnapshotView
        systemPrompt="test"
        messages={[makeMessage("1", "h")]}
        selectedServers={["s1"]}
      />,
    );

    // Simulate streaming: rapid message updates every 100ms
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      rerender(
        <XRaySnapshotView
          systemPrompt="test"
          messages={[makeMessage("1", "hello".slice(0, i + 2))]}
          selectedServers={["s1"]}
        />,
      );
    }

    // Still within debounce window — no fetch yet
    expect(mockGetXRayPayload).not.toHaveBeenCalled();

    // Let the debounce expire
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetXRayPayload).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when messages is empty", async () => {
    render(
      <XRaySnapshotView
        systemPrompt="test"
        messages={[]}
        selectedServers={["s1"]}
      />,
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockGetXRayPayload).not.toHaveBeenCalled();
  });

  it("cancels pending fetch on unmount", async () => {
    const { unmount } = render(
      <XRaySnapshotView
        systemPrompt="test"
        messages={[makeMessage("1", "hi")]}
        selectedServers={["s1"]}
      />,
    );

    // Unmount before debounce fires
    unmount();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockGetXRayPayload).not.toHaveBeenCalled();
  });
});
