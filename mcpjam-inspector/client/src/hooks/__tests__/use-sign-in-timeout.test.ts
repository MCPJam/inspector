import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "@/state/app-types";
import { SIGN_IN_TIMEOUT_MS, useSignInTimeout } from "../use-sign-in-timeout";

type Servers = Record<string, { connectionStatus: ConnectionStatus }>;

describe("useSignInTimeout", () => {
  let tokens: Map<string, number>;
  let onTimeout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    tokens = new Map([["demo", 1]]);
    onTimeout = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function render(servers: Servers) {
    return renderHook(
      ({ servers }: { servers: Servers }) =>
        useSignInTimeout({
          servers,
          getOpToken: (name) => tokens.get(name) ?? 0,
          onTimeout,
        }),
      { initialProps: { servers } },
    );
  }

  it("ends a sign-in still waiting after 10 minutes", () => {
    render({ demo: { connectionStatus: "oauth-flow" } });

    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(SIGN_IN_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("demo");
  });

  it("does not end a newer attempt with an older attempt's timer", () => {
    const { rerender } = render({ demo: { connectionStatus: "oauth-flow" } });
    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS / 2);

    // Cancel and a new attempt bump the token without the effect seeing any
    // status other than oauth-flow.
    tokens.set("demo", 3);
    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS / 2);
    expect(onTimeout).not.toHaveBeenCalled();

    rerender({ servers: { demo: { connectionStatus: "oauth-flow" } } });
    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("demo");
  });

  it("restarts the clock for a sign-in started after the first one ended", () => {
    const { rerender } = render({ demo: { connectionStatus: "oauth-flow" } });
    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS / 2);
    rerender({ servers: { demo: { connectionStatus: "disconnected" } } });
    tokens.set("demo", 2);
    rerender({ servers: { demo: { connectionStatus: "oauth-flow" } } });

    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS / 2);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS / 2);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("demo");
  });

  it.each(["connected", "disconnected", "failed"] as const)(
    "stops the clock when the sign-in ends as %s",
    (connectionStatus) => {
      const { rerender } = render({ demo: { connectionStatus: "oauth-flow" } });
      rerender({ servers: { demo: { connectionStatus } } });

      vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it("stops the clock when the server is removed or the hook unmounts", () => {
    tokens.set("other", 1);
    const { rerender, unmount } = render({
      demo: { connectionStatus: "oauth-flow" },
      other: { connectionStatus: "oauth-flow" },
    });
    rerender({ servers: { other: { connectionStatus: "oauth-flow" } } });
    unmount();

    vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
