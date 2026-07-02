import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostConfigCompareView } from "../HostConfigCompareView";

const mockHostListState = vi.hoisted(() => ({
  hosts: [] as any[],
}));

const originalMatchMedia = window.matchMedia;

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: mockHostListState.hosts, isLoading: false }),
  useHost: () => ({ host: null, isLoading: false }),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

function makeHost(hostId: string, name: string) {
  return {
    hostId,
    name,
    hostConfigId: `hc_${hostId}`,
    modelId: "claude-sonnet-4-6",
    serverCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 640px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("HostConfigCompareView public mode", () => {
  beforeEach(() => {
    mockHostListState.hosts = [];
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: originalMatchMedia,
    });
  });

  it("renders preset compare content without requiring sign-in or a project", async () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>
    );

    expect(screen.queryByText(/Sign in to compare/i)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Search host config fields")
    ).toBeInTheDocument();
    expect(screen.queryByText("Can I use…")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("host-compare-chip-preset:claude")
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i)
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the full app no-project state behind sign-in", () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView projectId={null} isAuthenticated={false} />
      </MemoryRouter>
    );

    expect(
      screen.getByText(/Sign in to compare your hosts/i)
    ).toBeInTheDocument();
  });

  it("prevents list mode and descriptions from being active together", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>
    );

    await user.click(screen.getByLabelText("Show field descriptions"));
    expect(screen.getByTestId("compare-view-list")).toBeDisabled();

    await user.click(screen.getByLabelText("Show field descriptions"));
    await user.click(screen.getByTestId("compare-view-list"));
    expect(screen.getByLabelText("Show field descriptions")).toBeDisabled();
  });

  it("defaults the full MCPJam compare page to list view on phone", () => {
    mockMobileViewport();
    mockHostListState.hosts = [makeHost("h_claude", "Claude")];

    render(
      <MemoryRouter>
        <HostConfigCompareView projectId="abc123" isAuthenticated />
      </MemoryRouter>
    );

    expect(screen.getByTestId("compare-view-list")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
