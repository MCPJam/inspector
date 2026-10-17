import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { localHarnessSystemPath } from "./session-env.js";
import { logger } from "../../logger.js";

const run = promisify(execFile);
const options = { timeout: 2_000, killSignal: "SIGKILL" as const, maxBuffer: 64 * 1024 };
const message = "The Linux sandbox could not start. Check bubblewrap and your system's user namespace policy before running unattended Codex.";

/** Mirrors the pinned Codex launcher: capable system helper first, then bundled. */
export async function probeCodexLinuxSandbox(
  runtimeRoot: string,
  systemPath = localHarnessSystemPath("linux", {}),
): Promise<{ ok: true } | { ok: false; message: string }> {
  let helper = join(runtimeRoot, "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex-resources/bwrap");
  for (const dir of systemPath.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "bwrap");
    try {
      await access(candidate, constants.X_OK);
      const { stdout, stderr } = await run(candidate, ["--help"], options);
      const help = stdout + stderr;
      if (help.includes("--as-pid-1") && help.includes("--perms")) {
        helper = candidate;
        break;
      }
    } catch (error) {
      // Missing or unsupported system helpers fall back exactly as Codex does.
      logger.debug("System sandbox helper is unavailable", { error });
    }
  }
  try {
    await run(helper, ["--unshare-user", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"], options);
    return { ok: true };
  } catch (error) {
    logger.debug("Linux sandbox namespace probe failed", { error });
    return { ok: false, message };
  }
}
