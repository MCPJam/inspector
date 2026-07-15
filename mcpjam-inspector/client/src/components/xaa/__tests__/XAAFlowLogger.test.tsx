import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAAFlowLogger } from "../XAAFlowLogger";
import { createInitialXAAFlowState } from "@/lib/xaa/types";
import { getXAAStepInfo } from "@/lib/xaa/step-metadata";

const copyToClipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard }));

// Only unstub globals between tests — NOT restoreAllMocks, which would reset
// the shared ResizeObserver mock that the dropdown menu's positioning needs.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderLogger(
  actions: Partial<React.ComponentProps<typeof XAAFlowLogger>["actions"]> = {}
) {
  const onContinue = vi.fn();
  const onRunAll = vi.fn();
  const view = render(
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
    />
  );
  return { onContinue, onRunAll, ...view };
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

    await user.click(screen.getByRole("button", { name: /more run options/i }));
    await user.click(screen.getByRole("menuitem", { name: /run all/i }));

    expect(onRunAll).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("shows a running state and disables the primary action mid-run", () => {
    renderLogger({ isRunningAll: true });

    expect(screen.getByText("Running")).toBeInTheDocument();
    // The primary button is the one carrying the spinner label.
    expect(screen.getByRole("button", { name: /running/i })).toBeDisabled();
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
      />
    );

    expect(screen.getByText("Client ID")).toBeInTheDocument();
    expect(screen.getByText("client_bc147d46f04cb865")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("mcp.access")).toBeInTheDocument();
  });

  it("copies the complete XAA flow", async () => {
    const user = userEvent.setup();
    render(
      <XAAFlowLogger
        flowState={createInitialXAAFlowState({
          serverUrl: "https://mcp.example.com",
          currentStep: "received_resource_metadata",
          negativeTestMode: "valid",
          infoLogs: [
            {
              id: "resource-metadata",
              step: "received_resource_metadata",
              label: "Resource metadata received",
              data: { authorization_servers: ["https://auth.example.com"] },
              timestamp: 1,
              level: "info",
            },
          ],
          httpHistory: [
            {
              step: "discover_resource_metadata",
              timestamp: 0,
              request: {
                method: "GET",
                url: "https://mcp.example.com/.well-known/oauth-protected-resource",
                headers: {},
              },
              response: {
                status: 200,
                statusText: "OK",
                headers: { "content-type": "application/json" },
                body: { resource: "https://mcp.example.com" },
              },
            },
          ],
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
          clientId: "test-client",
        }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = copyToClipboard.mock.calls[0][0];
    expect(copied).toContain("=== XAA Debugger - Flow ===");
    expect(copied).toContain("Client ID: test-client");
    expect(copied).toContain(
      "GET https://mcp.example.com/.well-known/oauth-protected-resource"
    );
    expect(copied).toContain("Resource metadata received");
    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("restarts the copied label timer and clears it on unmount", async () => {
    const user = userEvent.setup();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderLogger();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(screen.getByRole("button", { name: "Copied!" }));

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("shows a copy error and clears it on a successful retry", async () => {
    const user = userEvent.setup();
    copyToClipboard.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderLogger();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      screen.getByRole("button", { name: "Copy failed" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy failed" }));
    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("copies only the selected XAA step", async () => {
    const user = userEvent.setup();
    copyToClipboard.mockClear();
    render(
      <XAAFlowLogger
        flowState={createInitialXAAFlowState({
          serverUrl: "https://mcp.example.com",
          currentStep: "received_resource_metadata",
          infoLogs: [
            {
              id: "resource-metadata",
              step: "received_resource_metadata",
              label: "Resource metadata received",
              data: { authorization_servers: ["https://auth.example.com"] },
              timestamp: 1,
              level: "info",
            },
            {
              id: "other-step",
              step: "jwt_bearer_request",
              label: "JWT bearer request",
              data: { method: "POST" },
              timestamp: 2,
              level: "info",
            },
          ],
        })}
        hasProfile
        actions={{
          onConfigure: vi.fn(),
          onReset: vi.fn(),
          onContinue: vi.fn(),
          continueLabel: "Continue",
        }}
        summary={{ serverUrl: "https://mcp.example.com" }}
      />
    );

    await user.click(screen.getAllByRole("button", { name: "Copy step" })[0]);

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = copyToClipboard.mock.calls[0][0];
    expect(copied).toContain("Resource metadata received");
    expect(copied).not.toContain("JWT bearer request");
  });
});

describe("XAAFlowLogger request/response cards", () => {
  const JWT_BEARER_EXCHANGE = {
    step: "jwt_bearer_request" as const,
    timestamp: 1,
    duration: 40,
    request: {
      method: "POST",
      url: "https://auth.example.com/token",
      headers: { "Content-Type": "application/json" },
      body: { scope: "mcp.access" },
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { token_type: "Bearer" },
    },
  };

  function renderWithExchange(
    overrides: Partial<Parameters<typeof createInitialXAAFlowState>[0]> = {}
  ) {
    return render(
      <XAAFlowLogger
        flowState={createInitialXAAFlowState({
          serverUrl: "https://mcp.example.com",
          currentStep: "received_access_token",
          httpHistory: [JWT_BEARER_EXCHANGE],
          ...overrides,
        })}
        hasProfile
        actions={{
          onConfigure: vi.fn(),
          onReset: vi.fn(),
          onContinue: vi.fn(),
          continueLabel: "Continue",
        }}
        summary={{ serverUrl: "https://mcp.example.com" }}
      />
    );
  }

  async function expandStep(
    user: ReturnType<typeof userEvent.setup>,
    step: Parameters<typeof getXAAStepInfo>[0]
  ) {
    const title = getXAAStepInfo(step).title;
    await user.click(
      screen.getByRole("button", { name: new RegExp(title, "i") })
    );
  }

  it("renders the response on the received card once the exchange completes", async () => {
    const user = userEvent.setup();
    renderWithExchange();

    // received_access_token (current step) is auto-expanded; expand the
    // request card too so both halves are visible.
    await expandStep(user, "jwt_bearer_request");

    // The request card shows the request half with a deferred-response hint.
    expect(screen.getByText("response → next step")).toBeInTheDocument();
    // The status renders exactly once — on the received card's response item.
    expect(screen.getAllByText("200")).toHaveLength(1);
    // Both halves show the method/url context line.
    expect(screen.getAllByText("POST")).toHaveLength(2);
  });

  it("shows the response on the next card while parked at the request step", async () => {
    renderWithExchange({ currentStep: "jwt_bearer_request" });
    // Current step auto-expands; the request half renders in place and the
    // completed response is parked on the collapsed received card.
    expect(screen.getByText("response → next step")).toBeInTheDocument();
    expect(screen.queryByText("Status: 200 OK")).not.toBeInTheDocument();
    expect(screen.getAllByText("POST")).toHaveLength(1);
  });

  it("keeps a terminal negative-rejected exchange whole at jwt_bearer_request", () => {
    renderWithExchange({
      currentStep: "jwt_bearer_request",
      negativeTestMode: "bad_signature",
      negativeProbe: { outcome: "rejected", status: 400 },
    });
    expect(screen.getByText("response → next step")).toBeInTheDocument();
    expect(screen.queryByText("Status: 200 OK")).not.toBeInTheDocument();
  });
});
