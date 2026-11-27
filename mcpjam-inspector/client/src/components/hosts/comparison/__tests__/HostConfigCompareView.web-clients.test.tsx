import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostConfigCompareView } from "../HostConfigCompareView";

/**
 * Signed-in Compare, where the rollout flags decide which presets show. The
 * public suite can't reach this: `presetOnly` returns before the flags apply.
 */
const webClients = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useWebClientsEnabled", () => ({
  useWebClientsEnabled: () => webClients.enabled,
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [], isLoading: false }),
  useHost: () => ({ host: null, isLoading: false }),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
  usePostHog: () => ({ capture: () => undefined }),
}));

// The bundled catalog plus the two web client templates, as the live catalog
// serves them.
vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const { bundledHostCompatCatalog } = await import("@mcpjam/sdk/host-compat");
  const base = bundledHostCompatCatalog();
  const catalog = {
    ...base,
    hostsById: {
      ...base.hostsById,
      "web-claude": {
        ...base.hostsById.claude!,
        id: "web-claude",
        label: "Claude web",
      },
      "web-chatgpt": {
        ...base.hostsById.chatgpt!,
        id: "web-chatgpt",
        label: "ChatGPT web",
      },
    },
  };
  return {
    useHostCatalog: () => ({
      status: "live",
      catalog,
      version: 1,
      source: "live",
    }),
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light"; setThemeMode: () => void }) => unknown,
  ) => selector({ themeMode: "light", setThemeMode: () => undefined }),
}));

async function presetNames(enabled: boolean) {
  webClients.enabled = enabled;
  const { unmount } = render(
    <MemoryRouter>
      <HostConfigCompareView projectId="abc123" isAuthenticated />
    </MemoryRouter>,
  );
  // Unranked presets live in the More menu; Notion shows it opened.
  fireEvent.click(screen.getByTestId("host-compare-overflow-trigger"));
  expect(await screen.findByText("Notion")).toBeInTheDocument();
  const shown = {
    claude:
      screen.queryByTestId("host-compare-chip-preset:web-claude") !== null ||
      screen.queryByText("Claude web") !== null,
    chatgpt:
      screen.queryByTestId("host-compare-chip-preset:web-chatgpt") !== null ||
      screen.queryByText("ChatGPT web") !== null,
  };
  unmount();
  return shown;
}

describe("HostConfigCompareView web client presets", () => {
  afterEach(() => {
    webClients.enabled = false;
  });

  it("hides Claude web and ChatGPT web while their flag is off and shows them when it's on", async () => {
    expect(await presetNames(false)).toEqual({ claude: false, chatgpt: false });
    expect(await presetNames(true)).toEqual({ claude: true, chatgpt: true });
  });
});
