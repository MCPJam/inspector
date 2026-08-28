/**
 * The shared controlled `EnvironmentPicker`.
 *
 * The archived/orphan detach-only behavior is covered by
 * `orphan-selections.test.tsx` through the suite wrapper. This file covers what
 * extraction ADDED: the controlled contract (the component never persists) and
 * single-select mode, which the Playground will use in Phase 2.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      <EnvironmentPicker
        projectId="p_1"
        value={[]}
        onChange={onChange}
        multi
      />,
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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
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
      <EnvironmentPicker
        projectId="p_1"
        value={[]}
        onChange={onChange}
        multi
      />,
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
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Retired (archived)"));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

/**
 * Ad-hoc rows are machine-minted from a swarm composition and carry no name.
 * They are the reason the picker fetches them at all: a journey's
 * `environmentIds` can point at one, so the trigger has to be able to NAME what
 * is selected — while never letting anyone pick one.
 */
describe("EnvironmentPicker — ad-hoc rows", () => {
  const adhoc = (id: string) =>
    env(id, undefined as unknown as string, { origin: "adhoc" });

  it("never offers an ad-hoc row for selection", () => {
    mockEnvironments.value = [env("env_1", "Staging"), adhoc("env_adhoc")];
    render(
      <EnvironmentPicker projectId="p_1" value={[]} onChange={vi.fn()} multi />,
    );
    fireEvent.click(screen.getByRole("button"));

    // The named row is offerable…
    expect(screen.getByLabelText("Staging")).toBeInTheDocument();
    // …and the ad-hoc one is absent from the list entirely.
    expect(screen.queryByLabelText("Automatic environment")).toBeNull();
  });

  it("still labels a SELECTED ad-hoc row rather than showing the orphan ellipsis", () => {
    mockEnvironments.value = [env("env_1", "Staging"), adhoc("env_adhoc")];
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={["env_adhoc"]}
        onChange={vi.fn()}
        multi
        triggerTestId="picker"
      />,
    );
    // "…" is reserved for an id NO row resolves. An ad-hoc row resolves — it
    // just has no name — so it must read as a real thing.
    expect(screen.getByTestId("picker")).toHaveTextContent(
      "Automatic environment",
    );
    expect(screen.getByTestId("picker")).not.toHaveTextContent("…");
  });

  it("treats a row with no origin and no name as ad-hoc, not as a blank label", () => {
    // Skew: a backend mid-rollout may omit `origin`. Name-presence decides.
    mockEnvironments.value = [
      env("env_x", undefined as unknown as string),
      env("env_1", "Staging"),
    ];
    render(
      <EnvironmentPicker projectId="p_1" value={[]} onChange={vi.fn()} multi />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByLabelText("Staging")).toBeInTheDocument();
    expect(screen.queryByLabelText("Automatic environment")).toBeNull();
  });

  it("renders a caller footer slot above Manage environments", () => {
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={[]}
        onChange={vi.fn()}
        multi
        footerSlot={
          <button type="button" data-testid="picker-footer-action">
            Save as environment
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("picker-footer-action")).toBeInTheDocument();
    expect(screen.getByText("Manage environments →")).toBeInTheDocument();
  });

  // The wrapper that closes the popover once a footer action fires must listen
  // for the CLICK only. Closing on keydown unmounts the button before the
  // browser dispatches its activation click, so Enter/Space would silently do
  // nothing — the reason this pair of cases exists.
  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("runs a footer action activated with %s", async (_label, key) => {
    const onFooterAction = vi.fn();
    render(
      <EnvironmentPicker
        projectId="p_1"
        value={[]}
        onChange={vi.fn()}
        multi
        triggerTestId="picker"
        footerSlot={
          <button
            type="button"
            data-testid="picker-footer-action"
            onClick={onFooterAction}
          >
            Save as environment
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByTestId("picker"));

    const action = screen.getByTestId("picker-footer-action");
    action.focus();
    await userEvent.keyboard(key);

    expect(onFooterAction).toHaveBeenCalledTimes(1);
    // …and the close still happens, just AFTER the action: keyboard activation
    // has to dismiss the popover exactly like a pointer click does.
    await waitFor(() =>
      expect(
        screen.queryByTestId("picker-footer-action"),
      ).not.toBeInTheDocument(),
    );
  });
});
