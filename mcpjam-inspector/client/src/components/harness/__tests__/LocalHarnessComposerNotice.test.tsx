import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalHarnessComposerNotice } from "../LocalHarnessComposerNotice";

describe("local client setup copy", () => {
  it("describes Codex chat without promising unattended runs", () => {
    render(
      <LocalHarnessComposerNotice
        controller={{
          phase: "needs-consent",
          harnessName: "Codex",
          reason: null,
          runtimeStatus: null,
          statusFetchFailed: false,
        }}
        onRetry={vi.fn()}
        onSetup={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Codex");
    expect(screen.getByRole("status")).toHaveTextContent("chat commands");
    expect(screen.getByRole("status")).not.toHaveTextContent(/evals|swarms/);
  });
});
