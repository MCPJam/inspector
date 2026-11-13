/**
 * What a conformance scenario needs to ask the OS about the tree it started:
 * is a pid alive, what are its descendants, what does its environment hold,
 * what does it listen on, plus the mock upstream and gateway it runs against.
 *
 * Windows has none of `ps`, `pgrep` or `lsof`, so each check has a Windows arm
 * that asks the OS directly: `tasklist` for liveness, `netstat -ano` for
 * listeners, CIM for the parent/child tree.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const WIN = process.platform === "win32";
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

const powershell = (script: string) =>
  execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", script], {
    windowsHide: true,
  });

export async function running(pid: number): Promise<boolean> {
  if (WIN) {
    try {
      const { stdout } = await execFileP("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
      return stdout.includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    const state = (await execFileP("ps", ["-o", "stat=", "-p", String(pid)])).stdout.trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

export async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (parent: number) => {
    let kids = "";
    try {
      kids = WIN
        ? (await powershell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}" | ForEach-Object { $_.ProcessId }`)).stdout
        : (await execFileP("pgrep", ["-P", String(parent)])).stdout;
    } catch {
      return;
    }
    for (const kid of kids.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)) {
      out.push(kid);
      await walk(kid);
    }
  };
  await walk(pid);
  return out;
}

/**
 * A process's environment: /proc on Linux, `ps -E` on macOS. `null` when it
 * cannot be read, which is every process on Windows: nothing short of reading
 * another process's memory shows its environment there.
 */
export async function processEnvironment(pid: number): Promise<string | null> {
  if (WIN) return null;
  try {
    return (await readFile(`/proc/${pid}/environ`, "utf8")).replace(/\0/g, "\n");
  } catch {
    try {
      return (await execFileP("ps", ["-E", "-o", "command=", "-p", String(pid)])).stdout;
    } catch {
      return null;
    }
  }
}

/** TCP listeners as `<address> (LISTEN)`, the shape `lsof` gives. */
export async function listeners(pid: number): Promise<string[]> {
  try {
    if (WIN) {
      return (await execFileP("netstat", ["-ano"])).stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((f) => f[0] === "TCP" && f[3] === "LISTENING" && f[4] === String(pid))
        .map((f) => `${f[1]} (LISTEN)`);
    }
    return (await execFileP("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"])).stdout
      .split("\n").slice(1).filter(Boolean).map((line) => line.split(/\s+/).slice(-2).join(" "));
  } catch {
    return [];
  }
}

export const isLoopbackListener = (listener: string) => /^(127\.|\[?::1\]?:)/.test(listener);

export const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

/** A helper script of this directory (mock upstream, gateway), started with a
 *  narrow environment, answering with the port it printed on its first line. */
export async function startHelper(
  script: string,
  env: Record<string, string>,
  helpers: ChildProcess[],
): Promise<{ child: ChildProcess; port: number; stderr: string[] }> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "MOCK_LATENCY_MS"]) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  const child = spawn(process.execPath, [join(SCRIPT_DIR, script)], {
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  helpers.push(child);
  const stderr: string[] = [];
  let tail = "";
  child.stderr!.on("data", (chunk) => {
    tail += String(chunk);
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) if (line !== "") stderr.push(line);
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = "";
    child.stdout!.on("data", (chunk) => {
      buffered += String(chunk);
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(buffered.slice(0, newline)).port); }
      catch (error) { reject(new Error(`${script} printed ${JSON.stringify(buffered)}: ${String(error)}`)); }
    });
    child.on("exit", (code) => reject(new Error(`${script} exited ${code}\n${stderr.slice(-10).join("\n")}`)));
  });
  return { child, port, stderr };
}

export async function stopHelpers(helpers: ChildProcess[], graceMs = 2_000): Promise<void> {
  await Promise.all(
    helpers.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, graceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}
