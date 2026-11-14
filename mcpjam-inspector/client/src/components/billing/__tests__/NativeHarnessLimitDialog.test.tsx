import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createProject } from "@/test/factories";
import { useNativeHarnessLimitDialogStore } from "@/stores/native-harness-limit-dialog-store";
import { NativeHarnessLimitDialog } from "../NativeHarnessLimitDialog";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

const upgradeOrganizationIds = vi.hoisted(() => vi.fn());
const upgradeState = vi.hoisted(() => ({
  canManageBilling: true,
  isLoadingBilling: false,
  effectivePlan: "free",
  start: vi.fn(),
}));
vi.mock("@/hooks/use-upgrade-checkout", () => ({
  useUpgradeCheckout: (params: { organizationId: string | null }) => {
    upgradeOrganizationIds(params);
    return {
      ...upgradeState,
      organizationName: "Acme Robotics",
      teamName: "Pro",
      isStarting: false,
      isLoadingPrices: false,
    };
  },
}));

const recipientsState = vi.hoisted(() => ({
  recipients: [{ email: "dana@acme.test", name: "Dana Ruiz" }],
  isLoading: false,
}));
vi.mock("@/hooks/use-upgrade-request-recipients", () => ({
  useUpgradeRequestRecipients: () => recipientsState,
}));

const trialState = vi.hoisted(() => ({
  value: null as { remaining: number; granted: number } | null,
}));
vi.mock("@/hooks/use-native-harness-trial", () => ({
  useNativeHarnessTrial: () => trialState.value,
}));

const appState = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => appState.value,
}));

const switchProjectIds = vi.hoisted(() => vi.fn());
const switchState = vi.hoisted(() => ({
  switchCount: 0,
  isSwitching: false,
  switchClients: vi.fn(),
}));
vi.mock("../use-native-harness-switch", () => ({
  useNativeHarnessSwitch: (projectId: string | null) => {
    switchProjectIds(projectId);
    return switchState;
  },
}));

const description = () =>
  screen.getByTestId("native-harness-limit-description").textContent;

beforeEach(() => {
  trackMock.mockReset();
  upgradeOrganizationIds.mockReset();
  upgradeState.canManageBilling = true;
  upgradeState.isLoadingBilling = false;
  upgradeState.start.mockReset();
  recipientsState.recipients = [{ email: "dana@acme.test", name: "Dana Ruiz" }];
  recipientsState.isLoading = false;
  trialState.value = null;
  switchProjectIds.mockReset();
  switchState.switchCount = 0;
  switchState.switchClients.mockReset();
  const project = createProject({
    id: "local-1",
    organizationId: "org_active",
    sharedProjectId: "proj_active",
  });
  appState.value = {
    activeProjectId: project.id,
    projects: { [project.id]: project },
  };
  useNativeHarnessLimitDialogStore.setState({
    notice: null,
    notifiedKeys: new Set(),
    afterSwitch: null,
  });
});

afterEach(() => {
  act(() => useNativeHarnessLimitDialogStore.getState().close());
});

