import { main, type CliMainResult } from "../../src/index.js";

export const telemetryDisabled = {
  env: {
    ...process.env,
    MCPJAM_TELEMETRY_DISABLED: "1",
  },
};

export async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  // String chunks are CLI output; binary chunks are the node:test runner's
  // child-process protocol and must keep flowing to the real streams.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

export async function runCli(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", ...argv], { telemetry: telemetryDisabled })
  );
  return {
    exitCode: run.result.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

export type { CliMainResult };
