/**
 * Where local harness runtimes live — vendor packs AND the Inspector layer.
 *
 * Electron sets `MCPJAM_RUNTIME_ROOT` from `app.getPath("userData")` so a
 * packaged app keeps its runtime with the rest of its own state; npx falls
 * back to the same `~/.mcpjam` tree the grants and machine identity already
 * use. Both are per-user and outside any workspace, which is what keeps the
 * runtime out of reach of the agent it launches.
 *
 * Its own module (re-exported by `runtime-install.ts`) so that resolution code
 * can name the root without importing the installer.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function runtimeInstallRoot(): string {
  const override = process.env.MCPJAM_RUNTIME_ROOT;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".mcpjam", "harness-local", "runtime");
}
