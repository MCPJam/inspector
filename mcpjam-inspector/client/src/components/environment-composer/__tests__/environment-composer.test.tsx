/**
 * Shared lego-strip slots: default swarm strip omits models; callers can
 * opt into a subset (evals create: servers, or clients + models).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  emptyComposerState,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";

const flagState = vi.hoisted(() => ({
  skills: false,
  computers: false,
  environments: true,
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => flagState.skills,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => flagState.computers,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.environments,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-1", name: "Claude", modelId: "gpt-4" }],
    isLoading: false,
  }),
}));
// Capability ON, so "models is absent" below is proven by the SLOT list and
// not by an unavailable backend matrix.
vi.mock("@/hooks/use-model-matrix-capability", () => ({
  useModelMatrixCapability: () => true,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [{ id: "gpt-4", name: "GPT-4", provider: "openai" }],
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/components/environment-composer/clients-pill", () => ({
  ClientsPill: ({
    testId,
    disabled,
  }: {
    testId?: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={testId} disabled={disabled}>
      clients
    </button>
  ),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: ({
    triggerTestId,
    disabled,
  }: {
    triggerTestId?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid={triggerTestId ?? "server-group-picker"}
      disabled={disabled}
    />
  ),
}));
vi.mock("@/components/project-environments/environment-picker", () => ({
  EnvironmentPicker: ({
    triggerTestId,
    disabled,
  }: {
    triggerTestId?: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={triggerTestId} disabled={disabled}>
      environments
    </button>
  ),
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { hosts: "/hosts", environments: "/environments" },
}));

import { EnvironmentComposer } from "../environment-composer";

function Harness({
  slots,
  environments = [],
  initialValue,
  lockedSlots,
}: {
  slots?: Parameters<typeof EnvironmentComposer>[0]["slots"];
  environments?: Parameters<typeof EnvironmentComposer>[0]["environments"];
  initialValue?: EnvironmentComposerState;
  lockedSlots?: Parameters<typeof EnvironmentComposer>[0]["lockedSlots"];
}) {
  const [value, setValue] = useState<EnvironmentComposerState>(
    () => initialValue ?? emptyComposerState(),
  );
  return (
    <EnvironmentComposer
      projectId="proj-1"
      environments={environments}
      value={value}
      onChange={setValue}
      testIdPrefix="strip"
      slots={slots}
      lockedSlots={lockedSlots}
    />
  );
}

describe("EnvironmentComposer slots", () => {
  beforeEach(() => {
    flagState.skills = false;
    flagState.computers = false;
    flagState.environments = true;
  });

  it("defaults to clients + servers and omits models (swarm strip)", () => {
    render(<Harness />);

    expect(screen.getByTestId("strip-lego-strip")).toBeVisible();
    expect(screen.getByTestId("strip-environments-picker")).toBeVisible();
    expect(screen.getByTestId("strip-clients-picker")).toBeVisible();
    expect(screen.getByTestId("strip-servers-picker")).toBeVisible();
    expect(screen.queryByTestId("strip-models-picker")).toBeNull();
    expect(screen.queryByTestId("strip-skills-picker")).toBeNull();
  });

  it("renders only the requested slots so evals can split Servers from Where it runs", () => {
    const { rerender } = render(<Harness slots={["servers"]} />);

    expect(screen.getByTestId("strip-servers-picker")).toBeVisible();
    expect(screen.queryByTestId("strip-clients-picker")).toBeNull();
    expect(screen.queryByTestId("strip-models-picker")).toBeNull();
    expect(screen.queryByTestId("strip-environments-picker")).toBeNull();

    rerender(<Harness slots={["clients", "models"]} />);

    expect(screen.getByTestId("strip-clients-picker")).toBeVisible();
    expect(screen.getByTestId("strip-models-picker")).toBeVisible();
    expect(screen.getByTestId("strip-models-picker")).toHaveTextContent("models");
    expect(screen.queryByTestId("strip-servers-picker")).toBeNull();
    expect(screen.queryByTestId("strip-environments-picker")).toBeNull();
  });

  it("keeps the blocked-edit hint when the environments flag is off", () => {
    // The hint explains why every pill is greyed out. Gating it on the RENDERED
    // environments picker (slot requested AND flag on) left a viewer without
    // `project-environments-enabled` facing a dead strip and no explanation —
    // a regression against the shipped evals tab, which asks for the slot.
    flagState.environments = false;

    render(
      <Harness
        slots={["environments", "clients", "servers"]}
        environments={[
          {
            environmentId: "env-1",
            projectId: "proj-1",
            name: "pinned",
            pluginVersionIds: ["plugin-1"],
          } as never,
        ]}
        initialValue={{ ...emptyComposerState(), environmentIds: ["env-1"] }}
      />,
    );

    expect(screen.queryByTestId("strip-environments-picker")).toBeNull();
    expect(screen.getByTestId("strip-collapse-hint")).toBeVisible();
  });

  it("drops the hint when the caller never asked for the environments slot", () => {
    // A surface that omitted the slot says its own version of this, so naming
    // a control it does not render would point at nothing.
    render(
      <Harness
        slots={["servers"]}
        environments={[
          {
            environmentId: "env-1",
            projectId: "proj-1",
            name: "pinned",
            pluginVersionIds: ["plugin-1"],
          } as never,
        ]}
        initialValue={{ ...emptyComposerState(), environmentIds: ["env-1"] }}
      />,
    );

    expect(screen.queryByTestId("strip-collapse-hint")).toBeNull();
  });

  it("names the models pill after the selected client's default model", () => {
    render(
      <Harness
        slots={["clients", "models"]}
        initialValue={{
          ...emptyComposerState(),
          stack: {
            ...emptyComposerState().stack,
            hostIds: ["host-1"],
          },
        }}
      />,
    );

    expect(screen.getByTestId("strip-models-picker")).toHaveTextContent("GPT-4");
  });
});

/**
 * A slot a surface refuses to let anyone change — User Testing locks the
 * client and the servers once a study has results, because repointing it
 * would leave those results answering a setup that no longer exists.
 */
