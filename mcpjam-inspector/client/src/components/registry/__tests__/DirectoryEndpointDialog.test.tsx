/**
 * The endpoint dialog: two shapes, and one rule about who decides.
 *
 * The client-side pattern check exists to save a round trip on an obvious
 * typo. It is NEVER the authority — the server re-checks with full-match
 * semantics, and its refusal is what the user sees. These tests pin both the
 * courtesy and its limits.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  DirectoryEndpointDialog,
  matchesEndpointPatternLocally,
} from "../DirectoryEndpointDialog";

function renderDialog(
  props: Partial<React.ComponentProps<typeof DirectoryEndpointDialog>> = {}
) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DirectoryEndpointDialog
      open
      onOpenChange={onOpenChange}
      displayName="Braze"
      onSubmit={onSubmit}
      {...props}
    />
  );
  return { onSubmit, onOpenChange };
}

describe("DirectoryEndpointDialog — options rows", () => {
  it("offers the published endpoints and submits the chosen one", () => {
    const { onSubmit } = renderDialog({
      options: ["https://mcp.braze.com/mcp", "https://mcp.braze.eu/mcp"],
    });

    expect(screen.getByTestId("directory-endpoint-select")).toBeInTheDocument();
    // Seeded with the first option, so Connect is immediately meaningful.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).toHaveBeenCalledWith("https://mcp.braze.com/mcp");
  });

  it("re-seeds when a fresher set of options arrives", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <DirectoryEndpointDialog
        open
        onOpenChange={vi.fn()}
        displayName="Braze"
        options={["https://stale.example/mcp"]}
        onSubmit={onSubmit}
      />
    );
    // `endpoint_url_required` carried the authoritative list; the stale
    // selection must not survive it.
    rerender(
      <DirectoryEndpointDialog
        open
        onOpenChange={vi.fn()}
        displayName="Braze"
        options={["https://fresh.example/mcp"]}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).toHaveBeenCalledWith("https://fresh.example/mcp");
  });
});

describe("DirectoryEndpointDialog — tenant rows", () => {
  it("takes a typed URL and shows the pattern it must match", () => {
    const { onSubmit } = renderDialog({
      displayName: "Smartsheet",
      pattern: "^https://mcp\\.smartsheet\\.(com|eu)/mcp$",
    });

    expect(screen.getByText(/Must match/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("directory-endpoint-url"), {
      target: { value: "https://mcp.smartsheet.eu/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).toHaveBeenCalledWith("https://mcp.smartsheet.eu/mcp");
  });

  it("catches an obvious mismatch before spending a round trip", () => {
    const { onSubmit } = renderDialog({
      pattern: "^https://mcp\\.smartsheet\\.(com|eu)/mcp$",
    });

    fireEvent.change(screen.getByTestId("directory-endpoint-url"), {
      target: { value: "https://mcp.elsewhere.example/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("directory-endpoint-error")).toBeInTheDocument();
  });

  it("requires an absolute http(s) URL", () => {
    const { onSubmit } = renderDialog({ pattern: ".*" });
    fireEvent.change(screen.getByTestId("directory-endpoint-url"), {
      target: { value: "mcp.acme.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("directory-endpoint-error")).toHaveTextContent(
      "http://"
    );
  });

  it("refuses an empty submission", () => {
    const { onSubmit } = renderDialog({ pattern: ".*" });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("trims before submitting", () => {
    const { onSubmit } = renderDialog({ pattern: ".*" });
    fireEvent.change(screen.getByTestId("directory-endpoint-url"), {
      target: { value: "  https://mcp.acme.example/mcp  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).toHaveBeenCalledWith("https://mcp.acme.example/mcp");
  });
});

describe("DirectoryEndpointDialog — server refusals", () => {
  it("shows the server's own message on a retry", () => {
    renderDialog({
      pattern: ".*",
      error: "That URL is not one of this connector’s endpoints.",
    });
    expect(screen.getByTestId("directory-endpoint-error")).toHaveTextContent(
      "not one of this connector"
    );
  });

  it("disables the actions while a connect is in flight", () => {
    renderDialog({ pattern: ".*", submitting: true });
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("Cancel closes without submitting", () => {
    const { onOpenChange, onSubmit } = renderDialog({ pattern: ".*" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("matchesEndpointPatternLocally", () => {
  it("matches the WHOLE url, so an unanchored pattern cannot be smuggled", () => {
    // The exact attack the server's full-match rule exists for: an unanchored
    // upstream regex would otherwise accept a host that merely contains it.
    expect(
      matchesEndpointPatternLocally(
        "mcp\\.acme\\.com",
        "https://evil.example/?x=mcp.acme.com"
      )
    ).toBe(false);
    expect(
      matchesEndpointPatternLocally("mcp\\.acme\\.com", "mcp.acme.com")
    ).toBe(true);
  });

  it("lets an uncompilable pattern through — the server answers that one", () => {
    expect(
      matchesEndpointPatternLocally("([", "https://anything.example")
    ).toBe(true);
  });
});
