import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@/hooks/useClients";
import { ClientSelector } from "@/components/chat-v2/chat-input/client-selector";
import { useCompareEnvironmentPanes } from "../use-compare-environment-panes";

const webClients = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useWebClientsEnabled", () => ({
  useWebClientsEnabled: () => webClients.enabled,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabledState: () => true,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("@/hooks/use-environment-preview", () => ({
  useEnvironmentPreview: () => ({ preview: null, isLoading: false, error: null }),
}));
// The chat's client selector, rendered beside the hook for comparison.
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { hosts: "/clients" },
}));
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));
vi.mock("@/lib/host-logo", () => ({ resolveHostLogo: () => "/mcp.svg" }));

const host = (hostId: string, name: string, runtime?: string): HostListItem => ({
  hostId,
  name,
  runtime,
  hostConfigId: `cfg-${hostId}`,
  modelId: "openai/gpt-5-mini",
  serverCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

const hosts = [
  host("host-a", "Claude Code", "claude-code"),
  host("host-web", "ChatGPT web", "chatgpt-web"),
  host("host-b", "MCPJam"),
];

async function selectorRows(): Promise<string[]> {
  const user = userEvent.setup();
  const { unmount } = render(
    <ClientSelector
      hosts={hosts}
      projectId="proj-1"
      cloudProjectId="proj-1"
      currentHostId="host-a"
      selectedHostIds={["host-a"]}
      onHostChange={vi.fn()}
      onSelectedHostIdsChange={vi.fn()}
      onMultiHostEnabledChange={vi.fn()}
      onPromoteLead={vi.fn()}
      enableMultiHost
    />,
  );
  await user.click(screen.getByTestId("client-selector-trigger"));
  const rows = screen
    .getAllByRole("option")
    .map((row) => row.getAttribute("data-testid")!.replace("client-row-", ""));
  unmount();
  return rows;
}

describe("useCompareEnvironmentPanes clients", () => {
  afterEach(() => {
    webClients.enabled = false;
  });

  it("offers compare panes the same clients as the chat's selector", async () => {
    for (const enabled of [false, true]) {
      webClients.enabled = enabled;
      const { result, unmount } = renderHook(() =>
        useCompareEnvironmentPanes({ projectId: "proj-1", panes: [], hosts }),
      );
      const paneClients = result.current.targets.clients.map((option) =>
        option.target.kind === "host" ? option.target.hostId : null,
      );
      unmount();
      expect(paneClients, `flag ${enabled}`).toEqual(
        enabled ? ["host-a", "host-web", "host-b"] : ["host-a", "host-b"],
      );
      expect(await selectorRows(), `flag ${enabled}`).toEqual(paneClients);
    }
  });
});
