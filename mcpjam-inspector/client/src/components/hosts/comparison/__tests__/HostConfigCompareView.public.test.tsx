import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostConfigCompareView } from "../HostConfigCompareView";

const mockHostListState = vi.hoisted(() => ({
  hosts: [] as any[],
}));
const mockCatalogState = vi.hoisted(() => ({
  current: null as any,
}));
const mockPreferencesState = vi.hoisted(() => ({
  themeMode: "light" as "light" | "dark",
  setThemeMode: vi.fn(),
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

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  return {
    useHostCatalog: () =>
      mockCatalogState.current ?? {
        status: "live",
        catalog: bundledHostCompatCatalog(),
        version: 1,
        source: "live",
      },
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: typeof mockPreferencesState) => unknown,
  ) => selector(mockPreferencesState),
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
    mockCatalogState.current = null;
    mockPreferencesState.themeMode = "light";
    mockPreferencesState.setThemeMode.mockClear();
    document.documentElement.classList.remove("dark");
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: originalMatchMedia,
    });
    document.documentElement.classList.remove("dark");
  });

  it("offers the flag-gated hosts in public mode but not in the signed-in matrix", async () => {
    // `useFeatureFlagEnabled` is mocked false above — the anonymous-visitor
    // case, and the one that used to drop these two from caniuse entirely.
    // They sit past the 6-chip inline limit, so assert them where they live:
    // the More menu. Public caniuse is reference data and lists every catalog
    // host; the signed-in matrix sits beside hosts you can actually create,
    // so it keeps the rollout gate. Pinned together so the split can't drift.
    const { unmount } = render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );
    // Both are ranked, so they render as inline chips rather than in the More
    // menu. Asserted by test id: a bare `getByText("Claude Code")` would be
    // satisfied by the chip and would keep passing even if the gate started
    // hiding them, which is the whole thing this test exists to catch.
    expect(
      screen.getByTestId("host-compare-chip-preset:claude-code"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("host-compare-chip-preset:codex"),
    ).toBeInTheDocument();
    // The menu still has to open and list the unranked presets, so the
    // signed-in absences below read as the gate rather than a dead menu.
    fireEvent.click(screen.getByTestId("host-compare-overflow-trigger"));
    expect(await screen.findByText("Notion")).toBeInTheDocument();
    unmount();

    // Signed in with a project, so the matrix actually renders hosts. With
    // `projectId={null}` it short-circuits to the sign-in placeholder and the
    // absence below would hold no matter what the gate did.
    render(
      <MemoryRouter>
        <HostConfigCompareView projectId="abc123" isAuthenticated />
      </MemoryRouter>,
    );
    // Presets render here at all...
    expect(
      screen.getByTestId("host-compare-chip-preset:claude"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("host-compare-overflow-trigger"));
    // ...and the overflow menu opened and lists other unranked presets, so
    // the two absences below are the gate, not an unrendered menu.
    expect(await screen.findByText("Notion")).toBeInTheDocument();
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
  });

  it("renders preset compare content without requiring sign-in or a project", async () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Sign in to compare/i)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Search client config fields"),
    ).toBeInTheDocument();
    expect(screen.getByText("Can I use…")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show all clients and capabilities",
      }),
    ).toBeDisabled();
    expect(
      screen.getByTestId("host-compare-chip-preset:claude"),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i),
      ).not.toBeInTheDocument();
    });
  });

  it("toggles the public caniuse theme from the top action row", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole("button", { name: "Switch to dark mode" }),
    );

    expect(mockPreferencesState.setThemeMode).toHaveBeenCalledWith("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("puts the preferred caniuse clients in the top chip row", () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    const topChipIds = Array.from(
      document.querySelectorAll('[data-testid^="host-compare-chip-"]'),
    ).map((node) => node.getAttribute("data-testid"));

    // Ranked order, grouped by vendor, with VS Code and Slackbot pinned
    // rightmost. The inline chip limit is sized to this list — if it drops
    // below the list length the tail stops rendering rather than overflowing.
    expect(topChipIds).toEqual([
      "host-compare-chip-preset:claude",
      "host-compare-chip-preset:claude-desktop",
      "host-compare-chip-preset:claude-code",
      "host-compare-chip-preset:chatgpt",
      "host-compare-chip-preset:codex",
      "host-compare-chip-preset:copilot",
      "host-compare-chip-preset:cursor",
      "host-compare-chip-preset:vscode",
      "host-compare-chip-preset:slack",
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
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Search client config fields")).toHaveValue(
      "Elicitation",
    );
    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i),
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
      </MemoryRouter>,
    );

    await user.type(
      screen.getByLabelText("Search client config fields"),
      "Elicitation",
    );

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/embed/host-compare?hosts=preset%3Aclaude%2Cpreset%3Avscode&capability=elicitation",
      );
    });
  });

  it("disables the support filter until a search is entered", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    const filterButton = screen.getByLabelText(
      "Filter fields by support level",
    );
    expect(filterButton).toBeDisabled();

    await user.type(
      screen.getByLabelText("Search client config fields"),
      "Elicitation",
    );

    expect(filterButton).not.toBeDisabled();
  });

  it("clears search filtering without changing selected clients when Can I use is clicked", async () => {
    const user = userEvent.setup();

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
      </MemoryRouter>,
    );

    const search = screen.getByLabelText("Search client config fields");
    const canIUseButton = screen.getByRole("button", {
      name: "Show all clients and capabilities",
    });
    expect(search).toHaveValue("Elicitation");
    expect(canIUseButton).not.toBeDisabled();
    expect(
      screen.getByTestId("host-compare-chip-preset:chatgpt"),
    ).toHaveAttribute("data-selected", "false");

    await user.click(canIUseButton);

    expect(search).toHaveValue("");
    expect(canIUseButton).toBeDisabled();
    expect(
      screen.getByLabelText("Filter fields by support level"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("host-compare-chip-preset:chatgpt"),
    ).toHaveAttribute("data-selected", "false");
  });

  it("hides agent tuning and request timeout rows in public caniuse mode", async () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.queryByText(/Select at least one client/i),
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
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole("button", { name: "Report inconsistency" }),
    );
    await user.type(
      screen.getByLabelText("What looks inconsistent?"),
      "Claude supports this, but the table says it doesn't.",
    );
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/web/caniuse/report-inconsistency",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: "Claude supports this, but the table says it doesn't.",
        }),
      }),
    );
    expect(
      await screen.findByText("We've notified the MCPJam team."),
    ).toBeInTheDocument();
  });

  it("opens notify in a centered dialog and subscribes an email", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    render(
      <MemoryRouter>
        <HostConfigCompareView
          projectId={null}
          isAuthenticated={false}
          presetOnly
        />
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole("button", { name: "Notify me of client changes" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Stay up to date");

    await user.type(screen.getByLabelText("Email"), "founders@mcpjam.com");
    await user.click(screen.getByRole("button", { name: "Notify me" }));

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/web/caniuse/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "founders@mcpjam.com" }),
      }),
    );
    expect(
      await screen.findByText("We'll email you when hosts change."),
    ).toBeInTheDocument();
  });

  it("keeps the full app no-project state behind sign-in", () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView projectId={null} isAuthenticated={false} />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/Sign in to compare your clients/i),
    ).toBeInTheDocument();
  });

  it("does not fall back to SDK preset hosts in the full app compare page", () => {
    mockCatalogState.current = {
      status: "fallback",
      catalog: null,
      version: 0,
      source: "bundled",
    };

    render(
      <MemoryRouter>
        <HostConfigCompareView projectId="abc123" isAuthenticated />
      </MemoryRouter>,
    );

    expect(
      screen.queryByTestId("host-compare-chip-preset:claude"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No hosts yet. Create one from the Host tab to populate the comparison.",
      ),
    ).toBeInTheDocument();
  });

  it("shows only caniuse rows plus protocol version in the full app", async () => {
    render(
      <MemoryRouter>
        <HostConfigCompareView projectId="abc123" isAuthenticated />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Protocol version")).toBeInTheDocument();
    expect(screen.getByText("Roots")).toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("Temperature")).not.toBeInTheDocument();
    expect(screen.queryByText("System prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Render tool images")).not.toBeInTheDocument();
    expect(screen.queryByText("Request timeout")).not.toBeInTheDocument();
    expect(screen.queryByText("Default headers")).not.toBeInTheDocument();
    expect(screen.queryByText("CSP mode")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions mode")).not.toBeInTheDocument();
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
      </MemoryRouter>,
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
      </MemoryRouter>,
    );

    expect(screen.getByTestId("compare-view-list")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
