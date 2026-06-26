import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ServerWithName } from "@/state/app-types";

// Stub the heavy children so we can assert which server each surface targets.
vi.mock("@/components/compat/HostCompatContent", () => ({
  HostCompatContent: ({ server }: { server: ServerWithName }) => (
    <div data-testid="detail">{server.name}</div>
  ),
}));
vi.mock("@/components/compat/HostCompatMatrix", () => ({
  HostCompatMatrix: ({ selectedServerName }: { selectedServerName?: string }) => (
    <div data-testid="matrix-highlight">{selectedServerName}</div>
  ),
}));
vi.mock("@/lib/host-compat/use-host-compat", () => ({
  useServerToolsData: () => null,
}));

import { HostCompatPage } from "../HostCompatPage";

const server = (name: string): ServerWithName =>
  ({ name, connectionStatus: "connected" }) as ServerWithName;

describe("HostCompatPage", () => {
  it("shows the empty state when no server is connected", () => {
    render(
      <HostCompatPage servers={[]} selectedServer={null} onSelectServer={vi.fn()} />,
    );
    expect(screen.getByText("No connected server")).toBeInTheDocument();
    expect(screen.queryByTestId("detail")).not.toBeInTheDocument();
  });

  it("anchors the detail to the first connected server when none is selected", () => {
    // P2 regression: a disconnected global selection must not drive the detail
    // pane to a server the matrix (connected-only) doesn't list. With no
    // connected selection, the page falls back to the first connected server,
    // and the matrix highlight matches it.
    render(
      <HostCompatPage
        servers={[server("a"), server("b")]}
        selectedServer={null}
        onSelectServer={vi.fn()}
      />,
    );
    expect(screen.getByTestId("detail")).toHaveTextContent("a");
    expect(screen.getByTestId("matrix-highlight")).toHaveTextContent("a");
  });

  it("uses the selected connected server for both detail and highlight", () => {
    render(
      <HostCompatPage
        servers={[server("a"), server("b")]}
        selectedServer={server("b")}
        onSelectServer={vi.fn()}
      />,
    );
    expect(screen.getByTestId("detail")).toHaveTextContent("b");
    expect(screen.getByTestId("matrix-highlight")).toHaveTextContent("b");
  });

  it("hides the matrix for a single connected server", () => {
    render(
      <HostCompatPage
        servers={[server("solo")]}
        selectedServer={server("solo")}
        onSelectServer={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("matrix-highlight")).not.toBeInTheDocument();
    expect(screen.getByTestId("detail")).toHaveTextContent("solo");
  });
});
