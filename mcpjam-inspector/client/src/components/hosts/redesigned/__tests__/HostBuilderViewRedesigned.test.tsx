import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostConfigDtoV2 } from "@/lib/host-config-v2";
import { HostBuilderViewRedesigned } from "../HostBuilderViewRedesigned";

const BASE_CONFIG: HostConfigDtoV2 = {
  id: "cfg-host-a",
  schemaVersion: 2,
  hostStyle: "claude",
  modelId: "claude-sonnet-4-5",
  systemPrompt: "",
  temperature: 0.7,
  requireToolApproval: false,
  serverIds: [],
  optionalServerIds: [],
  connectionDefaults: { headers: {}, requestTimeout: 10_000 },
  clientCapabilities: {},
  hostContext: {},
};

const mockUseHost = vi.fn();
const mockUseHostList = vi.fn();
const mockUpdateHost = vi.fn();

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useHosts", () => ({
  useHost: (...args: unknown[]) => mockUseHost(...args),
  useHostList: (...args: unknown[]) => mockUseHostList(...args),
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHost: mockUpdateHost,
    deleteHost: vi.fn(),
    duplicateHost: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectServers: () => ({ servers: [] }),
  useServerMutations: () => ({ createServer: vi.fn() }),
}));

vi.mock("../canvas/RedesignedHostCanvas", () => ({
  RedesignedHostCanvas: () => <div data-testid="mock-host-canvas" />,
}));

beforeAll(() => {
  // Radix Select uses Pointer Capture APIs not implemented in jsdom.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
});

describe("HostBuilderViewRedesigned", () => {
  const onSwitchHost = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHost.mockReturnValue({
      host: {
        hostId: "host-a",
        name: "MCPJam",
        config: BASE_CONFIG,
      },
      isLoading: false,
    });
    mockUseHostList.mockReturnValue({
      hosts: [
        {
          hostId: "host-a",
          name: "MCPJam",
          hostConfigId: "cfg-host-a",
          modelId: "x",
          serverCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          hostId: "host-b",
          name: "Other",
          hostConfigId: "cfg-host-b",
          modelId: "x",
          serverCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      isLoading: false,
    });
  });

  it("renders a host switcher when onSwitchHost is set and multiple hosts exist", async () => {
    const user = userEvent.setup();
    render(
      <HostBuilderViewRedesigned
        hostId="host-a"
        projectId="ws-1"
        onBack={() => {}}
        onSwitchHost={onSwitchHost}
      />,
    );

    const trigger = screen.getByTestId("host-builder-host-select");
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: "Other" }));

    expect(onSwitchHost).toHaveBeenCalledWith("host-b");
  });

  it("does not render the host switcher when only one host exists", () => {
    mockUseHostList.mockReturnValue({
      hosts: [
        {
          hostId: "host-a",
          name: "Only",
          hostConfigId: "c1",
          modelId: "x",
          serverCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      isLoading: false,
    });

    render(
      <HostBuilderViewRedesigned
        hostId="host-a"
        projectId="ws-1"
        onBack={() => {}}
        onSwitchHost={onSwitchHost}
      />,
    );

    expect(
      screen.queryByTestId("host-builder-host-select"),
    ).not.toBeInTheDocument();
  });
});
