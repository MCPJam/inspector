import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "e2b";
import {
  GITHUB_CHECKS_EGRESS_DENY_CIDRS,
  provisionCheckSandbox,
} from "../sandbox";

vi.mock("e2b", async () => {
  const actual = await vi.importActual<typeof import("e2b")>("e2b");
  return { ...actual, Sandbox: { ...actual.Sandbox, create: vi.fn() } };
});

describe("provisionCheckSandbox", () => {
  it("creates a public box with the backend's non-guest egress baseline", async () => {
    const create = vi.mocked(Sandbox.create);
    const sandbox = { sandboxId: "sb_test" } as never;
    vi.stubEnv("E2B_API_KEY", "e2b_test_key");
    vi.stubEnv("GITHUB_CHECKS_E2B_TEMPLATE_ID", "template-test");
    create.mockResolvedValueOnce(sandbox);

    try {
      await expect(
        provisionCheckSandbox({
          triggerId: "trigger-1",
          repoFullName: "acme/example",
          prNumber: 7,
        })
      ).resolves.toBe(sandbox);

      expect(create).toHaveBeenCalledWith(
        "template-test",
        expect.objectContaining({
          network: {
            allowPublicTraffic: true,
            denyOut: [...GITHUB_CHECKS_EGRESS_DENY_CIDRS],
          },
        })
      );
    } finally {
      create.mockReset();
      vi.unstubAllEnvs();
    }
  });
});
