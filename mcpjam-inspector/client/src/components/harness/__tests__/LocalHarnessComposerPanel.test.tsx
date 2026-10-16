import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalHarnessComposerPanel } from "../LocalHarnessComposerPanel";
const stopAll = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/local-harness-consent", () => ({
  stopAllLocalHarnessSessions: stopAll,
}));
type State = Parameters<typeof LocalHarnessComposerPanel>[0]["controller"];
function state(): State {
  return {
    phase: "ready",
    harnessName: "Codex",
    runtimeStatus: null,
    statusFetchFailed: false,
    reason: null,
    requestedTarget: "local-native",
    revoke: vi.fn(async () => {}),
    refresh: vi.fn(),
    consent: {},
    availability: {
      unattendedGit: { ready: false, message: "Install Git 2.31 or newer." },
    },
  };
}
function show(controller = state(), progress: string | null = null) {
  render(
    <LocalHarnessComposerPanel
      controller={controller}
      progress={progress}
      onSetup={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  return controller;
}

describe("local setup panel", () => {
  beforeEach(() => stopAll.mockReset().mockResolvedValue(true));
  it("shows download, authorization, and the server's Git prerequisite", () => {
    show(state(), "Downloading Codex: 42%");
    expect(
      screen.getByRole("list", { name: "Local setup checklist" }),
    ).toHaveTextContent("42%");
    expect(screen.getByText("Authorization: Allowed")).toBeVisible();
    expect(screen.getByText(/Install Git 2.31/)).toBeVisible();
  });
  it("keeps stored authorization visible while the runtime is installing", () => {
    const controller = state();
    controller.phase = "installing";
    show(controller, "Downloading Codex: 42%");
    expect(screen.getByText("Authorization: Allowed")).toBeVisible();
    expect(screen.getByText("Runtime: Downloading Codex: 42%")).toBeVisible();
  });
  it("stops all sessions and reports refusal without claiming success", async () => {
    stopAll.mockResolvedValueOnce(false);
    show();
    fireEvent.click(
      screen.getByRole("button", { name: "Stop all local sessions" }),
    );
    await waitFor(() => expect(stopAll).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be stopped",
    );
  });
  it("forgets local project authorization and refreshes the controller", async () => {
    const controller = show();
    fireEvent.click(
      screen.getByRole("button", { name: "Forget local access" }),
    );
    await waitFor(() => expect(controller.revoke).toHaveBeenCalledOnce());
    expect(controller.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("reports revocation failures and re-enables the controls", async () => {
    const controller = state();
    vi.mocked(controller.revoke).mockRejectedValueOnce(
      new Error("Try again when connected."),
    );
    show(controller);
    fireEvent.click(
      screen.getByRole("button", { name: "Forget local access" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Local access could not be removed. Try again.",
    );
    expect(
      screen.getByRole("button", { name: "Forget local access" }),
    ).toBeEnabled();
    expect(controller.refresh).not.toHaveBeenCalled();
  });
});
