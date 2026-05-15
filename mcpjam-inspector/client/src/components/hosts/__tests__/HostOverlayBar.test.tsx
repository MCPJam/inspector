import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));

const mockUseHostList = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useHosts", () => ({
  useHostList: (...args: unknown[]) => mockUseHostList(...args),
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: vi.fn().mockResolvedValue(undefined),
    duplicateHost: vi.fn(),
  }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

describe("HostOverlayBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHostList.mockReturnValue({
      hosts: [
        {
          hostId: "host-a",
          name: "MCPJam",
          hostConfigId: "cfg-1",
          modelId: "x",
          serverCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      isLoading: false,
    });
  });

  it("lays out the toolbar like the redesigned host builder header row", () => {
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />,
    );

    const bar = screen.getByTestId("host-overlay-bar");
    expect(bar).toHaveClass("min-w-0", "items-center");
  });

  it("exposes edit, save-as-new, and delete in the host dropdown", async () => {
    const user = userEvent.setup();
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Host used for preview" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("host-overlay-edit")).toBeVisible();
    });
    expect(screen.getByTestId("host-overlay-save-as-new")).toBeVisible();
    expect(screen.getByTestId("host-overlay-delete")).toBeVisible();
  });
});