describe("EnvironmentComposer locked slots", () => {
  beforeEach(() => {
    flagState.skills = false;
    flagState.computers = false;
    flagState.environments = true;
    toastError.mockClear();
  });

  it("answers a press on a locked pill with its reason", () => {
    // The whole point of the wrapper: a plain disabled control dispatches no
    // click, so someone who does not know the rule presses it and gets
    // silence.
    render(
      <Harness lockedSlots={{ clients: "This study already has sessions." }} />,
    );

    fireEvent.click(screen.getByTestId("strip-clients-picker"));

    expect(toastError).toHaveBeenCalledWith("This study already has sessions.");
    expect(screen.getByTestId("strip-clients-picker")).toBeDisabled();
  });

  it("locks each slot on its own", () => {
    render(<Harness lockedSlots={{ servers: "Servers are fixed." }} />);

    expect(screen.getByTestId("strip-servers-picker")).toBeDisabled();
    // The client stays editable: one lock is not a reason to freeze the strip.
    expect(screen.getByTestId("strip-clients-picker")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("strip-clients-picker"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("locks the environment picker too — it re-seeds the other two", () => {
    // Caught in review: picking a saved environment reseeds `hostIds` and
    // `serverAttachmentId`, so a lock that skipped this pill locked nothing.
    render(
      <Harness
        environments={[]}
        lockedSlots={{
          clients: "This study already has sessions.",
          servers: "This study already has sessions.",
          environments: "This study already has sessions.",
        }}
      />,
    );

    expect(screen.getByTestId("strip-environments-picker")).toBeDisabled();

    fireEvent.click(screen.getByTestId("strip-environments-picker"));

    expect(toastError).toHaveBeenCalledWith("This study already has sessions.");
  });

  it("answers a locked pill from the keyboard as well as the mouse", () => {
    render(<Harness lockedSlots={{ clients: "Locked." }} />);

    const wrapper = screen.getByTestId("strip-clients-picker").parentElement!;
    fireEvent.keyDown(wrapper, { key: "Enter" });

    expect(toastError).toHaveBeenCalledWith("Locked.");
  });

  it("does not nest the wrapper inside or around another button", () => {
    // `button > button` is invalid HTML and two interactive roles for a screen
    // reader to reconcile. The wrapper carries the role on a span instead.
    render(<Harness lockedSlots={{ clients: "Locked." }} />);

    const wrapper = screen.getByTestId("strip-clients-picker").parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper).toHaveAttribute("role", "button");
    expect(wrapper.closest("button")).toBeNull();
  });

  it("leaves an unlocked strip alone", () => {
    render(<Harness />);

    expect(screen.getByTestId("strip-clients-picker")).not.toBeDisabled();
    expect(screen.getByTestId("strip-servers-picker")).not.toBeDisabled();
  });
});
