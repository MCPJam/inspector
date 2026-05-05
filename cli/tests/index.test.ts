import assert from "node:assert/strict";
import test from "node:test";
import { startMockHttpServer } from "../../sdk/tests/mock-servers/index.js";
import packageJson from "../package.json" with { type: "json" };
import { main, runCliEntrypoint } from "../src/index.js";

const pkgVersion = packageJson.version;
const telemetryDisabled = {
  env: {
    ...process.env,
    MCPJAM_TELEMETRY_DISABLED: "1",
  },
};

async function captureProcessOutput<T>(
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

test("main treats help and version output as non-command success", async () => {
  const helpRun = await captureProcessOutput(() =>
    main(["node", "mcpjam", "--help"], { telemetry: telemetryDisabled }),
  );
  assert.equal(helpRun.result.exitCode, 0);
  assert.equal(helpRun.result.shouldCheckForUpdates, false);
  assert.match(helpRun.stdout, /Usage: mcpjam/);

  const versionRun = await captureProcessOutput(() =>
    main(["node", "mcpjam", "--version"], { telemetry: telemetryDisabled }),
  );
  assert.equal(versionRun.result.exitCode, 0);
  assert.equal(versionRun.result.shouldCheckForUpdates, false);
  assert.ok(versionRun.stdout.includes(pkgVersion));
});

test("runCliEntrypoint invokes update check after successful commands", async () => {
  const server = await startMockHttpServer();
  let checkedVersion: string | null = null;

  try {
    const run = await captureProcessOutput(() =>
      runCliEntrypoint(
        [
          "node",
          "mcpjam",
          "--format",
          "json",
          "server",
          "export",
          "--url",
          server.url,
          "--stable",
        ],
        {
          telemetry: telemetryDisabled,
          checkForUpdates(version) {
            checkedVersion = version;
          },
        },
      ),
    );

    assert.equal(run.result.exitCode, 0, run.stderr);
    assert.equal(run.result.shouldCheckForUpdates, true);
    assert.equal(checkedVersion, pkgVersion);
  } finally {
    await server.stop();
  }
});

test("runCliEntrypoint does not append update text after usage errors", async () => {
  let checked = false;
  const run = await captureProcessOutput(() =>
    runCliEntrypoint(["node", "mcpjam", "not-a-command"], {
      telemetry: telemetryDisabled,
      checkForUpdates() {
        checked = true;
        process.stderr.write("unexpected update notice\n");
      },
    }),
  );

  assert.equal(run.result.exitCode, 2);
  assert.equal(run.result.shouldCheckForUpdates, false);
  assert.equal(checked, false);
  assert.match(run.stderr, /"USAGE_ERROR"/);
  assert.doesNotMatch(run.stderr, /unexpected update notice/);
});
