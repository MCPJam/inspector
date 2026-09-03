/**
 * NetworkAccessError is the self-serve screen a self-hosted user hits when they
 * reach the inspector over the network (a non-localhost host not in
 * MCPJAM_ALLOWED_HOSTS). Its entire payload is telling them the host they're on
 * and the exact env var to set — so that's what these pin. The copy path also
 * has to survive the insecure context this screen renders in (see the source),
 * so the happy path is covered here and the crash-safety in the source's guard.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NetworkAccessError } from "../NetworkAccessError";

const originalLocation = window.location;

beforeAll(() => {
  // A distinctive LAN host so the host echo and env-var assertions are
  // unambiguous (jsdom's default "localhost" collides with other copy on screen).
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      host: "192.168.1.50:6274",
      hostname: "192.168.1.50",
      reload: vi.fn(),
    },
  });
});

afterAll(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

afterEach(() => {
  // Remove any clipboard stub a test installed so it doesn't leak.
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("NetworkAccessError", () => {
  it("shows the host the user is on and the exact env var to set", () => {
    render(<NetworkAccessError />);

    expect(screen.getByText("192.168.1.50:6274")).toBeInTheDocument();
    expect(
      screen.getByText("MCPJAM_ALLOWED_HOSTS=192.168.1.50")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("copies the env value and confirms when the clipboard is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Set this AFTER any test-runner clipboard setup so it's the stub the
    // component actually calls (userEvent, notably, installs its own).
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<NetworkAccessError />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "MCPJAM_ALLOWED_HOSTS=192.168.1.50"
      )
    );
    expect(
      await screen.findByRole("button", { name: "Copied" })
    ).toBeInTheDocument();
  });

  it("falls back to execCommand copy when the Clipboard API is unavailable", async () => {
    // No navigator.clipboard — the insecure-context (plain-HTTP LAN) case this
    // screen actually renders in.
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<NetworkAccessError />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(
      await screen.findByRole("button", { name: "Copied" })
    ).toBeInTheDocument();

    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("does not confirm when the execCommand copy fails", async () => {
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<NetworkAccessError />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    // Button label never flips to "Copied" — the value is still on screen to
    // copy by hand.
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copied" })
    ).not.toBeInTheDocument();

    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("reloads the page when Retry is clicked", () => {
    vi.mocked(window.location.reload).mockClear();

    render(<NetworkAccessError />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
});
