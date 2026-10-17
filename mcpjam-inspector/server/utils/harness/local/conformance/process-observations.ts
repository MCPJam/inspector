import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Observe the OS independently of the supervisor being checked. Git Bash's
// process table only sees MSYS processes, so Windows probes use native tools.
const execFileP = promisify(execFile);
const WIN = process.platform === "win32";
const powershell = (script: string) =>
  execFileP(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "None",
      "-Command",
      `$ErrorActionPreference = 'Stop'; ${script}`,
    ],
    {
      windowsHide: true,
    },
  );

export async function running(pid: number): Promise<boolean> {
  if (WIN) {
    const { stdout } = await execFileP("tasklist", [
      "/FI",
      `PID eq ${pid}`,
      "/NH",
      "/FO",
      "CSV",
    ]);
    return stdout.includes(`"${pid}"`);
  }
  let state: string;
  try {
    state = (
      await execFileP("ps", ["-o", "stat=", "-p", String(pid)])
    ).stdout.trim();
  } catch {
    return false; // `ps` exits non-zero for a pid that does not exist.
  }
  if (state.length === 0) return false;
  return !state.startsWith("Z");
}

/** Which of these pids are still running — zombies do not count. */
export async function stillRunning(pids: readonly number[]): Promise<number[]> {
  const states = await Promise.all(pids.map(running));
  return pids.filter((_, i) => states[i]);
}
export async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    let kids = "";
    try {
      kids = WIN
        ? (
            await powershell(
              `Get-CimInstance Win32_Process -Filter "ParentProcessId=${p}" | ForEach-Object { $_.ProcessId }`,
            )
          ).stdout
        : (await execFileP("pgrep", ["-P", String(p)])).stdout;
    } catch (error) {
      if (WIN) throw error;
      return; // pgrep exits non-zero when the process has no children.
    }
    for (const k of kids
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter(Boolean)) {
      out.push(k);
      await walk(k);
    }
  };
  await walk(pid);
  return out;
}
export async function psLine(pid: number, withEnv = false) {
  try {
    const args = withEnv
      ? ["-E", "-o", "command=", "-p", String(pid)]
      : ["-o", "command=", "-p", String(pid)];
    return (await execFileP("ps", args)).stdout.trim();
  } catch {
    return "";
  }
}
export async function listeners(pid: number) {
  if (WIN) {
    // `  TCP    127.0.0.1:53123    0.0.0.0:0    LISTENING    1234`, for v4 and
    // v6 alike (`[::1]:53123`). Shaped like the lsof answer below so the
    // loopback verdict's regex reads both.
    return (await execFileP("netstat", ["-ano"])).stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter(
        (f) => f[0] === "TCP" && f[3] === "LISTENING" && f[4] === String(pid),
      )
      .map((f) => `${f[1]} (LISTEN)`);
  }
  try {
    return (
      await execFileP("lsof", [
        "-nP",
        "-a",
        "-p",
        String(pid),
        "-iTCP",
        "-sTCP:LISTEN",
      ])
    ).stdout
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split(/\s+/).slice(-2).join(" "));
  } catch {
    return [];
  }
}
