/**
 * The one thing this flow must guarantee: **nothing is written until Save.**
 *
 * The version of this screen we replaced minted a draft host on mount, so every
 * abandoned visit left an orphaned host and its chatbox in the project — and
 * they appeared in the scenario list as real scenarios. These tests exercise
 * every control and assert the write path stays untouched until the user
 * commits.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { catalogState, serversState, cloneMock } = vi.hoisted(() => ({
  catalogState: { status: "live" as string },
  serversState: {
    servers: [{ _id: "srv-1", name: "acme-payments" }] as
      | Array<{ _id: string; name: string }>
      | undefined,
  },
  cloneMock: vi.fn(() => ({ hostStyle: "cursor", serverIds: [] })),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: serversState.servers }),
}));
vi.mock("@/hooks/useClaudeCodeHostEnabled", () => ({
  useClaudeCodeHostEnabled: () => true,
}));
vi.mock("@/hooks/useCodexHostEnabled", () => ({
  useCodexHostEnabled: () => true,
}));
vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({ status: catalogState.status, catalog: {} }),
}));
vi.mock("@/lib/host-compat/feature-visibility", () => ({
  filterHostsByFeatureFlags: (hosts: unknown) => hosts,
}));
vi.mock("@mcpjam/sdk/host-compat", () => ({
  getCatalogHosts: () => [
    { id: "cursor", label: "Cursor" },
    { id: "claude", label: "Claude" },
  ],
  getCatalogHost: (_c: unknown, id: string) => ({
    id,
    label: id === "cursor" ? "Cursor" : "Claude",
  }),
  getCatalogTemplate: (_c: unknown, id: string) => ({ templateFor: id }),
}));
vi.mock("@/lib/host-ui-metadata", () => ({
  DEFAULT_CATALOG_HOST_ID: "cursor",
  getHostLogoSrc: () => "logo.png",
}));
vi.mock("@/lib/client-config-v2", () => ({
  cloneHostTemplateInput: (...args: unknown[]) => cloneMock(...(args as [])),
}));

import { UserTestingCreateFlow } from "../UserTestingCreateFlow";

const renderFlow = (
  onCreateScenario = vi.fn().mockResolvedValue({ hostId: "h1" }),
) => {
  const onCancel = vi.fn();
  render(
    <UserTestingCreateFlow
      projectId="proj-1"
      isAuthenticated
      onCancel={onCancel}
      onCreateScenario={onCreateScenario}
    />,
  );
  return { onCreateScenario, onCancel };
};

beforeEach(() => {
  vi.clearAllMocks();
  catalogState.status = "live";
  serversState.servers = [{ _id: "srv-1", name: "acme-payments" }];
});

describe("UserTestingCreateFlow", () => {
  it("writes nothing while the user fills the form", () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByLabelText(/Scenario name/), {
      target: { value: "Payments beta" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-client"));
    fireEvent.click(screen.getByTestId("user-testing-create-server"));
    fireEvent.click(screen.getByTestId("user-testing-create-access"));

    expect(onCreateScenario).not.toHaveBeenCalled();
  });

  it("writes nothing when the user backs out", () => {
    const { onCreateScenario, onCancel } = renderFlow();

    fireEvent.change(screen.getByLabelText(/Scenario name/), {
      target: { value: "Abandoned" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-back"));

    expect(onCancel).toHaveBeenCalled();
    expect(onCreateScenario).not.toHaveBeenCalled();
  });

  it("saves the name, the attached server and the access mode in one call", async () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByLabelText(/Scenario name/), {
      target: { value: "Payments beta" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    await waitFor(() => expect(onCreateScenario).toHaveBeenCalledTimes(1));
    expect(onCreateScenario).toHaveBeenCalledWith({
      name: "Payments beta",
      input: expect.objectContaining({ serverIds: ["srv-1"] }),
      // The default preset: a scenario is invite-only until its author widens
      // it, so an accidental Save can't publish to the world.
      chatboxMode: "invited_only",
    });
  });

  it("creates one scenario on a double-click, not two", async () => {
    let resolveSave: (v: { hostId: string }) => void = () => {};
    const onCreateScenario = vi.fn(
      () => new Promise<{ hostId: string }>((r) => (resolveSave = r)),
    );
    renderFlow(onCreateScenario);

    fireEvent.change(screen.getByLabelText(/Scenario name/), {
      target: { value: "Payments beta" },
    });
    const save = screen.getByTestId("user-testing-create-save");
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(onCreateScenario).toHaveBeenCalledTimes(1));
    resolveSave({ hostId: "h1" });
  });

  it("cannot save an unnamed scenario", () => {
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByLabelText(/Scenario name/), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    expect(onCreateScenario).not.toHaveBeenCalled();
  });

  it("cannot save before the client catalog resolves", () => {
    catalogState.status = "loading";
    const { onCreateScenario } = renderFlow();

    fireEvent.change(screen.getByLabelText(/Scenario name/), {
      target: { value: "Payments beta" },
    });
    fireEvent.click(screen.getByTestId("user-testing-create-save"));

    expect(onCreateScenario).not.toHaveBeenCalled();
  });

  it("says so when the project has no server to point at", () => {
    serversState.servers = [];
    renderFlow();

    expect(screen.getByText(/Connect a server first/i)).toBeInTheDocument();
  });
});
