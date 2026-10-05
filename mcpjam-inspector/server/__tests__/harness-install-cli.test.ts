import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/harness/local/runtime-install.js", () => ({
  readRuntimeInstallStatus: vi.fn(async (args: { harnessId: string }) => ({ state: "absent", harnessId: args.harnessId })),
  installRuntimePack: vi.fn(async (args: { harnessId: string }) => ({ state: "ready", packVersion: "1.0.0", harnessId: args.harnessId })),
}));

import { harnessInstall, harnessStatus, supportedHarnessIds } from "../harness-install-cli";
import { installRuntimePack, readRuntimeInstallStatus } from "../utils/harness/local/runtime-install.js";

describe("the harness install entry point", () => {
  it("installs and reports Claude Code when no harness is named, as before", async () => {
    await harnessStatus();
    await harnessInstall();
    expect(readRuntimeInstallStatus).toHaveBeenLastCalledWith({ harnessId: "claude-code" });
    expect(installRuntimePack).toHaveBeenLastCalledWith({ harnessId: "claude-code" });
  });

  it("targets the named harness's own pack", async () => {
    const progress = vi.fn();
    await harnessStatus("codex");
    await harnessInstall(progress, "codex");
    expect(readRuntimeInstallStatus).toHaveBeenLastCalledWith({ harnessId: "codex" });
    expect(installRuntimePack).toHaveBeenLastCalledWith({ harnessId: "codex", onProgress: progress });
    expect(supportedHarnessIds).toEqual(["claude-code", "codex"]);
  });

  it("refuses a harness it has no pack for, rather than installing a default", async () => {
    await expect(harnessInstall(undefined, "cursor")).rejects.toThrow(/unknown harness/);
    await expect(harnessStatus("__proto__")).rejects.toThrow(/unknown harness/);
  });
});
