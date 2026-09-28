/**
 * Entry point for `mcpjam-inspector harness install|status`.
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
 */
import {
  installRuntimePack,
  readRuntimeInstallStatus,
  type RuntimeInstallStatus,
} from "./utils/harness/local/runtime-install.js";

export type { RuntimeInstallStatus };

export async function harnessStatus(): Promise<RuntimeInstallStatus> {
  return readRuntimeInstallStatus({ harnessId: "claude-code" });
}

export async function harnessInstall(
  onProgress?: (status: RuntimeInstallStatus) => void,
): Promise<RuntimeInstallStatus> {
  return installRuntimePack({
    harnessId: "claude-code",
    ...(onProgress ? { onProgress } : {}),
  });
}
