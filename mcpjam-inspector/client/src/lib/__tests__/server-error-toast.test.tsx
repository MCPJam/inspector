import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { Toaster } from "@mcpjam/design-system/sonner";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import { toastServerConnectionFailure } from "../server-error-toast";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

const copyMock = vi.mocked(copyToClipboard);

beforeEach(() => {
  copyMock.mockClear();
  copyMock.mockResolvedValue(true);
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("toastServerConnectionFailure", () => {
  it("puts the server in the title and the failure under it", async () => {
    // One colon-spliced line made the server name and the failure compete for
    // the same weight, with the error icon aligned against neither.
    render(<Toaster />);

    toastServerConnectionFailure("Excalidraw (App)", "Request failed (500)");

    expect(await screen.findByText("Excalidraw (App)")).toBeInTheDocument();
    expect(screen.getByText("Request failed (500)")).toBeInTheDocument();
  });

  it("keeps a message that already names the server on one line", async () => {
    render(<Toaster />);
    const message =
      'MCP server "champions" doesn\'t support MCP protocol version 2026-07-28.';

    toastServerConnectionFailure("champions", message);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("copies the whole failure, server name included", async () => {
    // The toast is gone in seconds; the developer wants it in their agent.
    render(<Toaster />);

    toastServerConnectionFailure("Excalidraw (App)", "Request failed (500)");
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith(
        "Excalidraw (App): Request failed (500)",
      ),
    );
    expect(await screen.findByText("Error copied")).toBeInTheDocument();
  });

  it("says so when the clipboard refuses", async () => {
    copyMock.mockResolvedValue(false);
    render(<Toaster />);

    toastServerConnectionFailure("Excalidraw (App)", "Request failed (500)");
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText("Could not copy the error"),
    ).toBeInTheDocument();
  });

  it("carries a caller's own action instead of Copy", async () => {
    // Sonner allows one action. A toast that can fix the failure — "Change
    // protocol version" — outranks copying it.
    const onClick = vi.fn();
    render(<Toaster />);

    toastServerConnectionFailure("champions", "Pinned version unsupported", {
      action: { label: "Change protocol version", onClick },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Change protocol version" }),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Copy" }),
    ).not.toBeInTheDocument();
  });
});
