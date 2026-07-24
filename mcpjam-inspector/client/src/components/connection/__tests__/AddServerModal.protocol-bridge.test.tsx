import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServerFormData } from "@/shared/types.js";
import { AddServerModal } from "../AddServerModal";

// AddServerModal reaches for auth, app-readiness and analytics at render time;
// stub them so the modal mounts standalone. HOSTED_MODE stays false (the test
// default), which keeps useServerForm's confidential-CIMD probe off the network.
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready" }),
  useAppReadyMessage: () => null,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

function submitAddServer(): ServerFormData {
  const onSubmit = vi.fn();
  render(
    <AddServerModal
      isOpen
      onClose={vi.fn()}
      onSubmit={onSubmit}
      // A prefilled OAuth server already pinned to the 2026 wire era, with the
      // Protocol dropdown left at its default (no explicit oauthProtocolMode).
      initialData={{
        name: "draft-2026",
        type: "http",
        url: "https://example.test/mcp",
        useOAuth: true,
        mcpProtocolVersionOverride: "2026-07-28",
      }}
      projectId="proj-1"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /add server/i }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][0] as ServerFormData;
}

describe("AddServerModal — default-OAuth × 2026 wire-pin bridge (end to end)", () => {
  it("submits the 2026 OAuth flow and round-trips the wire pin", () => {
    const submitted = submitAddServer();

    // The crux: default OAuth (dropdown untouched) + a 2026-07-28 wire pin
    // resolves to the 2026 OAuth flow rather than silently degrading to 2025.
    expect(submitted.oauthProtocolMode).toBe("2026-07-28");
    // The prefilled pin survives the round-trip — the server stays 2026-pinned.
    expect(submitted.mcpProtocolVersionOverride).toBe("2026-07-28");
    expect(submitted.useOAuth).toBe(true);
  });
});
