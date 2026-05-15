import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostsTab } from "@/components/HostsTab";

vi.mock("@/hooks/use-previewed-host-id", () => ({
  usePreviewedHostId: vi.fn(() => [null as string | null, vi.fn()]),
}));

vi.mock("@/hooks/useHosts", () => ({
  useHost: vi.fn(() => ({ host: null, isLoading: false })),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: vi.fn((selector: (state: any) => unknown) =>
    selector({ themeMode: "dark" }),
  ),
}));

vi.mock("@/components/hosts/HostBuilderView", () => ({
  HostBuilderView: () => <div data-testid="mock-host-builder" />,
}));

describe("HostsTab", () => {
  it("matches the redesigned host builder top chrome spacing and divider", () => {
    render(
      <HostsTab
        projectId="proj-1"
        isAuthenticated
        selectedHostId={null}
        onSelectHost={vi.fn()}
        serversTabElement={<div data-testid="servers-stub" />}
      />,
    );

    const chrome = screen.getByTestId("hosts-tab-header-chrome");
    expect(chrome).toHaveClass(
      "shrink-0",
      "border-b",
      "border-border/40",
      "px-8",
      "py-2.5",
    );
  });
});
