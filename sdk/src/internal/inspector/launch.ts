import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { operationalError } from "./errors.js";
import { isInspectorHealthy } from "./health.js";

const STARTUP_LOG_MAX_BYTES = 1024 * 1024;

export interface NpxInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * @deprecated Use `npxInvocation`. Published CLI versions still import this
 * from `@mcpjam/sdk/internal/inspector`.
 */
export function getNpxExecutable(platform = process.platform): string {
  return platform === "win32" ? "npx.cmd" : "npx";
}

/**
 * How to spawn npx. On Windows `npx` is the `npx.cmd` shim, and since Node's
 * CVE-2024-27980 hardening spawning a `.cmd` without a shell throws EINVAL.
 * So Windows runs npm's own `npx-cli.js` with the current Node, which needs
 * no shell. Without it, the shim runs through cmd.exe as one command string:
 * Node 24 deprecates passing an args array with `shell: true` (DEP0190).
 * cmd.exe re-reads that string, so each argument is quoted, and characters
 * cmd.exe still expands inside quotes are refused.
 */
export function npxInvocation(
  args: readonly string[],
  platform = process.platform,
  findNpxCli: () => string | undefined = findBundledNpxCli,
): NpxInvocation {
  if (platform !== "win32") {
    return { command: "npx", args: [...args], shell: false };
  }
  const npxCli = findNpxCli();
  if (npxCli) {
    return { command: process.execPath, args: [npxCli, ...args], shell: false };
  }
  return {
    command: ["npx.cmd", ...args.map(quoteCmdArgument)].join(" "),
    args: [],
    shell: true,
  };
}

// The Windows Node installer and nvm-windows put npm next to node.exe.
function findBundledNpxCli(): string | undefined {
  const npxCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npx-cli.js",
  );
  return existsSync(npxCli) ? npxCli : undefined;
}

function quoteCmdArgument(arg: string): string {
  if (/["%!\r\n]/.test(arg)) {
    throw operationalError(
      `Cannot pass ${JSON.stringify(arg)} to npx through cmd.exe safely.`,
    );
  }
  if (/^[\w@./:=-]+$/.test(arg)) {
    return arg;
  }
  // Backslashes before a quote are escapes to the argv parser, so a trailing
  // backslash would swallow the closing quote and the next argument.
  let end = arg.length;
  while (end > 0 && arg[end - 1] === "\\") {
    end--;
  }
  return `"${arg}${arg.slice(end)}"`;
}

export async function startInspector(
  baseUrl: string,
  timeoutMs: number,
  resolveStartScriptPath?: () => string | undefined,
): Promise<void> {
  const parsedUrl = new URL(baseUrl);
  const port = parsedUrl.port || "6274";
  const startScriptPath = resolveStartScriptPath?.();
  const localStartScriptPath =
    startScriptPath && existsSync(startScriptPath) ? startScriptPath : undefined;
  const invocation: NpxInvocation = localStartScriptPath
    ? {
        command: process.execPath,
        args: [localStartScriptPath, "--port", port, "--no-open"],
        shell: false,
      }
    : npxInvocation([
        "-y",
        "@mcpjam/inspector@latest",
        "--port",
        port,
        "--no-open",
      ]);
  const logPath = getInspectorStartupLogPath();
  const logFd = openStartupLogFile(logPath);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.command, invocation.args, {
      shell: invocation.shell,
      // Detached Windows children get their own console window otherwise.
      windowsHide: true,
      cwd: localStartScriptPath
        ? path.dirname(localStartScriptPath)
        : process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        MCPJAM_SESSION_TOKEN:
          process.env.MCPJAM_SESSION_TOKEN ??
          randomBytes(24).toString("base64url"),
        HOST: parsedUrl.hostname,
        MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
      },
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isInspectorHealthy(baseUrl)) {
      return;
    }
    await delay(250);
  }

  throw operationalError(
    `Inspector did not become ready within ${timeoutMs}ms. Startup log: ${logPath}`,
  );
}

function getInspectorStartupLogPath(): string {
  return path.join(os.tmpdir(), "mcpjam-inspector-startup.log");
}

function openStartupLogFile(logPath: string): number {
  try {
    if (existsSync(logPath) && statSync(logPath).size > STARTUP_LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Startup logging is best-effort; rotation failures should not block launch.
  }

  // CLI-owned launches suppress the access link; this log contains diagnostics only.
  return openSync(logPath, "a");
}

export function openUrl(url: string): void {
  if (process.env.MCPJAM_CLI_DISABLE_BROWSER_OPEN === "1") {
    return;
  }

  const platform = process.platform;
  const child =
    platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
        })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
