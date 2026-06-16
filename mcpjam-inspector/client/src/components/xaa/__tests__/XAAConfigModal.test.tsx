import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { XAAConfigModal } from "../XAAConfigModal";
import {
  EMPTY_XAA_DEBUG_PROFILE,
  type XAADebugProfile,
} from "@/lib/xaa/profile";

const CONFIGURED: XAADebugProfile = {
  ...EMPTY_XAA_DEBUG_PROFILE,
  serverUrl: "http://localhost:8787/mcp",
  authzServerIssuer: "http://localhost:8787",
  clientId: "xaa-local-client",
  clientSecret: "secret-123",
  scope: "mcp.access",
};

describe("XAAConfigModal — clear configuration", () => {
  it("fires onClear and does not save when cleared", async () => {
    const onSave = vi.fn();
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <XAAConfigModal
        open
        onOpenChange={() => {}}
        value={CONFIGURED}
        onSave={onSave}
        onClear={onClear}
      />,
    );

    // Sanity: the configured values render first.
    expect(screen.getByDisplayValue("xaa-local-client")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /clear configuration/i }),
    );

    // The modal delegates the actual delete + reset to the parent.
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
