/**
 * Entry point for `mcpjam-inspector harness install|status [--harness <id>]`.
 *
 * A SEPARATE bundle from `server/index.ts` on purpose: that module starts a
 * listening server as a side effect of being imported, and a subcommand whose
 * whole job is to download a file must not boot an Inspector to do it. This
 * imports only the installer.
 *
 * Not a second implementation, though. `installRuntimePack` goes through the
 * same cross-process coordination an Inspector window does, so running this
 * while a window is installing JOINS that install and reports its progress
 * rather than starting a competing extraction into the same directory — and a
 * window that starts one while this is running does the same in reverse.
 *
 * Each local harness has its own pack (D4), so the harness is a parameter.
 * Omitted, it is Claude Code, which is what the command meant before there
 * was a second one.
 */
import {
  installRuntimePack,
  readRuntimeInstallStatus,
  repairRuntime,
  type RuntimeInstallStatus,
} from "./utils/harness/local/runtime-install.js";
import {
  buildDoctorReport,
  redactDoctorReport,
  renderDoctorReport,
  type DoctorReport,
} from "./utils/harness/local/runtime-doctor.js";
import {
  SUPPORTED_LOCAL_HARNESS_IDS,
  type SupportedLocalHarnessId,
} from "./utils/harness/local/targets.js";

export type { DoctorReport, RuntimeInstallStatus };

/** The harness ids this build can install a runtime pack for. */
export const supportedHarnessIds: readonly string[] = SUPPORTED_LOCAL_HARNESS_IDS;

/** Human names, for the command's own output. */
export const harnessDisplayNames: Readonly<Record<SupportedLocalHarnessId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function harnessIdOf(value: string | undefined): SupportedLocalHarnessId {
  const id = value ?? "claude-code";
  if (!(SUPPORTED_LOCAL_HARNESS_IDS as readonly string[]).includes(id)) {
    throw new Error(
      `unknown harness ${JSON.stringify(id)} (expected one of ${SUPPORTED_LOCAL_HARNESS_IDS.join(", ")})`,
    );
  }
  return id as SupportedLocalHarnessId;
}

export async function harnessStatus(harnessId?: string): Promise<RuntimeInstallStatus> {
  return readRuntimeInstallStatus({ harnessId: harnessIdOf(harnessId) });
}

export async function harnessInstall(
  onProgress?: (status: RuntimeInstallStatus) => void,
  harnessId?: string,
  options: { fromArchive?: string } = {},
): Promise<RuntimeInstallStatus> {
  return installRuntimePack({
    harnessId: harnessIdOf(harnessId),
    // The installers an administrator's `updates: manual` policy leaves on:
    // this command, and pre-provisioning from a local archive.
    trigger: options.fromArchive !== undefined ? "provision" : "cli",
    ...(options.fromArchive !== undefined ? { fromArchive: options.fromArchive } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
}

/** `harness repair`: re-verify, reinstall if corrupt, clear staging, re-probe. */
export async function harnessRepair(
  onProgress?: (status: RuntimeInstallStatus) => void,
  harnessId?: string,
  options: { fromArchive?: string } = {},
): Promise<{ status: RuntimeInstallStatus; actions: string[] }> {
  return repairRuntime({
    harnessId: harnessIdOf(harnessId),
    ...(options.fromArchive !== undefined ? { fromArchive: options.fromArchive } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
}

/**
 * `harness doctor`: the report, as text for a terminal or JSON for a script,
 * and — with `exported: true` — redacted for attaching to a ticket.
 */
export async function harnessDoctor(options: {
  harnessId?: string;
  verify?: boolean;
  exported?: boolean;
} = {}): Promise<{ report: DoctorReport; text: string; healthy: boolean }> {
  const report = await buildDoctorReport({
    ...(options.harnessId !== undefined ? { harnessIds: [harnessIdOf(options.harnessId)] } : {}),
    ...(options.verify ? { verify: true } : {}),
  });
  const shown = options.exported ? redactDoctorReport(report) : report;
  const healthy = report.harnesses.every((h) => h.repairs.length === 0);
  return { report: shown, text: renderDoctorReport(shown), healthy };
}
