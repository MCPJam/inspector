import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// The client selector's own behavior is covered by HostCanvasSelector's own
// test file; here we only care whether ConnectViewHeader decides to mount it.
vi.mock("@/components/hosts/redesigned/HostCanvasSelector", () => ({
  HostCanvasSelector: () => <div data-testid="host-canvas-selector-stub" />,
}));

import { ConnectViewHeader } from "../ConnectViewHeader";

describe("ConnectViewHeader — client selector mount gating", () => {
  it("mounts the client selector for a real, queryable project id", () => {
    render(
      <ConnectViewHeader
        value="servers"
        previewedHostId={null}
        projectId="proj-1"
        onChange={() => {}}
      />
    );

    expect(screen.getByTestId("host-canvas-selector-stub")).toBeInTheDocument();
  });

  it("does not mount the selector for a transient local project id", () => {
    // A local/placeholder id is truthy but not yet a real Convex id —
    // `useHostList` skips querying it, which would otherwise leave the
    // selector on a permanent loading skeleton if mounted anyway.
    render(
      <ConnectViewHeader
        value="servers"
        previewedHostId={null}
        projectId="local_abc123"
        onChange={() => {}}
      />
    );

    expect(
      screen.queryByTestId("host-canvas-selector-stub")
    ).not.toBeInTheDocument();
  });

  it("does not mount the selector when there is no project", () => {
    render(
      <ConnectViewHeader
        value="servers"
        previewedHostId={null}
        projectId={null}
        onChange={() => {}}
      />
    );

    expect(
      screen.queryByTestId("host-canvas-selector-stub")
    ).not.toBeInTheDocument();
  });
});
