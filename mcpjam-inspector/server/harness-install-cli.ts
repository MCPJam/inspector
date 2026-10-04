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
  type RuntimeInstallStatus,
} from "./utils/harness/local/runtime-install.js";
import {
  SUPPORTED_LOCAL_HARNESS_IDS,
  type SupportedLocalHarnessId,
} from "./utils/harness/local/targets.js";

export type { RuntimeInstallStatus };

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
): Promise<RuntimeInstallStatus> {
  return installRuntimePack({
    harnessId: harnessIdOf(harnessId),
    ...(onProgress ? { onProgress } : {}),
  });
}
