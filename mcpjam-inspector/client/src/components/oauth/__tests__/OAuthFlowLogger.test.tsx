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

describe("OAuthFlowLogger guide steps", () => {
  it("reveals the full summary when a step is expanded", async () => {
    const user = userEvent.setup();
    renderLogger({
      currentStep: "received_resource_metadata",
      infoLogs: [
        {
          id: "request-resource-metadata",
          step: "request_resource_metadata",
          label: "Requesting resource metadata",
          data: {},
          timestamp: 1,
          level: "info",
        },
      ],
    });

    const summary = screen.getByText(
      "The client requests RFC9728 resource metadata to learn which authorization server to use."
    );
    const step = screen.getByRole("button", {
      name: /Request Resource Metadata/i,
    });

    expect(step).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveClass("line-clamp-2");

    await user.click(step);

    expect(step).toHaveAttribute("aria-expanded", "true");
    expect(summary).not.toHaveClass("line-clamp-2");
  });
});

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

  it("copies a shift-selected range of steps together, in flow order, regardless of click order", async () => {
    const user = userEvent.setup();
    copyToClipboard.mockClear();
    renderLogger({
      currentStep: "discovery_start",
      httpHistory: [INITIAL_EXCHANGE],
      infoLogs: [
        {
          id: "discovery-start",
          step: "discovery_start",
          label: "Starting discovery",
          data: {},
          timestamp: 40,
          level: "info",
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "Select step" }));

    const firstCheckbox = screen.getByRole("checkbox", {
      name: /Initial MCP Request/i,
    });
    const middleCheckbox = screen.getByRole("checkbox", {
      name: /401 Unauthorized Received/i,
    });
    const lastCheckbox = screen.getByRole("checkbox", {
      name: /Start Discovery/i,
    });

    // Click the last step first, then shift-click the first step: proves the
    // middle step gets pulled into the range and the copy still comes out in
    // flow order, regardless of the order the steps were clicked in.
    await user.click(lastCheckbox);
    await user.keyboard("{Shift>}");
    await user.click(firstCheckbox);
    await user.keyboard("{/Shift}");

    expect(middleCheckbox).toBeChecked();

    const copyRangeButton = screen.getByRole("button", {
      name: "Copy 3 steps",
    });
    await user.click(copyRangeButton);

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const copied = copyToClipboard.mock.calls[0][0];
    const requestIndex = copied.indexOf("Initial MCP Request");
    const receivedIndex = copied.indexOf("401 Unauthorized Received");
    const discoveryIndex = copied.indexOf("Start Discovery");
    expect(requestIndex).toBeGreaterThan(-1);
    expect(receivedIndex).toBeGreaterThan(requestIndex);
    expect(discoveryIndex).toBeGreaterThan(receivedIndex);
  });
});
