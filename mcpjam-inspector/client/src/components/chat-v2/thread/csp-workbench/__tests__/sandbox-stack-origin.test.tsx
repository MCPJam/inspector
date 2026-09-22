/**
 * The Sandbox Stack "View origin" chip.
 *
 * This is the answer to "which origin do I allowlist?" — the question that
 * drove the document.write mount. A developer with a referrer-restricted
 * third-party key (Google Maps, an OAuth redirect URI) reads the value here
 * and pastes it into that provider's allowlist, so the chip must show the
 * view's real origin when there is one and say plainly when there is not,
 * rather than rendering a stale or empty value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { WidgetSandboxApplied } from "@/stores/widget-debug-store";
import { SandboxStackTab } from "../SandboxStackTab";

const copyToClipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard }));

const BASE: WidgetSandboxApplied = {
  permissive: false,
  hostPolicyApplied: false,
};

describe("SandboxStackTab — view origin chip", () => {
  beforeEach(() => {
    copyToClipboard.mockClear();
    copyToClipboard.mockResolvedValue(true);
  });

  it("shows the origin of the view's document URL", () => {
    render(
      <SandboxStackTab
        applied={{
          ...BASE,
          viewMode: "url",
          viewUrl: "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1",
          assignedOrigin: "http://127.0.0.1:6274",
        }}
      />,
    );
    expect(screen.getByText("View origin")).toBeTruthy();
    // The origin, not the full URL: the query string is a cache-buster and
    // allowlists are keyed on the origin.
    expect(screen.getByText("http://127.0.0.1:6274")).toBeTruthy();
  });

  it("copies the origin to the clipboard", async () => {
    render(
      <SandboxStackTab
        applied={{
          ...BASE,
          viewMode: "url",
          assignedOrigin: "https://sandbox.mcpjam.com",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith(
        "https://sandbox.mcpjam.com",
      );
    });
    await waitFor(() => expect(screen.getByText("copied")).toBeTruthy());
  });

  it("says there is no origin when the view fell back to srcdoc", () => {
    render(
      <SandboxStackTab
        applied={{
          ...BASE,
          viewMode: "srcdoc-fallback",
          viewUrl: "about:srcdoc",
        }}
      />,
    );
    expect(screen.getByText("about:srcdoc · no origin")).toBeTruthy();
    // Nothing to copy — offering a button that yields "about:srcdoc" would
    // send the developer to paste a value no allowlist accepts.
    expect(screen.queryByRole("button", { name: "copy" })).toBeNull();
  });

  it("says the same for an explicitly requested srcdoc mount", () => {
    render(<SandboxStackTab applied={{ ...BASE, viewMode: "srcdoc" }} />);
    expect(screen.getByText("about:srcdoc · no origin")).toBeTruthy();
  });

  it("renders no chip before the proxy has reported a mount", () => {
    render(<SandboxStackTab applied={BASE} />);
    expect(screen.queryByText("View origin")).toBeNull();
  });

  it("renders no chip when there is no applied policy at all", () => {
    render(<SandboxStackTab />);
    expect(screen.queryByText("View origin")).toBeNull();
  });
});
