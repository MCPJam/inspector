import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describeAsSlug, type NormalizedError } from "@mcpjam/sdk/browser";
import { ErrorCard } from "../error-card";
import { FeedbackReporterProvider } from "@/components/support/FeedbackReporterContext";

vi.mock("@/hooks/useSendPlatformFeedback", () => ({
  useSendPlatformFeedback: () => vi.fn(),
}));

function platformFault(
  overrides: Partial<NormalizedError> = {},
): NormalizedError {
  return {
    ...describeAsSlug("internal/unknown", new Error("Request failed (500)")),
    origin: "mcpjam",
    requestId: "req_0123456789abcdef",
    rawCode: "INTERNAL_ERROR",
    ...overrides,
  };
}

function openTechnical() {
  fireEvent.click(screen.getByText("Show details"));
  fireEvent.click(screen.getByTestId("error-card-technical-toggle"));
}

describe("ErrorCard report link", () => {
  it("opens the Send feedback form prefilled with the request id and code", () => {
    render(
      <FeedbackReporterProvider enabled>
        <ErrorCard error={platformFault()} />
      </FeedbackReporterProvider>,
    );
    openTechnical();
    fireEvent.click(screen.getByTestId("error-card-report"));

    expect(screen.getByTestId("send-feedback-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("send-feedback-request-id")).toHaveTextContent(
      "req_0123456789abcdef",
    );
    expect(screen.getByLabelText("Something is broken")).toBeChecked();
  });

  it("is absent outside an enabled provider", () => {
    // The bare render every other error-card test does: no provider, no
    // Convex client, and so no link.
    const { unmount } = render(<ErrorCard error={platformFault()} />);
    openTechnical();
    expect(screen.queryByTestId("error-card-report")).toBeNull();
    unmount();

    render(
      <FeedbackReporterProvider enabled={false}>
        <ErrorCard error={platformFault()} />
      </FeedbackReporterProvider>,
    );
    openTechnical();
    expect(screen.queryByTestId("error-card-report")).toBeNull();
  });

  it("is absent for a failure that is not MCPJam's own", () => {
    render(
      <FeedbackReporterProvider enabled>
        <ErrorCard error={platformFault({ origin: "user_server" })} />
      </FeedbackReporterProvider>,
    );
    openTechnical();
    expect(screen.queryByTestId("error-card-report")).toBeNull();
  });
});
