import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({
  status: "error" as const,
  clientIdMetadataUrl: undefined,
  retry: vi.fn(),
  available: false,
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/hooks/use-confidential-cimd-capability", () => ({
  useConfidentialCimdCapability: () => capability,
}));

import { useServerForm } from "../use-server-form";

describe("useServerForm hosted confidential CIMD", () => {
  it("rehydrates a saved confidential selection and blocks instead of downgrading on probe error", async () => {
    const server = {
      name: "Saved confidential XAA server",
      config: { url: "https://example.com/mcp" },
      authMethod: "xaa",
      useXaa: true,
      useOAuth: false,
      registrationMode: "cimd",
      xaaClientAuth: "private_key_jwt",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() =>
      useServerForm(server, {
        confidentialCimdProbeEnabled: true,
        organizationId: "org-1",
        isSignedIn: true,
      })
    );

    await waitFor(() =>
      expect(result.current.xaaClientAuth).toBe("private_key_jwt")
    );
    expect(result.current.registrationMode).toBe("cimd");
    expect(result.current.authConfigurationBlocksSubmit).toBe(true);
    expect(result.current.validateForm()).toMatch(/could not be loaded/i);
    expect(result.current.buildFormData()).toMatchObject({
      registrationMode: "cimd",
      xaaClientAuth: "private_key_jwt",
    });
  });
});
