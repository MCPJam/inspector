import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "e2b";
import {
  CHECK_SANDBOX_TIMEOUT_MS,
  GITHUB_CHECKS_EGRESS_DENY_CIDRS,
  killCheckSandbox,
  provisionCheckSandbox,
} from "../sandbox";

vi.mock("e2b", async () => {
  const actual = await vi.importActual<typeof import("e2b")>("e2b");
  return { ...actual, Sandbox: { ...actual.Sandbox, create: vi.fn() } };
});

/** The env every test here provisions against. */
function stubProvisionEnv(): void {
  vi.stubEnv("E2B_API_KEY", "e2b_test_key");
  vi.stubEnv("GITHUB_CHECKS_E2B_TEMPLATE_ID", "template-test");
}

const ARGS = {
  triggerId: "trigger-1",
  repoFullName: "acme/example",
  prNumber: 7,
} as const;

describe("provisionCheckSandbox", () => {
  it("creates a public box with the backend's non-guest egress baseline", async () => {
    const create = vi.mocked(Sandbox.create);
    const sandbox = { sandboxId: "sb_test" } as never;
    stubProvisionEnv();
    create.mockResolvedValueOnce(sandbox);

    try {
      await expect(provisionCheckSandbox({ ...ARGS })).resolves.toBe(sandbox);

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

  it("pins the orphan backstop: a TTL, and kill (never pause) at it", async () => {
    // THE teardown guarantee, and the only one that survives this process
    // dying. `killCheckSandbox` is best-effort by design — a failed kill is a
    // warning — so what actually bounds an orphaned box is E2B reaping it at
    // its own TTL. That made these two options load-bearing and untested:
    // dropping `lifecycle` would leave dead workers' boxes alive on E2B's
    // default handling, and `onTimeout: "pause"` would SNAPSHOT a pull
    // request's build instead of destroying it — persisting the workspace this
    // check promises never to keep.
    const create = vi.mocked(Sandbox.create);
    stubProvisionEnv();
    create.mockResolvedValueOnce({ sandboxId: "sb_ttl" } as never);

    try {
      await provisionCheckSandbox({ ...ARGS });
      const options = create.mock.calls[0][1] as {
        timeoutMs?: number;
        lifecycle?: { onTimeout?: string };
      };
      expect(options.timeoutMs).toBe(CHECK_SANDBOX_TIMEOUT_MS);
      expect(options.lifecycle).toEqual({ onTimeout: "kill" });
    } finally {
      create.mockReset();
      vi.unstubAllEnvs();
    }
  });

  it("hands the box no credential material of ours", async () => {
    // The sandbox runs untrusted PR code, so the only secret that may reach
    // E2B is the API key authenticating US to E2B. Nothing about MCPJam's
    // environment — and no GitHub credential — may ride along in the metadata
    // or anywhere else in the create options. Asserted over the whole
    // serialized payload rather than field by field, so a future field cannot
    // add one without tripping this.
    const create = vi.mocked(Sandbox.create);
    stubProvisionEnv();
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "canary-github-app-key");
    vi.stubEnv("CONVEX_DEPLOY_KEY", "canary-convex-deploy-key");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "canary-service-token");
    create.mockResolvedValueOnce({ sandboxId: "sb_creds" } as never);

    try {
      await provisionCheckSandbox({ ...ARGS });
      const [, options] = create.mock.calls[0] as [
        string,
        Record<string, unknown>
      ];
      const { apiKey, ...rest } = options;
      expect(apiKey).toBe("e2b_test_key");
      const serialized = JSON.stringify(rest);
      for (const canary of [
        "canary-github-app-key",
        "canary-convex-deploy-key",
        "canary-service-token",
      ]) {
        expect(serialized).not.toContain(canary);
      }
      // No env passthrough at all: the recipe's own env is applied per command,
      // never as a box-wide default the build inherits.
      expect(rest).not.toHaveProperty("envs");
    } finally {
      create.mockReset();
      vi.unstubAllEnvs();
    }
  });

  it("refuses to run without the dedicated template, rather than falling back", async () => {
    // The shared computer template carries a browser, a desktop, and Project
    // Computer tooling — none of which a pull request's build should be able
    // to touch. A missing template id is a deployment error, and the failure
    // is attributed to US (`infra_error`), never to the PR.
    const create = vi.mocked(Sandbox.create);
    vi.stubEnv("E2B_API_KEY", "e2b_test_key");
    vi.stubEnv("GITHUB_CHECKS_E2B_TEMPLATE_ID", "");

    try {
      await expect(provisionCheckSandbox({ ...ARGS })).rejects.toMatchObject({
        outcome: "infra_error",
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockReset();
      vi.unstubAllEnvs();
    }
  });
});

describe("killCheckSandbox", () => {
  it("kills the box it is given", async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    await killCheckSandbox({ sandboxId: "sb_1", kill } as never);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed kill — the TTL is the real backstop", async () => {
    // Deliberate: teardown runs in a `finally`, and letting it throw would
    // replace the check's real outcome with a cleanup error. The box still
    // dies at its TTL (pinned above), which is why this is safe to swallow
    // rather than merely convenient.
    const kill = vi.fn().mockRejectedValue(new Error("e2b unreachable"));
    await expect(
      killCheckSandbox({ sandboxId: "sb_2", kill } as never)
    ).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there is no box", async () => {
    await expect(killCheckSandbox(null)).resolves.toBeUndefined();
  });
});
