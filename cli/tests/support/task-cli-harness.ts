import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the CLI the way a user would.
 *
 * The task verbs are judged end to end — exit code plus the parsed stdout
 * envelope — because that pair is the actual contract with a script, and an
 * in-process call would skip the commander wiring and the exit-code mapping
 * that most of these tests exist to pin.
 */
export function runCli(args: string[], input?: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI_PATH, CLI_ENTRY_PATH, ...args], {
      cwd: CLI_DIR,
      env: {
        ...process.env,
        MCPJAM_CLI_DISABLE_BROWSER_OPEN: "1",
        MCPJAM_TELEMETRY_DISABLED: "1",
        NODE_NO_WARNINGS: "1",
        // Every run must decide interactivity from its flags alone; a CI
        // variable leaking in from the host would silently disarm --interactive.
        CI: "",
        MCPJAM_NON_INTERACTIVE: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === null) {
        reject(new Error(`CLI killed by signal\n${stderr}`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });

    child.stdin.end(input ?? "");
  });
}

/**
 * Last parseable JSON line of stdout.
 *
 * Watch runs interleave human status on stderr, but a stray line on stdout
 * would still break a naive `JSON.parse(stdout)`; scanning backwards keeps the
 * assertion on the envelope the command actually committed to.
 */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON found in stdout:\n${stdout}`);
}

export function jsonOf(run: CliRun): Record<string, unknown> {
  return lastJsonLine(run.stdout) as Record<string, unknown>;
}

/** The structured error the CLI writes to stderr on a `CliError`. */
export function errorOf(run: CliRun): { code: string; message: string } {
  const parsed = lastJsonLine(run.stderr) as {
    error?: { code: string; message: string };
  };
  if (!parsed.error) throw new Error(`No structured error in stderr:\n${run.stderr}`);
  return parsed.error;
}

export function httpTarget(url: string): string[] {
  return ["--url", url, "--transport", "http"];
}
