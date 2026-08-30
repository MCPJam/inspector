/**
 * Full-page create-suite flow: chrome, no modal, Continue creates the suite.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentComposerState } from "@/components/environment-composer/environment-stack";

const {
  flagState,
  environmentsRef,
  resolveMock,
  attachmentsRef,
  hostsRef,
  toastError,
} = vi.hoisted(() => ({
  flagState: { environments: true },
  environmentsRef: { current: [] as unknown[] },
  resolveMock: vi.fn(),
  attachmentsRef: {
    current: [
      { _id: "att-1", name: "Excalidraw", serverIds: ["srv-a"] },
    ] as Array<{ _id: string; name: string; serverIds: string[] }>,
  },
  hostsRef: {
    current: [
      { hostId: "host-1", name: "Claude", modelId: "gpt-4" },
    ] as Array<{ hostId: string; name: string; modelId: string }>,
  },
  toastError: vi.fn(),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.environments,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => environmentsRef.current,
}));
vi.mock("@/components/environment-composer/use-composer-resolver", () => ({
  useComposerResolver: () => resolveMock,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: attachmentsRef.current,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: hostsRef.current, isLoading: false }),
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, vi.fn()],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: toastError },
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
// The models pill is capability-gated as well as slot-gated: without the
// backend matrix the slot stays hidden, which is the correct product
// behavior but would make this file's slot assertions vacuous.
vi.mock("@/hooks/use-model-matrix-capability", () => ({
  useModelMatrixCapability: () => true,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [{ id: "gpt-4", name: "GPT-4", provider: "openai" }],
  }),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: ({
    triggerTestId,
    value,
    onChange,
  }: {
    triggerTestId?: string;
    value: string | null;
    onChange: (id: string) => void;
  }) => (
    <button
      type="button"
      data-testid={triggerTestId ?? "server-group-picker"}
      onClick={() => onChange("att-1")}
    >
      {value ?? "No server group · pick one"}
    </button>
  ),
}));
vi.mock("@/components/project-environments/environment-picker", () => ({
  MAX_SUITE_ENVIRONMENTS: 10,
  EnvironmentPicker: () => null,
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { hosts: "/hosts", environments: "/environments" },
}));

import { DEFAULT_CREATE_SUITE_NAME } from "../create-suite-prefill";
import {
  CreateSuitePage,
  EVALS_CREATE_RUNS_SLOTS,
  EVALS_CREATE_SERVER_SLOTS,
} from "../create-suite-page";

describe("CreateSuitePage", () => {
  const onCancel = vi.fn();
  const onSubmit = vi.fn(async () => {});

  beforeEach(() => {
    onCancel.mockReset();
    onSubmit.mockReset();
    onSubmit.mockResolvedValue(undefined);
    toastError.mockReset();
    flagState.environments = true;
    environmentsRef.current = [];
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({
      environmentIds: ["env-1"],
      environments: [
        {
          environmentId: "env-1",
          hostId: "host-1",
          serverAttachmentId: "att-1",
        },
      ],
      createdIds: ["env-1"],
      reusedIds: [],
    });
  });

  it("renders a full page, not a dialog", () => {
    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    expect(screen.getByTestId("create-suite-page")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Create a new eval suite" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Set up the environment you will be evaluating."),
    ).toBeTruthy();
    expect(screen.getByText("Evaluate")).toBeTruthy();
    expect(screen.getByText("New suite")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^continue$/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
  });

  it("maps Servers and Where it runs onto separate lego-strip slot lists", () => {
    expect(EVALS_CREATE_SERVER_SLOTS).toEqual(["servers"]);
    expect(EVALS_CREATE_RUNS_SLOTS).toEqual(["clients", "models"]);

    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    expect(screen.getByTestId("create-suite-servers-lego-strip")).toBeTruthy();
    expect(screen.getByTestId("create-suite-lego-strip")).toBeTruthy();
    expect(screen.getByTestId("create-suite-clients-picker")).toBeTruthy();
    expect(screen.getByTestId("create-suite-models-picker")).toBeTruthy();
    expect(screen.getByTestId("create-suite-servers-servers-picker")).toBeTruthy();
  });

  it("seeds a default suite name so Continue is enabled without typing", async () => {
    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    const nameInput = screen.getByTestId("create-suite-name");
    expect(nameInput).toHaveValue(DEFAULT_CREATE_SUITE_NAME);
    expect(nameInput).toHaveAttribute(
      "placeholder",
      DEFAULT_CREATE_SUITE_NAME,
    );

    await waitFor(() => {
      expect(screen.getByTestId("create-suite-continue")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("create-suite-continue"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ name: DEFAULT_CREATE_SUITE_NAME }),
      );
    });
  });

  it("disables Continue again if the default name is cleared", async () => {
    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("create-suite-continue")).not.toBeDisabled();
    });

    fireEvent.change(screen.getByTestId("create-suite-name"), {
      target: { value: "" },
    });

    expect(screen.getByTestId("create-suite-name")).toHaveValue("");
    expect(screen.getByTestId("create-suite-name")).toHaveAttribute(
      "placeholder",
      DEFAULT_CREATE_SUITE_NAME,
    );
    expect(screen.getByTestId("create-suite-continue")).toBeDisabled();
  });

  it("prefills the suite name from an empty-hero server card", () => {
    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
        initialName="checkout-server"
        initialServerId="srv-a"
      />,
    );

    expect(screen.getByTestId("create-suite-name")).toHaveValue(
      "checkout-server",
    );
  });

  it("Cancel returns to the Evaluate list", () => {
    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByTestId("create-suite-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("Continue creates the suite from the composed environment", async () => {
    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    fireEvent.change(screen.getByTestId("create-suite-name"), {
      target: { value: "Checkout flows" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("create-suite-continue")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("create-suite-continue"));

    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalled();
    });
    const resolveArg = resolveMock.mock.calls[0][0] as {
      state: EnvironmentComposerState;
    };
    expect(resolveArg.state.stack.hostIds).toEqual(["host-1"]);
    expect(resolveArg.state.stack.serverAttachmentId).toBe("att-1");

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Checkout flows",
          environmentIds: ["env-1"],
          serverAttachmentId: "att-1",
          hostAttachments: [
            { namedHostId: "host-1", enabledOptionalServerIds: [] },
          ],
        }),
      );
    });
  });

  it("Continue sends legacy attachments when environments are off", async () => {
    flagState.environments = false;

    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
      />,
    );

    fireEvent.change(screen.getByTestId("create-suite-name"), {
      target: { value: "Legacy suite" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("create-suite-continue")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("create-suite-continue"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Legacy suite",
          serverAttachmentId: "att-1",
          hostAttachments: [
            { namedHostId: "host-1", enabledOptionalServerIds: [] },
          ],
        }),
      );
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("never pins the empty-hero server into the host attachment", async () => {
    // `initialServerId` seeds the composer's server group and is never cleared
    // when the user picks a different one, so carrying it into the attachment
    // would attach a server they have since navigated away from. Every other
    // creation path (compose mode, the shipped dialog) sends [].
    flagState.environments = false;

    render(
      <CreateSuitePage
        onCancel={onCancel}
        onSubmit={onSubmit}
        hostsEnabled
        projectId="proj-1"
        initialServerId="srv-a"
      />,
    );

    fireEvent.change(screen.getByTestId("create-suite-name"), {
      target: { value: "From a server card" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("create-suite-continue")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("create-suite-continue"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "From a server card",
          hostAttachments: [
            { namedHostId: "host-1", enabledOptionalServerIds: [] },
          ],
        }),
      );
    });
  });
});
