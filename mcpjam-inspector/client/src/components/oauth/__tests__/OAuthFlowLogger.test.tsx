import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OAuthFlowLogger } from "../OAuthFlowLogger";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
} from "@mcpjam/sdk/browser";

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

    // One full entry: no split hint, one status, one method line.
    expect(screen.queryByText("response → next step")).not.toBeInTheDocument();
    // Status appears in the raw timeline badge and the entry header.
    expect(screen.getAllByText(/401/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("POST").length).toBeGreaterThanOrEqual(1);
  });
});
