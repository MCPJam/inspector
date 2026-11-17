import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ copyWorks: false }));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: async () => state.copyWorks,
}));
vi.mock("@/lib/PosthogUtils", () => ({ detectPlatform: () => "mac" }));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

import { StartupDiagnostics } from "../StartupDiagnostics";
import type { StartupStatus } from "@/lib/startup-status";

const status: StartupStatus = {
  escalated: true,
  stage: "app_load/session_refresh_failed",
  failureKind: "transient",
  refusalReason: null,
  retrying: false,
};

describe("StartupDiagnostics", () => {
  beforeEach(() => {
    state.copyWorks = false;
  });

  it("opens the copyable text when the clipboard refuses, and Hide details still closes it", async () => {
    render(<StartupDiagnostics status={status} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    const text = await screen.findByLabelText("Startup diagnostics");
    expect((text as HTMLTextAreaElement).value).toContain(
      "Startup stage: app_load/session_refresh_failed",
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Startup diagnostics")).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });

  it("confirms a successful copy without opening the details", async () => {
    state.copyWorks = true;
    render(<StartupDiagnostics status={status} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });
});
