/**
 * Ends every process a Windows (Git Bash / MSYS2) command started.
 *
 * Windows has no process groups, and `taskkill /T` cannot do the job: MSYS
 * runs each command through a fork stub that exits, so the Windows parent of
 * `sleep.exe` is a dead PID, and once bash itself exits nothing links its
 * descendants to the PID this process spawned. Those descendants still hold
 * the command's output pipes.
 *
 * What survives is the environment. The command is spawned with a per-command
 * id in its env, every descendant inherits it, and MSYS exposes each process's
 * environment at `/proc/<pid>/environ` (native Windows children included). The
 * reaper is the same bash, scanning with builtins only: forking per process
 * costs seconds on Windows. Two passes catch a child forked mid-scan. A
 * descendant that scrubs its own environment escapes, which is why the runner
 * still bounds how long it waits.
 */
import { spawn, type ChildProcess } from "node:child_process";

export const MSYS_COMMAND_ID_ENV = "MCPJAM_LOCAL_COMMAND_ID";

const REAPER_SCRIPT = `
for pass in 1 2; do
  for p in /proc/[0-9]*; do
    while IFS= read -r -d '' entry; do
      if [[ $entry == "${MSYS_COMMAND_ID_ENV}=$1" ]]; then
        kill -9 "\${p#/proc/}"
        break
      fi
    done < "$p/environ"
  done
done 2>/dev/null
exit 0
`;

/**
 * Starts the reaper for `commandId`. `env` must not carry the id, or the
 * reaper would match itself.
 */
export function spawnMsysReaper(
  bashPath: string,
  commandId: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(bashPath, ["-c", REAPER_SCRIPT, "mcpjam-reaper", commandId], {
    env,
    stdio: "ignore",
    windowsHide: true,
  });
}
