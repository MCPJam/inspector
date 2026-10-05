import { afterEach, describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({
  e2b: vi.fn((opts: unknown) => ({ kind: "e2b", opts })),
  docker: vi.fn((opts: unknown) => ({ kind: "docker", opts })),
}));
vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: built.e2b,
}));
vi.mock("../docker/docker-sandbox-provider.js", () => ({
  createDockerHarnessSandboxProvider: built.docker,
}));

import {
  createHarnessSandboxProvider,
  resolveHarnessSandboxProviderKind,
} from "../sandbox-provider-factory.js";
import { harnessBootstrapObservation } from "../harness-bake-observer.js";

afterEach(() => {
  built.e2b.mockClear();
  built.docker.mockClear();
});

describe("resolveHarnessSandboxProviderKind", () => {
  it("is E2B unless told otherwise", () => {
    expect(resolveHarnessSandboxProviderKind({})).toBe("e2b");
    expect(
      resolveHarnessSandboxProviderKind({ HARNESS_SANDBOX_PROVIDER: "" }),
    ).toBe("e2b");
    expect(
      resolveHarnessSandboxProviderKind({ HARNESS_SANDBOX_PROVIDER: "E2B" }),
    ).toBe("e2b");
  });

  it("allows Docker in development and CI", () => {
    expect(
      resolveHarnessSandboxProviderKind({
        HARNESS_SANDBOX_PROVIDER: "docker",
        NODE_ENV: "test",
      }),
    ).toBe("docker");
    expect(
      resolveHarnessSandboxProviderKind({ HARNESS_SANDBOX_PROVIDER: "docker" }),
    ).toBe("docker");
  });

  it("REFUSES Docker in production", () => {
    expect(() =>
      resolveHarnessSandboxProviderKind({
        HARNESS_SANDBOX_PROVIDER: "docker",
        NODE_ENV: "production",
      }),
    ).toThrow(/refused in production/);
  });

  it("refuses Docker in production through the builder too, before building anything", () => {
    expect(() =>
      createHarnessSandboxProvider(
        { sandboxId: "sbx_1" },
        { HARNESS_SANDBOX_PROVIDER: " Docker ", NODE_ENV: "production" },
      ),
    ).toThrow(/refused in production/);
    expect(built.docker).not.toHaveBeenCalled();
    expect(built.e2b).not.toHaveBeenCalled();
  });

  it("fails loudly on an unknown value instead of quietly using E2B", () => {
    expect(() =>
      resolveHarnessSandboxProviderKind({ HARNESS_SANDBOX_PROVIDER: "dokcer" }),
    ).toThrow(/not a sandbox provider/);
  });
});

describe("createHarnessSandboxProvider", () => {
  const opts = {
    sandboxId: "sbx_1",
    defaultWorkingDirectory: "/home/user",
    sessionEnv: { K: "v" },
    onSessionEnvUsed: () => {},
  };

  it("builds the E2B provider with the call site's options, unchanged", () => {
    const provider = createHarnessSandboxProvider(opts, {});
    expect(built.e2b).toHaveBeenCalledWith(opts);
    expect(built.docker).not.toHaveBeenCalled();
    // Wrapped, so the timing line can report the bootstrap.
    expect(provider).not.toBe(built.e2b.mock.results[0]!.value);
  });

  it("under docker, attaches to the container named by the sandbox id", () => {
    createHarnessSandboxProvider(opts, { HARNESS_SANDBOX_PROVIDER: "docker" });
    expect(built.e2b).not.toHaveBeenCalled();
    expect(built.docker).toHaveBeenCalledWith({
      containerId: "sbx_1",
      defaultWorkingDirectory: "/home/user",
      sessionEnv: { K: "v" },
      onSessionEnvUsed: opts.onSessionEnvUsed,
    });
  });

  it("wraps what it builds with the bootstrap observer", async () => {
    const provider = createHarnessSandboxProvider(opts, {});
    await expect(harnessBootstrapObservation(provider)).resolves.toMatchObject({
      outcome: "none",
    });
  });
});
