import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessRequired } from "../AccessRequired";
import { confirmAccessToken } from "@/lib/session-token";
import {
  ACCESS_LINK_RECEIVED_EVENT,
  rememberAccessToken,
} from "@/lib/access-link";
vi.mock("@/lib/session-token", () => ({ confirmAccessToken: vi.fn() }));
vi.mock("@/lib/theme-utils", () => ({
  getInitialThemeMode: () => "light",
  getInitialThemePreset: () => "default",
  updateThemeMode: vi.fn(),
  updateThemePreset: vi.fn(),
}));
const token = "access-link-secret-with-enough-entropy";
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe("AccessRequired", () => {
  it("shows restart instructions", () => {
    render(<AccessRequired restarted />);
    expect(screen.getByText("MCPJam restarted")).toBeInTheDocument();
  });
  it("confirms a pasted link and resumes without reloading", async () => {
    vi.mocked(confirmAccessToken).mockResolvedValue(token);
    const granted = vi.fn();
    window.addEventListener("mcpjam:access-granted", granted);
    try {
      render(<AccessRequired />);
      fireEvent.change(
        screen.getByLabelText("Link or code from your terminal"),
        { target: { value: `http://localhost/#token=${token}` } },
      );
      fireEvent.submit(
        screen.getByRole("button", { name: "Open MCPJam" }).closest("form")!,
      );
      await waitFor(() => expect(granted).toHaveBeenCalledOnce());
      expect(confirmAccessToken).toHaveBeenCalledWith(token);
    } finally {
      window.removeEventListener("mcpjam:access-granted", granted);
    }
  });
  it("confirms credentials arriving through a storage event", async () => {
    vi.mocked(confirmAccessToken).mockResolvedValue(token);
    render(<AccessRequired />);
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: "mcpjam.local-access",
        newValue: token,
      }),
    );
    await waitFor(() => expect(confirmAccessToken).toHaveBeenCalledWith(token));
  });
  it("confirms a link pasted into this tab's address bar", async () => {
    vi.mocked(confirmAccessToken).mockResolvedValue(token);
    const granted = vi.fn();
    window.addEventListener("mcpjam:access-granted", granted);
    try {
      render(<AccessRequired />);
      rememberAccessToken(token);
      fireEvent(window, new Event(ACCESS_LINK_RECEIVED_EVENT));
      await waitFor(() => expect(granted).toHaveBeenCalledOnce());
      expect(confirmAccessToken).toHaveBeenCalledWith(token);
    } finally {
      window.removeEventListener("mcpjam:access-granted", granted);
    }
  });
  it("does not expose a rejected link in its error", async () => {
    vi.mocked(confirmAccessToken).mockRejectedValue(new Error(token));
    render(<AccessRequired />);
    fireEvent.change(screen.getByLabelText("Link or code from your terminal"), {
      target: { value: token },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Open MCPJam" }).closest("form")!,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Use the newest link",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(token);
  });
  it("copies on a plain-HTTP browser without the Clipboard API", async () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    const copy = vi.fn(() => true);
    const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: copy,
    });
    try {
      render(<AccessRequired />);
      fireEvent.click(
        screen.getByRole("button", { name: "Copy", exact: true }),
      );
      expect(
        await screen.findByRole("button", { name: "Copied", exact: true }),
      ).toBeInTheDocument();
      expect(copy).toHaveBeenCalledWith("copy");
    } finally {
      if (previous) Object.defineProperty(document, "execCommand", previous);
      else delete (document as any).execCommand;
    }
  });
});
