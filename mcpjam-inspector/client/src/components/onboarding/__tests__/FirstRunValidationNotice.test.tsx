import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { HOSTED_STDIO_ERROR } from "@/lib/server-form-validation";
import { FirstRunValidationNotice } from "../FirstRunValidationNotice";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FirstRunValidationNotice", () => {
  it("copies the launch command from a section outside the validation alert", async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(true);
    render(<FirstRunValidationNotice error={HOSTED_STDIO_ERROR} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent("npx");
    expect(
      screen.getByRole("region", { name: "Run MCPJam locally" }),
    ).toHaveTextContent("npx @mcpjam/inspector@latest");
    fireEvent.click(
      screen.getByRole("button", { name: "Copy MCPJam command" }),
    );
    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith(
        "npx @mcpjam/inspector@latest",
      );
      expect(toast.success).toHaveBeenCalledWith("Copied to clipboard");
    });
  });

  it("reports clipboard failure without claiming the command was copied", async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(false);
    render(<FirstRunValidationNotice error={HOSTED_STDIO_ERROR} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy MCPJam command" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not copy"),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps unrelated validation errors free of local-install guidance", () => {
    render(<FirstRunValidationNotice error="Enter your server’s URL." />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter your server’s URL.",
    );
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
