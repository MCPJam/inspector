import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  serversNeedingCancellationReconnect,
  toolCallCancellationChanged,
} from "../HostBuilderViewRedesigned";

const withCancellation = (
  toolCallCancellation?: Record<string, boolean>,
): HostConfigInputV2 =>
  ({
    ...emptyHostConfigInputV2(),
    mcpProfile: {
      profileVersion: 1,
      ...(toolCallCancellation ? { toolCallCancellation } : {}),
    },
  }) as HostConfigInputV2;

/**
 * The knob is read from the connection's config at CONNECT time, so a saved
 * change has to be pushed onto live connections or the switch reads as inert.
 * These guard the two things that keep that from becoming a reconnect storm:
 * only when the setting actually changed, and only for connected servers.
 */
describe("cancellation change detection", () => {
  it("is true when a leaf is turned off, and when one is turned back on", () => {
    expect(
      toolCallCancellationChanged(
        withCancellation(),
        withCancellation({ modern: false }),
      ),
    ).toBe(true);
    expect(
      toolCallCancellationChanged(
        withCancellation({ modern: false }),
        withCancellation(),
      ),
    ).toBe(true);
  });

  it("is true when only one era changed", () => {
    expect(
      toolCallCancellationChanged(
        withCancellation({ legacy: false }),
        withCancellation({ legacy: false, modern: false }),
      ),
    ).toBe(true);
  });

  it("is false for an unrelated save", () => {
    // Compared by value, not identity: the draft rebuilds this record on every
    // keystroke, so an identity check would reconnect on every save.
    const saved = withCancellation({ modern: false });
    const draft = {
      ...withCancellation({ modern: false }),
      modelId: "anthropic/claude-sonnet-4-6",
    } as HostConfigInputV2;
    expect(toolCallCancellationChanged(saved, draft)).toBe(false);
  });

  it("is false when the host never had the setting", () => {
    expect(
      toolCallCancellationChanged(withCancellation(), withCancellation()),
    ).toBe(false);
  });

  it("treats a first save (no saved config) as a change only when set", () => {
    expect(toolCallCancellationChanged(null, withCancellation())).toBe(false);
    expect(
      toolCallCancellationChanged(null, withCancellation({ legacy: false })),
    ).toBe(true);
  });
});

describe("which servers get reconnected", () => {
  const status = {
    live: { connectionStatus: "connected" },
    sleeping: { connectionStatus: "disconnected" },
    failing: { connectionStatus: "failed" },
  };

  it("reconnects only the connected ones", () => {
    expect(
      serversNeedingCancellationReconnect(
        ["live", "sleeping", "failing"],
        status,
      ),
    ).toEqual(["live"]);
  });

  it("covers every connected server, not just a host's serverIds list", () => {
    // Under the "all project servers attach" rule a server the host talks to
    // need not appear in `serverIds`. Filtering by that list skipped the
    // reconnect entirely, so a saved toggle kept being ignored.
    expect(
      serversNeedingCancellationReconnect(Object.keys(status), status)
    ).toEqual(["live"]);
  });

  it("ignores a server with no runtime state at all", () => {
    expect(
      serversNeedingCancellationReconnect(["never-connected"], status),
    ).toEqual([]);
  });
});
