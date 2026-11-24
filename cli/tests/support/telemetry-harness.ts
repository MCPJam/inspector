import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TelemetryClient } from "../../src/lib/telemetry.js";

/** Shared by the CLI telemetry tests: isolated state, env and a recording client. */
export type CapturedEvent = Parameters<TelemetryClient["capture"]>[0];

export async function createStatePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-telemetry-"));
  return path.join(directory, "telemetry.json");
}

export function cleanTelemetryEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DO_NOT_TRACK",
    "MCPJAM_TELEMETRY_DISABLED",
    "MCPJAM_TELEMETRY_DEBUG",
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "BUILDKITE",
    "JENKINS_URL",
    "JENKINS_HOME",
    "VERCEL",
    "NETLIFY",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

export function createRecordingClient(): {
  events: CapturedEvent[];
  createClient: () => TelemetryClient;
  flushes: () => number;
} {
  const events: CapturedEvent[] = [];
  let flushCount = 0;

  return {
    events,
    createClient: () => ({
      capture(event) {
        events.push(event);
      },
      async flush() {
        flushCount += 1;
      },
    }),
    flushes: () => flushCount,
  };
}

export async function captureProcessOutput<T>(
  fn: () => Promise<T>,
): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";

  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return {
      result,
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
}
