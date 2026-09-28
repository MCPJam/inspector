import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return hosted.value;
  },
}));

// The two faces are stubbed — this suite is about which one the wrapper picks
// and whether the toggle shows, not their internals.
vi.mock("../ComputerView", () => ({
  ComputerView: (props: {
    projectId: string | null;
    isSignedInMember: boolean | undefined;
  }) => (
    <div
      data-testid="cloud-face"
      data-project={String(props.projectId)}
      data-member={String(props.isSignedInMember)}
    />
  ),
}));
vi.mock("../LocalComputerView", () => ({
  LocalComputerView: (props: { projectId: string }) => (
    <div data-testid="local-face" data-project={props.projectId} />
  ),
}));

const engineState = vi.hoisted(() => ({
  value: {
    engine: "cloud" as "local" | "cloud",
    selectedEngine: "cloud" as "local" | "cloud",
    setEngine: vi.fn(),
    resolved: true,
    localAvailable: true,
    localTerminalAvailable: false,
    workspaceDisplayRoot: "~/.mcpjam/computer",
    cloudAvailable: true,
    toggleVisible: true,
    consent: { status: "absent", granted: false, token: null, grant: vi.fn(), revoke: vi.fn() },
  },
}));
vi.mock("@/hooks/useComputerEngine", () => ({
  useComputerEngine: () => engineState.value,
}));

import { ComputerTabView } from "../ComputerTabView";

describe("ComputerTabView", () => {
  beforeEach(() => {
    hosted.value = false;
    engineState.value.selectedEngine = "cloud";
    engineState.value.toggleVisible = true;
    engineState.value.setEngine = vi.fn();
  });

  it("hosted: always the cloud face, no toggle", () => {
    hosted.value = true;
    engineState.value.selectedEngine = "local"; // ignored hosted
    render(<ComputerTabView projectId="p1" isSignedInMember />);
    expect(screen.getByTestId("cloud-face")).toBeInTheDocument();
    expect(screen.queryByTestId("local-face")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: /Computer engine/i }),
    ).not.toBeInTheDocument();
  });

  it("non-member: cloud face (it owns the sign-in state), no toggle", () => {
    engineState.value.selectedEngine = "local";
    render(<ComputerTabView projectId="p1" isSignedInMember={false} />);
    const cloud = screen.getByTestId("cloud-face");
    expect(cloud.dataset.member).toBe("false");
    expect(screen.queryByTestId("local-face")).not.toBeInTheDocument();
  });

  /**
   * The local face is member-only too, so the unresolved actor takes the cloud
   * branch — and the tri-state has to reach `ComputerView` intact, because it
   * owns the "not resolved yet" pane and the sign-in prompt is the wrong
   * answer for a member whose identity has simply not landed.
   */
  it("unresolved actor: cloud face with the third state passed through", () => {
    engineState.value.selectedEngine = "local";
    render(<ComputerTabView projectId="p1" isSignedInMember={undefined} />);
    const cloud = screen.getByTestId("cloud-face");
    expect(cloud.dataset.member).toBe("undefined");
    expect(screen.queryByTestId("local-face")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /This machine/i }),
    ).not.toBeInTheDocument();
  });

  it("no synced project: cloud face (owns the no-project empty state)", () => {
    engineState.value.selectedEngine = "local";
    render(<ComputerTabView projectId={null} isSignedInMember />);
    expect(screen.getByTestId("cloud-face")).toBeInTheDocument();
  });

  it("signed-in member, selectedEngine local → local face", () => {
    engineState.value.selectedEngine = "local";
    render(<ComputerTabView projectId="p1" isSignedInMember />);
    expect(screen.getByTestId("local-face")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-face")).not.toBeInTheDocument();
  });

  it("signed-in member, selectedEngine cloud → cloud face", () => {
    render(<ComputerTabView projectId="p1" isSignedInMember />);
    expect(screen.getByTestId("cloud-face")).toBeInTheDocument();
  });

  it("shows the Local⇄Cloud toggle only when both engines exist", () => {
    render(<ComputerTabView projectId="p1" isSignedInMember />);
    expect(
      screen.getByRole("button", { name: /This machine/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cloud/i })).toBeInTheDocument();
  });

  it("hides the toggle when only one engine is available", () => {
    engineState.value.toggleVisible = false;
    render(<ComputerTabView projectId="p1" isSignedInMember />);
    expect(
      screen.queryByRole("button", { name: /This machine/i }),
    ).not.toBeInTheDocument();
  });

  it("the toggle persists the picked engine", () => {
    render(<ComputerTabView projectId="p1" isSignedInMember />);
    fireEvent.click(screen.getByRole("button", { name: /This machine/i }));
    expect(engineState.value.setEngine).toHaveBeenCalledWith("local");
  });
});
