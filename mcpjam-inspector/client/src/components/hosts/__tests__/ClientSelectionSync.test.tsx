import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ClientSelectionSync } from "../ClientSelectionSync";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  set: vi.fn(),
  catalog: vi.fn(),
  selected: null as string | null,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: mocks.list,
  useHostMutations: () => ({ createHost: mocks.create }),
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [mocks.selected, mocks.set],
}));
vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: mocks.catalog,
}));
vi.mock("@mcpjam/sdk/host-compat", () => ({
  getCatalogHost: () => ({ label: "MCPJam" }),
  getCatalogTemplate: () => ({ seed: true }),
}));
vi.mock("@/lib/client-config-v2", () => ({
  cloneHostTemplateInput: () => ({ seeded: true }),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: (s: { themeMode: string }) => unknown) =>
    select({ themeMode: "light" }),
}));

describe("ClientSelectionSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selected = null;
    mocks.list.mockReturnValue({ hosts: [], isLoading: false });
    mocks.catalog.mockReturnValue({ status: "live", catalog: {} });
    mocks.create.mockResolvedValue("new-host");
  });
  it("initializes an empty guest project privately without rendering a global selector", () => {
    const { container, rerender } = render(
      <ClientSelectionSync projectId="p1" />,
    );
    rerender(<ClientSelectionSync projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({
      projectId: "p1",
      name: "MCPJam",
      input: { seeded: true },
      scenarioMode: "project_members",
    });
  });
  it("initializes each project independently", () => {
    const { rerender } = render(<ClientSelectionSync projectId="p1" />);
    rerender(<ClientSelectionSync projectId="p2" />);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it("does not reseed a project when returning while mutations are pending", () => {
    mocks.create.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<ClientSelectionSync projectId="p1" />);
    rerender(<ClientSelectionSync projectId="p2" />);
    rerender(<ClientSelectionSync projectId="p1" />);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it("a late failure only clears the failed project's guard", async () => {
    let rejectFirst!: (error: Error) => void;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
    );
    const { rerender } = render(<ClientSelectionSync projectId="p1" />);
    rerender(<ClientSelectionSync projectId="p2" />);
    await act(async () => {
      rejectFirst(new Error("failed"));
    });
    rerender(<ClientSelectionSync projectId="p2" />);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    rerender(<ClientSelectionSync projectId="p1" />);
    expect(mocks.create).toHaveBeenCalledTimes(3);
  });
  it("waits for the host list before creating or reconciling", () => {
    mocks.list.mockReturnValue({ hosts: [], isLoading: true });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("repairs a deleted selection using the default client", () => {
    mocks.selected = "deleted";
    mocks.list.mockReturnValue({
      hosts: [
        { hostId: "a", name: "Claude" },
        { hostId: "b", name: "MCPJam" },
      ],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.set).toHaveBeenCalledWith("b");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("keeps a valid selection", () => {
    mocks.selected = "a";
    mocks.list.mockReturnValue({
      hosts: [{ hostId: "a", name: "Claude" }],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("falls back alphabetically when the default was deleted", () => {
    mocks.list.mockReturnValue({
      hosts: [
        { hostId: "z", name: "Zulu" },
        { hostId: "a", name: "Alpha" },
      ],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.set).toHaveBeenCalledWith("a");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
