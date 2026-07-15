import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OAuthFlowLogger } from "../OAuthFlowLogger";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
} from "@mcpjam/sdk/browser";

const copyToClipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard }));

// The logger auto-scrolls its guide pane on mount; jsdom has no Element.scrollTo.
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
});

const INITIAL_EXCHANGE = {
  step: "request_without_token" as const,
  timestamp: 1,
  duration: 30,
  request: {
    method: "POST",
    url: "https://mcp.example.com",
    headers: { "Content-Type": "application/json" },
    body: { jsonrpc: "2.0", method: "initialize" },
  },
  response: {
    status: 401,
    statusText: "Unauthorized",
    headers: { "www-authenticate": "Bearer" },
    body: "",
  },
};

function renderLogger(state: Partial<OAuthFlowState>) {
  return render(
    <OAuthFlowLogger
      oauthFlowState={{ ...EMPTY_OAUTH_FLOW_STATE, ...state } as OAuthFlowState}
      onClearLogs={vi.fn()}
      onClearHttpHistory={vi.fn()}
      hasProfile
      summary={{
        label: "Test",
        description: "Test target",
        serverUrl: "https://mcp.example.com",
      }}
      actions={{
        onConfigure: vi.fn(),
        onReset: vi.fn(),
        onContinue: vi.fn(),
        continueLabel: "Continue",
      }}
    />
  );
}

describe("OAuthFlowLogger request/response card split", () => {
  it("splits a reached 401 exchange onto the received_401_unauthorized card", async () => {
    const user = userEvent.setup();
    renderLogger({
      currentStep: "received_401_unauthorized",
      httpHistory: [INITIAL_EXCHANGE],
    });

    // The received card (current step) auto-expands; open the request card too.
    await user.click(
      screen.getByRole("button", { name: /Initial MCP Request/i })
    );

    // Request card shows the request half with the deferred-response hint.
    expect(screen.getByText("response → next step")).toBeInTheDocument();
    // The status renders exactly once — on the received card's response item.
    expect(screen.getAllByText("401")).toHaveLength(1);
    // Both halves carry the method/url context line.
    expect(screen.getAllByText("POST")).toHaveLength(2);
  });

  it("parks a failed token response on the received card", async () => {
    const user = userEvent.setup();
    renderLogger({
      currentStep: "token_request",
      error: "Token exchange failed: invalid_grant",
      httpHistory: [
        {
          step: "token_request",
          timestamp: 5,
          duration: 20,
          request: {
            method: "POST",
            url: "https://auth.example.com/token",
            headers: {},
            body: "grant_type=authorization_code",
          },
          response: {
            status: 400,
            statusText: "Bad Request",
            headers: {},
            body: { error: "invalid_grant" },
          },
        },
      ],
    });

    // Parked at the request step: the request card has only the request, while
    // the completed response is available on the next card.
    expect(screen.getByText("response → next step")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tokens Received/i }));
    expect(screen.getAllByText("400")).toHaveLength(1);
    expect(screen.getAllByText("POST")).toHaveLength(2);
  });

  it("keeps the Raw tab as the full chronological wire log", async () => {
    const user = userEvent.setup();
    renderLogger({
      currentStep: "received_401_unauthorized",
      httpHistory: [INITIAL_EXCHANGE],
    });

    await user.click(screen.getByRole("tab", { name: "Raw" }));

    // Raw keeps chronological detail, but still labels the request and its
    // response as separate debugger steps.
    expect(screen.getByText("response → next step")).toBeInTheDocument();
    expect(screen.getAllByText("request_without_token")).toHaveLength(1);
    expect(screen.getAllByText("received_401_unauthorized")).toHaveLength(1);
    // Status appears on the response item, not the request item.
    expect(screen.getAllByText(/401/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("POST").length).toBeGreaterThanOrEqual(1);
  });

  it("copies only the selected step from the Guide view", async () => {
    const user = userEvent.setup();
    copyToClipboard.mockClear();
    renderLogger({
      currentStep: "received_401_unauthorized",
      httpHistory: [INITIAL_EXCHANGE],
    });

    await user.click(screen.getAllByRole("button", { name: "Copy step" })[0]);

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = copyToClipboard.mock.calls[0][0];
    expect(copied).toContain("Initial MCP Request");
    expect(copied).not.toContain("401 Unauthorized");
    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("copies only the selected step from the Raw view", async () => {
    const user = userEvent.setup();
    copyToClipboard.mockClear();
    renderLogger({
      currentStep: "received_401_unauthorized",
      httpHistory: [INITIAL_EXCHANGE],
    });

    await user.click(screen.getByRole("tab", { name: "Raw" }));
    await user.click(screen.getAllByRole("button", { name: "Copy step" })[0]);

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = copyToClipboard.mock.calls[0][0];
    expect(copied).toContain("request_without_token");
    expect(copied).toContain(
      "Response: recorded under [received_401_unauthorized]"
    );
    expect(copied).not.toContain("401 Unauthorized");
  });
});
