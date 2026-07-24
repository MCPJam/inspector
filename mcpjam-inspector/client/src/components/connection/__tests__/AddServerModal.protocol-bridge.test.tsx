import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFormData } from "@/shared/types.js";
import type { McpProtocolVersion } from "@mcpjam/sdk/browser";
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

// The active host's mcpProfile normally arrives via ActiveMcpProfileProvider
// (the Servers tab). Stub the context so the test can pin the host-level wire
// version and prove the "auto" OAuth bridge falls back to it. Authentication
// Section reads the same hook, so display and submit share this source.
let mockActiveMcpProfile:
  | { profileVersion: 1; mcpProtocolVersion?: McpProtocolVersion }
  | undefined;
vi.mock("@/contexts/active-mcp-profile-context", () => ({
  useActiveMcpProfile: () => mockActiveMcpProfile,
  ActiveMcpProfileProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

afterEach(() => {
  mockActiveMcpProfile = undefined;
});

function submitAddServer(
  initialData: Partial<ServerFormData>,
): ServerFormData {
  const onSubmit = vi.fn();
  render(
    <AddServerModal
      isOpen
      onClose={vi.fn()}
      onSubmit={onSubmit}
      initialData={initialData}
      projectId="proj-1"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /add server/i }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][0] as ServerFormData;
}

describe("AddServerModal — default-OAuth × 2026 wire-pin bridge (end to end)", () => {
  it("submits the 2026 OAuth flow and round-trips a per-server wire pin", () => {
    // A prefilled OAuth server pinned to the 2026 wire era, Protocol dropdown
    // left at its default (no explicit oauthProtocolMode).
    const submitted = submitAddServer({
      name: "draft-2026",
      type: "http",
      url: "https://example.test/mcp",
      useOAuth: true,
      mcpProtocolVersionOverride: "2026-07-28",
    });

    // The crux: default OAuth (dropdown untouched) + a 2026-07-28 wire pin
    // resolves to the 2026 OAuth flow rather than silently degrading to 2025.
    expect(submitted.oauthProtocolMode).toBe("2026-07-28");
    // The prefilled pin survives the round-trip — the server stays 2026-pinned.
    expect(submitted.mcpProtocolVersionOverride).toBe("2026-07-28");
    expect(submitted.useOAuth).toBe(true);
  });

  it("preserves an explicit 'auto' prefill and resolves it under the wire pin", () => {
    // Round-2 regression: an "auto" prefill was coerced to 2025-11-25 during
    // hydration (normalizeOauthProtocolMode), dropping the sentinel so the
    // bridge no longer fired. It must survive and resolve against the pin.
    const submitted = submitAddServer({
      name: "auto-prefill-2026",
      type: "http",
      url: "https://example.test/mcp",
      useOAuth: true,
      oauthProtocolMode: "auto",
      mcpProtocolVersionOverride: "2026-07-28",
    });

    expect(submitted.oauthProtocolMode).toBe("2026-07-28");
    expect(submitted.mcpProtocolVersionOverride).toBe("2026-07-28");
  });

  it("falls back to the active host's 2026 wire pin when no per-server override is set", () => {
    // Round-2 P2: with the per-server picker at "Client default"
    // (mcpProtocolVersionOverride undefined), "auto" OAuth must consult the
    // active host's mcpProfile.mcpProtocolVersion before the 2025 default.
    mockActiveMcpProfile = {
      profileVersion: 1,
      mcpProtocolVersion: "2026-07-28",
    };

    const submitted = submitAddServer({
      name: "host-pinned-2026",
      type: "http",
      url: "https://example.test/mcp",
      useOAuth: true,
      // No mcpProtocolVersionOverride, no explicit oauthProtocolMode.
    });

    expect(submitted.oauthProtocolMode).toBe("2026-07-28");
    // The per-server override stays unset — only the host default is inherited.
    expect(submitted.mcpProtocolVersionOverride).toBeUndefined();
  });

  it("stays on the 2025 default when neither a per-server nor host pin is 2026", () => {
    const submitted = submitAddServer({
      name: "unpinned",
      type: "http",
      url: "https://example.test/mcp",
      useOAuth: true,
    });

    expect(submitted.oauthProtocolMode).toBe("2025-11-25");
    expect(submitted.mcpProtocolVersionOverride).toBeUndefined();
  });
});
