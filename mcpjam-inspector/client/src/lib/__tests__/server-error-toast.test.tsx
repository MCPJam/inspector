import { ERROR_MESSAGES } from "@/lib/error-messages";
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
  it.each(["server", "connect", "try"])("retains attribution for the name %s even when it appears in generic copy", async (name) => {
    render(<Toaster />);
    toastServerConnectionFailure(name, "Request failed (500)");
    expect(await screen.findByText(name, { exact: true })).toBeInTheDocument();
    expect(screen.getByText(ERROR_MESSAGES.connectionFailed)).toBeInTheDocument();
  });

  it("puts the server in the title and the failure under it", async () => {
    // One colon-spliced line made the server name and the failure compete for
    // the same weight, with the error icon aligned against neither.
    render(<Toaster />);

    toastServerConnectionFailure("Excalidraw (App)", "Request failed (500)");

    expect(await screen.findByText("Excalidraw (App)")).toBeInTheDocument();
    expect(screen.getByText(ERROR_MESSAGES.connectionFailed)).toBeInTheDocument();
    expect(screen.queryByText("Request failed (500)")).not.toBeInTheDocument();
  });

  it("does not expose unknown backend text even when it names the server", async () => {
    render(<Toaster />);
    const message =
      'MCP server "champions" doesn\'t support MCP protocol version 2026-07-28.';

    toastServerConnectionFailure("champions", message);

    expect(await screen.findByText(ERROR_MESSAGES.connectionFailed)).toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("copies the description, not just the server name", async () => {
    // The copy button lives on the title row. Split across two fields, a
    // button that copies only what it sits beside hands over a name.
    render(<Toaster />);

    toastServerConnectionFailure("Excalidraw (App)", "Request failed (500)");
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy error message" }),
    );

    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith(
        `Excalidraw (App): ${ERROR_MESSAGES.connectionFailed}`,
      ),
    );
  });

  it("keeps protocol-version recovery available after replacing backend copy", async () => {
    render(<Toaster />);
    toastServerConnectionFailure("example", "Server does not support 2020-01-01, which this client is pinned to");
    expect(await screen.findByText(ERROR_MESSAGES.protocolVersionUnsupported)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change protocol version" })).toBeInTheDocument();
  });

  it("carries an action that fixes the failure", async () => {
    const onClick = vi.fn();
    render(<Toaster />);

    toastServerConnectionFailure("champions", "Pinned version unsupported", {
      action: { label: "Change protocol version", onClick },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Change protocol version" }),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
