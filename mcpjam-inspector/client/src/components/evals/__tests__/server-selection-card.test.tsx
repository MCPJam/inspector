import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ServerWithName } from "@/hooks/use-app-state";
import { ServerSelectionCard } from "../ServerSelectionCard";

const createServer = (
  overrides: Partial<ServerWithName> = {}
): ServerWithName =>
  ({
    name: "alpha",
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    config: { url: "https://example.com/mcp" },
    lastConnectionTime: new Date("2024-01-01"),
    ...overrides,
  }) as ServerWithName;

describe("ServerSelectionCard status label", () => {
  it("shows the retry count on a failure that was retried", () => {
    render(
      <ServerSelectionCard
        server={createServer({ connectionStatus: "failed", retryCount: 3 })}
        selected={false}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("Failed (3)")).toBeInTheDocument();
  });

  it("shows a bare label when nothing was retried", () => {
    // This card used to render `Failed (0 retries)` unconditionally —
    // a fixed number dressed up as a diagnostic, because nothing
    // incremented the counter. The suffix is now conditional, and a
    // failure with no retries behind it shows no number.
    render(
      <ServerSelectionCard
        server={createServer({ connectionStatus: "failed", retryCount: 0 })}
        selected={false}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText(/Failed \(/)).not.toBeInTheDocument();
  });

  it("never counts retries against a connected server", () => {
    // `retryCount` survives until CONNECT_SUCCESS clears it, so a server
    // that recovered on its third attempt can be connected with a 3 still
    // on it. "Connected (3)" would read as a warning about a healthy
    // server.
    render(
      <ServerSelectionCard
        server={createServer({ connectionStatus: "connected", retryCount: 3 })}
        selected={false}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});
