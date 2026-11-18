import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { operationalError } from "./errors.js";
import { isInspectorHealthy } from "./health.js";

const STARTUP_LOG_MAX_BYTES = 1024 * 1024;

export function getNpxExecutable(platform = process.platform): string {
  return platform === "win32" ? "npx.cmd" : "npx";
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
  const args = localStartScriptPath
    ? [localStartScriptPath, "--port", port, "--no-open"]
    : ["-y", "@mcpjam/inspector@latest", "--port", port, "--no-open"];
  const executable = localStartScriptPath
    ? process.execPath
    : getNpxExecutable();
  const logPath = getInspectorStartupLogPath();
  const logFd = openStartupLogFile(logPath);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, args, {
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
