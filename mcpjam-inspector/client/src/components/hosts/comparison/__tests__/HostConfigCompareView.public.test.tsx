import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
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

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
  usePostHog: () => ({ capture: () => undefined }),
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

function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
    </span>
  );
}

describe("HostConfigCompareView public mode", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockHostListState.hosts = [];
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
    expect(screen.getByText("Can I use…")).toBeInTheDocument();
    expect(
      screen.getByTestId("host-compare-chip-preset:claude")
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i)
      ).not.toBeInTheDocument();
    });
  });

  it("puts the preferred caniuse clients in the top chip row", () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>
    );

    const topChipIds = Array.from(
      document.querySelectorAll('[data-testid^="host-compare-chip-"]')
    ).map((node) => node.getAttribute("data-testid"));

    expect(topChipIds).toEqual([
      "host-compare-chip-preset:claude",
      "host-compare-chip-preset:chatgpt",
      "host-compare-chip-preset:copilot",
      "host-compare-chip-preset:cursor",
      "host-compare-chip-preset:slack",
      "host-compare-chip-preset:vscode",
    ]);
  });

  it("opens a shared public capability search from the URL", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/embed/host-compare?hosts=preset%3Aclaude%2Cpreset%3Avscode&capability=elicitation",
        ]}
      >
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>
    );

    expect(screen.getByLabelText("Search host config fields")).toHaveValue(
      "Elicitation"
    );
    expect(screen.getByText(/1 \/ \d+ fields/)).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i)
      ).not.toBeInTheDocument();
    });
  });

  it("writes an exact public capability search into the shareable URL", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter
        initialEntries={[
          "/embed/host-compare?hosts=preset%3Aclaude%2Cpreset%3Avscode",
        ]}
      >
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
        <LocationProbe />
      </MemoryRouter>
    );

    await user.type(
      screen.getByLabelText("Search host config fields"),
      "Elicitation"
    );

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/embed/host-compare?hosts=preset%3Aclaude%2Cpreset%3Avscode&capability=elicitation"
      );
    });
  });

  it("hides agent tuning and request timeout rows in public caniuse mode", async () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i)
      ).not.toBeInTheDocument();
    });

    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("Temperature")).not.toBeInTheDocument();
    expect(screen.queryByText("System prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Request timeout")).not.toBeInTheDocument();
  });

  it("lets public users report an inconsistency", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>
    );

    await user.click(
      screen.getByRole("button", { name: "Report inconsistency" })
    );
    await user.type(
      screen.getByLabelText("What looks inconsistent?"),
      "Claude supports this, but the table says it doesn't."
    );
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/web/caniuse/report-inconsistency",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: "Claude supports this, but the table says it doesn't.",
        }),
      })
    );
    expect(
      await screen.findByText("We've notified the MCPJam team.")
    ).toBeInTheDocument();
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
