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
import { toast as appToast } from "@/lib/toast";
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
        "Excalidraw (App): Request failed (500)",
      ),
    );
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

/**
 * A Convex failure reaches the toast as one string, because 394 call sites
 * hand `toast.error` exactly that. The reference is lifted out here, at the one
 * place they all pass through, so the user reads a sentence with a line under
 * it they can screenshot — and the copy button that already exists picks both
 * up without any new UI.
 */
describe("support references on error toasts", () => {
  it("shows the reference on its own line, not trailing the sentence", async () => {
    render(<Toaster />);

    appToast.error("Something went wrong (ref da0bbc6cf9261481)");

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Reference da0bbc6cf9261481")).toBeInTheDocument();
  });

  it("copies the sentence and the reference together", async () => {
    render(<Toaster />);

    appToast.error("Something went wrong (ref da0bbc6cf9261481)");
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy error message" }),
    );

    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith(
        "Something went wrong: Reference da0bbc6cf9261481",
      ),
    );
  });

  it("keeps a caller's own description and puts the reference under it", async () => {
    // Same rule as the protocol-pin action: what the caller passed wins, and
    // ours is added beside it rather than over it.
    render(<Toaster />);

    appToast.error("Excalidraw (App) (ref da0bbc6cf9261481)", {
      description: "Request failed (500)",
    });

    expect(await screen.findByText("Excalidraw (App)")).toBeInTheDocument();
    expect(screen.getByText(/Request failed \(500\)/)).toBeInTheDocument();
    expect(screen.getByText(/Reference da0bbc6cf9261481/)).toBeInTheDocument();
  });

  it("keeps a rendered description rather than replacing it with the reference", async () => {
    // Sonner also takes a `ReactNode` here, which cannot be concatenated with
    // a line of text. Overwriting it would drop whatever the caller rendered,
    // so the reference stays inline in the sentence instead.
    render(<Toaster />);

    appToast.error("Something went wrong (ref da0bbc6cf9261481)", {
      description: <strong>Check the server logs</strong>,
    });

    expect(
      await screen.findByText("Check the server logs"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Something went wrong (ref da0bbc6cf9261481)"),
    ).toBeInTheDocument();
  });

  it("leaves a message that carries no reference exactly as it was", async () => {
    render(<Toaster />);

    appToast.error("Failed to invite member");

    expect(
      await screen.findByText("Failed to invite member"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Reference /)).not.toBeInTheDocument();
  });
});
