import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { CaptureBanner, describeCaptureContext } from "../CaptureBanner";
import { formatEvidenceTime } from "../feature-states";
import { CAPTURED_AT, CTX_A, CTX_B } from "./fixtures";

function renderBanner(props: Partial<ComponentProps<typeof CaptureBanner>> = {}) {
  const handlers = {
    onSelectContext: vi.fn(),
    onRefresh: vi.fn(),
    onRunChecks: vi.fn(),
    onConnect: vi.fn(),
  };
  render(
    <CaptureBanner
      status="connected"
      capturedAt={CAPTURED_AT}
      probeFailures={[]}
      contexts={[]}
      refresh={{ status: "idle" }}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("CaptureBanner", () => {
  it("prompts to connect a server that was never connected", () => {
    const handlers = renderBanner({ status: "never", capturedAt: undefined });
    expect(
      screen.getByText(
        "This server has not been connected yet. Connect it to check its features.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("shows the saved evidence's capture time while disconnected", () => {
    renderBanner({ status: "disconnected" });
    expect(
      screen.getByText(
        `Disconnected. Showing what was saved on ${formatEvidenceTime(CAPTURED_AT)}.`,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the last good capture and names the failed attempt separately", () => {
    renderBanner({
      latestAttempt: { status: "failed", at: CAPTURED_AT + 60_000, error: "capture_failed" },
    });
    expect(
      screen.getByText(`Captured ${formatEvidenceTime(CAPTURED_AT)}.`),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      `The capture on ${formatEvidenceTime(CAPTURED_AT + 60_000)} failed. Refresh to try again.`,
    );
  });

  it("puts known failure codes into words and leaves any other text out", () => {
    renderBanner({
      latestAttempt: { status: "partial", at: CAPTURED_AT + 60_000, error: "list_failed" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      `The capture on ${formatEvidenceTime(CAPTURED_AT + 60_000)} was incomplete because one of the server's lists did not load. Refresh to try again.`,
    );
    cleanup();
    renderBanner({
      latestAttempt: { status: "failed", at: CAPTURED_AT + 60_000, error: "upstream said 500" },
    });
    expect(screen.getByRole("status")).not.toHaveTextContent("upstream");
  });

  it("says a first capture failed and how to try again", () => {
    const at = CAPTURED_AT + 60_000;
    renderBanner({
      capturedAt: undefined,
      latestAttempt: { status: "failed", at, error: "capture_failed" },
    });
    expect(
      screen.getByText("Nothing was saved for this server."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      `The capture on ${formatEvidenceTime(at)} failed. Refresh to try again.`,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    cleanup();
    renderBanner({
      status: "disconnected",
      capturedAt: undefined,
      latestAttempt: { status: "failed", at },
    });
    expect(
      screen.getByText(
        "Server disconnected. Nothing was saved. Reconnect it to capture its features.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      `The capture on ${formatEvidenceTime(at)} failed. Connect to try again.`,
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("lists failed background probes", () => {
    renderBanner({
      probeFailures: [
        { probeId: "server-card", status: "failed", at: CAPTURED_AT },
        { probeId: "skills", status: "skipped", at: CAPTURED_AT },
      ],
    });
    expect(
      screen.getByText(
        "Background checks failed for Server Card. Refresh to try them again.",
      ),
    ).toBeInTheDocument();
  });

  it("offers a context picker when evidence exists for several contexts", () => {
    renderBanner({
      contexts: [
        {
          contextHash: CTX_A,
          context: { transport: "streamable-http", protocolVersion: "2025-11-25" },
        },
        {
          contextHash: CTX_B,
          context: { transport: "streamable-http", protocolVersion: "2026-07-28" },
        },
      ],
      selectedContextHash: CTX_A,
    });
    expect(
      screen.getByRole("combobox", { name: "Showing evidence for" }),
    ).toHaveTextContent("2025-11-25 · Streamable HTTP");
    expect(
      screen.getByText("Evidence from different contexts is never combined."),
    ).toBeInTheDocument();
  });

  it("starts Refresh and Run checks", () => {
    const handlers = renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(handlers.onRefresh).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect(handlers.onRunChecks).toHaveBeenCalled();
  });

  it("disables Refresh while it runs", () => {
    renderBanner({ refresh: { status: "running" } });
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  });

  it("says why Refresh failed", () => {
    renderBanner({
      refresh: { status: "failed", message: "Could not reach the server." },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not reach the server.",
    );
  });

  it("says when Refresh is turned off", () => {
    renderBanner({ refresh: { status: "disabled" } });
    expect(
      screen.getByText("Refresh is turned off for this account."),
    ).toBeInTheDocument();
  });
});

describe("describeCaptureContext", () => {
  it("names version, transport, client and account", () => {
    expect(
      describeCaptureContext({
        transport: "stdio",
        protocolVersion: "2026-07-28",
        hostProfile: "claude-desktop",
        accountBinding: "acct_1",
      }),
    ).toBe("2026-07-28 · stdio · claude-desktop · connected account");
    expect(describeCaptureContext(undefined)).toBe("No saved context");
  });
});
