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
vi.mock("@/components/hosts/server-picker", () => ({
  // Gated the way the real trigger gates it: a clear is offered only when the
  // caller accepts no selection AND there is one to drop.
  ServerPicker: ({
    triggerTestId,
    value,
    onClearSelection,
  }: {
    triggerTestId?: string;
    value?: string | null;
    onClearSelection?: () => void;
  }) => (
    <div data-testid={triggerTestId ?? "server-group-picker"}>
      {onClearSelection && value ? (
        <button
          type="button"
          data-testid="servers-picker-clear"
          onClick={onClearSelection}
        />
      ) : null}
    </div>
  ),
}));
vi.mock("@/components/project-environments/environment-picker", () => ({
  EnvironmentPicker: ({ triggerTestId }: { triggerTestId?: string }) => (
    <button type="button" data-testid={triggerTestId}>
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
  serverOptional,
}: {
  slots?: Parameters<typeof EnvironmentComposer>[0]["slots"];
  environments?: Parameters<typeof EnvironmentComposer>[0]["environments"];
  initialValue?: EnvironmentComposerState;
  serverOptional?: boolean;
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
      serverOptional={serverOptional}
    />
  );
}

function withServer(): EnvironmentComposerState {
  const seeded = emptyComposerState();
  return {
    ...seeded,
    stack: { ...seeded.stack, serverAttachmentId: "att_1" },
  };
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

  it("can put the servers slot back to the client default", () => {
    // The slot is optional by default, and the picker only offers a way out
    // when the caller supplies one. Without this the strip is a one-way door.
    render(<Harness slots={["servers"]} initialValue={withServer()} />);

    fireEvent.click(screen.getByTestId("servers-picker-clear"));

    expect(screen.getByTestId("strip-servers-picker")).toBeVisible();
    expect(screen.queryByTestId("servers-picker-clear")).toBeNull();
  });

  it("offers no way out where the surface requires a server", () => {
    // Evals create gates submit on `hasServer`. A clear there empties a field
    // the form will not accept, so the user has to re-pick to get back.
    render(
      <Harness
        slots={["servers"]}
        initialValue={withServer()}
        serverOptional={false}
      />,
    );

    expect(screen.getByTestId("strip-servers-picker")).toBeVisible();
    expect(screen.queryByTestId("servers-picker-clear")).toBeNull();
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
