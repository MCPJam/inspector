import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { CreateClientDialog } from "@/components/clients/CreateClientDialog";

const mockCreateHost = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostMutations: () => ({
    createHost: (...args: unknown[]) => mockCreateHost(...args),
    updateHost: vi.fn(),
    deleteHost: vi.fn(),
    duplicateHost: vi.fn(),
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [] }),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" | "dark" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("CreateClientDialog prefillServersOption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateHost.mockResolvedValue({
      hostId: "h_new",
      hostConfigId: "cfg_new",
    });
  });

  it("does not render the prefill checkbox when the option is undefined", () => {
    render(
      <CreateClientDialog
        isOpen
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(/Pre-attach the suite's servers/i),
    ).not.toBeInTheDocument();
  });

  it("renders the prefill checkbox unchecked by default when the option is set", () => {
    render(
      <CreateClientDialog
        isOpen
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={vi.fn()}
        prefillServersOption={{
          label: "Pre-attach the suite's servers (3)",
          defaultChecked: false,
          serverIds: ["s_a", "s_b", "s_c"],
        }}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: /Pre-attach the suite's servers/i,
    });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it("creates with empty optionalServerIds when the prefill box is left unchecked", async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateClientDialog
        isOpen
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={onCreated}
        prefillServersOption={{
          label: "Pre-attach the suite's servers (3)",
          defaultChecked: false,
          serverIds: ["s_a", "s_b", "s_c"],
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(mockCreateHost).toHaveBeenCalledTimes(1));
    const callArg = mockCreateHost.mock.calls[0][0];
    expect(callArg.input.serverIds).toEqual([]);
    expect(callArg.input.optionalServerIds).toEqual([]);
    expect(onCreated).toHaveBeenCalledWith("h_new", {
      prefilledOptionalServerIds: [],
    });
  });

  it("creates with optionalServerIds: [...prefilled] when the prefill box is checked", async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateClientDialog
        isOpen
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={onCreated}
        prefillServersOption={{
          label: "Pre-attach the suite's servers (3)",
          defaultChecked: false,
          serverIds: ["s_a", "s_b", "s_c"],
        }}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /Pre-attach the suite's servers/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(mockCreateHost).toHaveBeenCalledTimes(1));
    const callArg = mockCreateHost.mock.calls[0][0];
    expect(callArg.input.serverIds).toEqual([]);
    expect(callArg.input.optionalServerIds).toEqual(["s_a", "s_b", "s_c"]);
    expect(onCreated).toHaveBeenCalledWith("h_new", {
      prefilledOptionalServerIds: ["s_a", "s_b", "s_c"],
    });
  });

  it("honors defaultChecked: true and creates with prefilled IDs without user interaction", async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateClientDialog
        isOpen
        onClose={vi.fn()}
        projectId="proj-1"
        onCreated={onCreated}
        prefillServersOption={{
          label: "Pre-attach the suite's servers (2)",
          defaultChecked: true,
          serverIds: ["s_x", "s_y"],
        }}
      />,
    );
    expect(
      screen.getByRole("checkbox", {
        name: /Pre-attach the suite's servers/i,
      }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(mockCreateHost).toHaveBeenCalledTimes(1));
    expect(mockCreateHost.mock.calls[0][0].input.optionalServerIds).toEqual([
      "s_x",
      "s_y",
    ]);
  });
});
