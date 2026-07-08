import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAAFlowLogger } from "../XAAFlowLogger";
import { createInitialXAAFlowState } from "@/lib/xaa/types";

// Only unstub globals between tests — NOT restoreAllMocks, which would reset
// the shared ResizeObserver mock that the dropdown menu's positioning needs.
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLogger(
  actions: Partial<React.ComponentProps<typeof XAAFlowLogger>["actions"]> = {},
) {
  const onContinue = vi.fn();
  const onRunAll = vi.fn();
  render(
    <XAAFlowLogger
      flowState={createInitialXAAFlowState({
        serverUrl: "https://mcp.example.com",
        currentStep: "received_id_jag",
      })}
      hasProfile
      actions={{
        onConfigure: vi.fn(),
        onReset: vi.fn(),
        onContinue,
        onRunAll,
        continueLabel: "Continue",
        ...actions,
      }}
      summary={{ serverUrl: "https://mcp.example.com" }}
    />,
  );
  return { onContinue, onRunAll };
}

describe("XAAFlowLogger run controls", () => {
  it("runs the next step when the primary split button is clicked", async () => {
    const user = userEvent.setup();
    const { onContinue, onRunAll } = renderLogger();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onRunAll).not.toHaveBeenCalled();
  });

  it("runs the whole flow from the split button's menu", async () => {
    const user = userEvent.setup();
    const { onContinue, onRunAll } = renderLogger();

    await user.click(
      screen.getByRole("button", { name: /more run options/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /run all/i }));

    expect(onRunAll).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("shows a running state and disables the primary action mid-run", () => {
    renderLogger({ isRunningAll: true });

    expect(screen.getByText("Running")).toBeInTheDocument();
    // The primary button is the one carrying the spinner label.
    expect(
      screen.getByRole("button", { name: /running/i }),
    ).toBeDisabled();
  });

  it("labels client id and scope in the run bar", () => {
    render(
      <XAAFlowLogger
        flowState={createInitialXAAFlowState({
          serverUrl: "https://mcp.example.com",
          currentStep: "received_id_jag",
        })}
        hasProfile
        actions={{
          onConfigure: vi.fn(),
          onReset: vi.fn(),
          onContinue: vi.fn(),
          continueLabel: "Continue",
        }}
        summary={{
          serverUrl: "https://mcp.example.com",
          clientId: "client_bc147d46f04cb865",
          scope: "mcp.access",
        }}
      />,
    );

    expect(screen.getByText("Client ID")).toBeInTheDocument();
    expect(screen.getByText("client_bc147d46f04cb865")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("mcp.access")).toBeInTheDocument();
  });
});
