import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describeAsSlug, type NormalizedError } from "@mcpjam/sdk/browser";
import { copyToClipboard } from "@/lib/clipboard";
import { ErrorCard } from "../error-card";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

const copyMock = vi.mocked(copyToClipboard);

function base(): NormalizedError {
  return describeAsSlug("internal/unknown", new Error("Request failed (500)"));
}

const openDetails = () => fireEvent.click(screen.getByText("Show details"));
const openTechnical = () =>
  fireEvent.click(screen.getByTestId("error-card-technical-toggle"));

describe("ErrorCard technical details", () => {
  beforeEach(() => {
    copyMock.mockClear();
    copyMock.mockResolvedValue(true);
  });

  it("keeps the technical block behind its own disclosure", () => {
    render(
      <ErrorCard
        error={{ ...base(), errorType: "WebApiError", requestId: "req-123" }}
      />,
    );
    openDetails();

    // The toggle is offered, but nothing inside it is rendered yet.
    expect(screen.getByTestId("error-card-technical-toggle")).toBeTruthy();
    expect(screen.queryByTestId("error-card-technical-panel")).toBeNull();
    expect(screen.queryByText("req-123")).toBeNull();
  });

  it("reveals the type, request id and stack on expand", () => {
    render(
      <ErrorCard
        error={{
          ...base(),
          errorType: "TypeError",
          requestId: "req-abc",
          stack: "TypeError: boom\n    at doThing (app.ts:12:3)",
        }}
      />,
    );
    openDetails();
    openTechnical();

    expect(screen.getByTestId("error-card-technical-panel")).toBeTruthy();
    expect(screen.getByText("TypeError")).toBeTruthy();
    expect(screen.getByText("req-abc")).toBeTruthy();
    expect(
      screen.getByText(/at doThing \(app\.ts:12:3\)/, { exact: false }),
    ).toBeTruthy();
  });

  /**
   * The hosted-5xx shape, and the reason this disclosure exists. The backend
   * attaches its cause non-enumerably so a stack never reaches a JSON body —
   * so for the errors users most want to report, the request id IS the
   * diagnostic.
   */
  it("says a stack is missing rather than rendering an empty panel", () => {
    render(
      <ErrorCard
        error={{ ...base(), errorType: "WebApiError", requestId: "req-xyz" }}
      />,
    );
    openDetails();
    openTechnical();

    expect(screen.getByText(/No stack trace was reported/)).toBeTruthy();
    expect(screen.getByText("req-xyz")).toBeTruthy();
  });

  it("offers no technical disclosure when there is nothing technical to show", () => {
    render(<ErrorCard error={base()} />);
    openDetails();

    expect(screen.queryByTestId("error-card-technical-toggle")).toBeNull();
  });

  /**
   * The disclosure has to be reachable when the technical fields are the ONLY
   * detail — otherwise a bare 500 renders a card with no way in at all.
   */
  it("opens the details panel for an error whose only detail is technical", () => {
    render(<ErrorCard error={{ ...base(), requestId: "req-only" }} />);
    openDetails();
    openTechnical();

    expect(screen.getByText("req-only")).toBeTruthy();
  });

  it("copies the technical fields without expanding anything", async () => {
    render(
      <ErrorCard
        error={{
          ...base(),
          errorType: "WebApiError",
          requestId: "req-copy",
          stack: "WebApiError: nope\n    at webPost (base.ts:89:11)",
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("error-card-copy"));

    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
    const payload = copyMock.mock.calls[0]?.[0] as string;
    expect(payload).toContain("Type: WebApiError");
    expect(payload).toContain("Request ID: req-copy");
    expect(payload).toContain("Stack trace:");
    expect(payload).toContain("at webPost (base.ts:89:11)");
  });
});
