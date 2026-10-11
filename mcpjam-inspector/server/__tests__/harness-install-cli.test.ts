import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/harness/local/runtime-install.js", () => ({
  readRuntimeInstallStatus: vi.fn(async (args: { harnessId: string }) => ({ state: "absent", harnessId: args.harnessId })),
  installRuntimePack: vi.fn(async (args: { harnessId: string }) => ({ state: "ready", packVersion: "1.0.0", harnessId: args.harnessId })),
  repairRuntime: vi.fn(async () => ({ status: { state: "ready", packVersion: "1.0.0" }, actions: ["verified"] })),
}));
vi.mock("../utils/harness/local/runtime-doctor.js", () => ({
  buildDoctorReport: vi.fn(async () => ({ runtimeRoot: "/home/u/.mcpjam/runtime", harnesses: [{ harnessId: "codex", repairs: ["x"] }] })),
  redactDoctorReport: vi.fn((report: { runtimeRoot: string }) => ({ ...report, runtimeRoot: "~/.mcpjam/runtime" })),
  renderDoctorReport: vi.fn(() => "rendered"),
}));

import { harnessDoctor, harnessInstall, harnessRepair, harnessStatus, supportedHarnessIds } from "../harness-install-cli";
import { installRuntimePack, readRuntimeInstallStatus, repairRuntime } from "../utils/harness/local/runtime-install.js";
import { buildDoctorReport, redactDoctorReport } from "../utils/harness/local/runtime-doctor.js";

describe("the harness install entry point", () => {
  it("installs and reports Claude Code when no harness is named, as before", async () => {
    await harnessStatus();
    await harnessInstall();
    expect(readRuntimeInstallStatus).toHaveBeenLastCalledWith({ harnessId: "claude-code" });
    expect(installRuntimePack).toHaveBeenLastCalledWith({ harnessId: "claude-code", trigger: "cli" });
  });

  it("targets the named harness's own pack", async () => {
    const progress = vi.fn();
    await harnessStatus("codex");
    await harnessInstall(progress, "codex");
    expect(readRuntimeInstallStatus).toHaveBeenLastCalledWith({ harnessId: "codex" });
    expect(installRuntimePack).toHaveBeenLastCalledWith({ harnessId: "codex", trigger: "cli", onProgress: progress });
    expect(supportedHarnessIds).toEqual(["claude-code", "codex"]);
  });

  it("refuses a harness it has no pack for, rather than installing a default", async () => {
    await expect(harnessInstall(undefined, "cursor")).rejects.toThrow(/unknown harness/);
    await expect(harnessStatus("__proto__")).rejects.toThrow(/unknown harness/);
  });

  it("pre-provisions from a local archive as `provision`, the trigger a manual policy allows", async () => {
    await harnessInstall(undefined, "codex", { fromArchive: "/srv/packs/codex.tar.gz" });
    expect(installRuntimePack).toHaveBeenLastCalledWith({
      harnessId: "codex",
      trigger: "provision",
      fromArchive: "/srv/packs/codex.tar.gz",
    });
  });

  it("repairs through the runtime's own repair, optionally from an archive", async () => {
    const result = await harnessRepair(undefined, "codex", { fromArchive: "/srv/packs/codex.tar.gz" });
    expect(repairRuntime).toHaveBeenLastCalledWith({ harnessId: "codex", fromArchive: "/srv/packs/codex.tar.gz" });
    expect(result.actions).toEqual(["verified"]);
  });

  it("reports doctor findings, redacted only when exported", async () => {
    const plain = await harnessDoctor({ harnessId: "codex" });
    expect(buildDoctorReport).toHaveBeenLastCalledWith({ harnessIds: ["codex"] });
    expect(plain.report.runtimeRoot).toBe("/home/u/.mcpjam/runtime");
    expect(plain.healthy).toBe(false);
    const exported = await harnessDoctor({ exported: true, verify: true });
    expect(buildDoctorReport).toHaveBeenLastCalledWith({ verify: true });
    expect(redactDoctorReport).toHaveBeenCalled();
    expect(exported.report.runtimeRoot).toBe("~/.mcpjam/runtime");
  });
});