describe("NativeHarnessLimitDialog", () => {
  it("renders nothing until a refusal opens it", () => {
    const { container } = render(<NativeHarnessLimitDialog />);
    expect(container).toBeEmptyDOMElement();
    expect(upgradeOrganizationIds).not.toHaveBeenCalled();
  });

  it("speaks for the active project's organization when the refusal names none", () => {
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    expect(upgradeOrganizationIds).toHaveBeenLastCalledWith({
      organizationId: "org_active",
      origin: "native_harness",
      limitKind: "native_harness_turns",
    });
    expect(description()).toBe(
      "Your organization has used its 20 free native harness turns. Upgrade to keep using native harnesses across MCPJam.",
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.objectContaining({
        wall_kind: "native_harness",
        organization_id: "org_active",
        audience: "billing_manager",
      }),
    );
  });

  it("prefers the organization the refusal named, and the trial it reads", () => {
    trialState.value = { remaining: 0, granted: 25 };
    useNativeHarnessLimitDialogStore.getState().open({ organizationId: "org_run" });
    render(<NativeHarnessLimitDialog />);

    expect(upgradeOrganizationIds).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: "org_run" }),
    );
    expect(description()).toContain("used its 25 free native harness turns");
  });

  it("waits for billing before choosing between Upgrade and a request", () => {
    upgradeState.isLoadingBilling = true;
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("starts checkout for a billing manager and closes once it is on its way", async () => {
    upgradeState.start.mockResolvedValue({
      redirected: false,
      shouldDismiss: true,
    });
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(upgradeState.start).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useNativeHarnessLimitDialogStore.getState().notice).toBeNull(),
    );
  });

  it("gives a member the request to the owners", () => {
    upgradeState.canManageBilling = false;
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(screen.getByTestId("request-upgrade-mail")).toHaveTextContent(
      "Request upgrade",
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.objectContaining({ audience: "member" }),
    );
  });

  it("holds a member's dialog until the owners load, then opens with the request", () => {
    upgradeState.canManageBilling = false;
    recipientsState.isLoading = true;
    recipientsState.recipients = [];
    useNativeHarnessLimitDialogStore.getState().open({});
    const { rerender } = render(<NativeHarnessLimitDialog />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();

    recipientsState.isLoading = false;
    recipientsState.recipients = [{ email: "dana@acme.test", name: "Dana Ruiz" }];
    rerender(<NativeHarnessLimitDialog />);

    expect(screen.getByTestId("request-upgrade-mail")).toBeInTheDocument();
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.objectContaining({
        primary_action: "request_owner",
        request_recipient_count: 1,
      }),
    );
  });

  it("closes on Not now and reports the dismissal", async () => {
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(useNativeHarnessLimitDialogStore.getState().notice).toBeNull();
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_dismissed",
      expect.objectContaining({ wall_kind: "native_harness" }),
    );
  });

  it("offers a project admin the switch for the active project", async () => {
    switchState.switchCount = 3;
    switchState.switchClients.mockResolvedValue(true);
    const afterSwitch = vi.fn();
    useNativeHarnessLimitDialogStore.setState({ afterSwitch });
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    expect(switchProjectIds).toHaveBeenLastCalledWith("proj_active");
    expect(description()).toContain(
      "or switch 3 clients in this project to MCPJam Harness.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Switch 3 clients to MCPJam Harness" }),
    );

    expect(switchState.switchClients).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useNativeHarnessLimitDialogStore.getState().notice).toBeNull(),
    );
    // The Playground's new chat with the refused message, when it asked.
    expect(afterSwitch).toHaveBeenCalledTimes(1);
  });

  // The owners arrive after billing, as they do over the network: the
  // dialog waits for them, so it opens on the request, not the switch.
  it("opens on the request, not the switch, once the owners load", async () => {
    upgradeState.canManageBilling = false;
    recipientsState.isLoading = true;
    recipientsState.recipients = [];
    switchState.switchCount = 3;
    useNativeHarnessLimitDialogStore.getState().open({});
    const { rerender } = render(<NativeHarnessLimitDialog />);

    expect(screen.queryByRole("dialog")).toBeNull();

    recipientsState.isLoading = false;
    recipientsState.recipients = [{ email: "dana@acme.test", name: "Dana Ruiz" }];
    rerender(<NativeHarnessLimitDialog />);

    await waitFor(() =>
      expect(screen.getByTestId("request-upgrade-mail")).toHaveFocus(),
    );
    expect(
      screen.getByRole("button", { name: "Switch 3 clients to MCPJam Harness" }),
    ).not.toHaveFocus();
  });

  // The hook reports false for a refusal and for a switch that moved no
  // client; either way the person is still out of turns.
  it("stays open, and starts no new chat, when no client moved", async () => {
    switchState.switchCount = 2;
    switchState.switchClients.mockResolvedValue(false);
    const afterSwitch = vi.fn();
    useNativeHarnessLimitDialogStore.setState({ afterSwitch });
    useNativeHarnessLimitDialogStore.getState().open({});
    render(<NativeHarnessLimitDialog />);

    await userEvent.click(
      screen.getByRole("button", { name: "Switch 2 clients to MCPJam Harness" }),
    );

    await waitFor(() => expect(switchState.switchClients).toHaveBeenCalled());
    expect(useNativeHarnessLimitDialogStore.getState().notice).not.toBeNull();
    expect(afterSwitch).not.toHaveBeenCalled();
  });

  it("offers no switch for a project of another organization", () => {
    switchState.switchCount = 3;
    useNativeHarnessLimitDialogStore
      .getState()
      .open({ organizationId: "org_elsewhere" });
    render(<NativeHarnessLimitDialog />);

    expect(switchProjectIds).toHaveBeenLastCalledWith(null);
  });

  it("shows a User Testing link the owner notice, with no billing read", () => {
    useNativeHarnessLimitDialogStore
      .getState()
      .open({ organizationId: "org_owner", surface: "scenario" });
    render(<NativeHarnessLimitDialog />);

    expect(
      screen.getByRole("heading", { name: "This test is paused" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      "The owner of this test has used their organization's free native harness turns. Let them know.",
    );
    expect(upgradeOrganizationIds).not.toHaveBeenCalled();
  });
});
