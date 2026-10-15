import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { HostListItem } from "@/hooks/useClients";
import {
  LIST_CATCH_UP_MS,
  useMissingLeadFallback,
} from "../use-missing-lead-fallback";

const host = (hostId: string, name: string): HostListItem => ({
  hostId,
  name,
  hostConfigId: `c-${hostId}`,
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 0,
  createdAt: 1,
  updatedAt: 1,
});
const MCPJAM = host("h-mcpjam", "MCPJam");
const CLAUDE = host("h-claude", "Claude");

type Props = { hosts: HostListItem[]; previewedHostId: string | null };

function renderFallback(initial: Props) {
  const setPreviewedHostId = vi.fn();
  const resolveFallbackHostId = (hosts: HostListItem[]) =>
    hosts.find((h) => h.name === "MCPJam")?.hostId ?? hosts[0]?.hostId ?? null;
  const view = renderHook(
    (props: Props) =>
      useMissingLeadFallback({
        enabled: true,
        projectId: "p1",
        setPreviewedHostId,
        resolveFallbackHostId,
        ...props,
      }),
    { initialProps: initial },
  );
  return { ...view, setPreviewedHostId };
}

describe("useMissingLeadFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces a lead that is missing when the list loads", () => {
    const { setPreviewedHostId } = renderFallback({
      hosts: [MCPJAM],
      previewedHostId: "h-stale",
    });
    expect(setPreviewedHostId).toHaveBeenCalledWith("h-mcpjam");
  });

  it("waits for a lead another tab wrote until this list has it", () => {
    const { rerender, setPreviewedHostId } = renderFallback({
      hosts: [MCPJAM],
      previewedHostId: "h-mcpjam",
    });
    rerender({ hosts: [MCPJAM], previewedHostId: "h-claude" });
    // A list update that still lacks the new client keeps the wait.
    rerender({ hosts: [{ ...MCPJAM }], previewedHostId: "h-claude" });
    rerender({ hosts: [MCPJAM, CLAUDE], previewedHostId: "h-claude" });
    act(() => {
      vi.advanceTimersByTime(LIST_CATCH_UP_MS);
    });
    expect(setPreviewedHostId).not.toHaveBeenCalled();
  });

  it("replaces such a lead once the wait runs out", () => {
    const { rerender, setPreviewedHostId } = renderFallback({
      hosts: [MCPJAM],
      previewedHostId: "h-mcpjam",
    });
    rerender({ hosts: [MCPJAM], previewedHostId: "h-gone" });
    act(() => {
      vi.advanceTimersByTime(LIST_CATCH_UP_MS - 1);
    });
    expect(setPreviewedHostId).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(setPreviewedHostId).toHaveBeenCalledWith("h-mcpjam");
  });

  it("replaces a lead at once when its client leaves the list", () => {
    const { rerender, setPreviewedHostId } = renderFallback({
      hosts: [MCPJAM, CLAUDE],
      previewedHostId: "h-claude",
    });
    rerender({ hosts: [MCPJAM], previewedHostId: "h-claude" });
    expect(setPreviewedHostId).toHaveBeenCalledWith("h-mcpjam");
  });
});
