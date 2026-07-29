/**
 * The shared controlled `EnvironmentPicker`.
 *
 * The archived/orphan detach-only behavior is covered by
 * `orphan-selections.test.tsx` through the suite wrapper. This file covers what
 * extraction ADDED: the controlled contract (the component never persists) and
 * single-select mode, which the Playground will use in Phase 2.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnvironments } = vi.hoisted(() => ({
  mockEnvironments: { value: [] as unknown[] },
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mockEnvironments.value,
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { environments: "/environments" },
}));

import { EnvironmentPicker } from "../environment-picker";

function env(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    environmentId: id,
    projectId: "p_1",
    name,
    hostId: "h_1",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnvironments.value = [env("env_1", "Staging"), env("env_2", "Prod")];
});

describe("EnvironmentPicker — controlled contract", () => {
  it("reports selection to the caller and persists nothing itself", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentPicker projectId="p_1" value={[]} onChange={onChange} multi />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Staging"));

    // The component is pure presentation: it emits the next value and leaves
    // persistence entirely to the caller.
    expect(onChange).toHaveBeenCalledWith(["env_1"]);
  });

  it("appends in click order, because order IS run order", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={["env_2"]}
        onChange={onChange}
        multi
      />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Staging"));
    expect(onChange).toHaveBeenCalledWith(["env_2", "env_1"]);
  });

  it("blocks selection past the cap without emitting", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={["env_2"]}
        onChange={onChange}
        multi
        max={1}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Staging"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("EnvironmentPicker — single-select mode", () => {
  it("emits a bare id, not an array", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={null}
        onChange={onChange}
        multi={false}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Staging"));
    expect(onChange).toHaveBeenCalledWith("env_1");
  });

  it("replaces rather than appends", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={"env_2"}
        onChange={onChange}
        multi={false}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Staging"));
    expect(onChange).toHaveBeenCalledWith("env_1");
  });

  it("emits null when the current selection is unchecked", () => {
    const onChange = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={"env_1"}
        onChange={onChange}
        multi={false}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Staging"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows no run-order ordinals — there is no order with one selection", () => {
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={"env_1"}
        onChange={vi.fn()}
        multi={false}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("1")).toBeNull();
  });
});

describe("EnvironmentPicker — archived rows stay detach-only", () => {
  it("never offers an archived environment for NEW selection", () => {
    // Archived rows appear only when already selected; an unselected archived
    // environment must not be attachable.
    mockEnvironments.value = [
      env("env_1", "Staging"),
      env("env_arch", "Retired", { archivedAt: 123 }),
    ];
    const onChange = vi.fn();
    render(
      <EnvironmentPicker projectId="p_1" value={[]} onChange={onChange} multi />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByLabelText("Retired")).toBeNull();
    expect(screen.queryByLabelText("Retired (archived)")).toBeNull();
  });

  it("renders a selected archived environment so it can be detached", () => {
    mockEnvironments.value = [
      env("env_1", "Staging"),
      env("env_arch", "Retired", { archivedAt: 123 }),
    ];
    const onChange = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={["env_arch"]}
        onChange={onChange}
        multi
      />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Retired (archived)"));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
