import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/index.js";
import { CliError } from "../src/lib/output.js";
import { parseTunnelTarget } from "../src/commands/tunnel.js";

const telemetryDisabled = {
  env: {
    ...process.env,
    MCPJAM_TELEMETRY_DISABLED: "1",
  },
};

async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  // String chunks are CLI output; binary chunks are the node:test runner's
  // child-process protocol and must keep flowing to the real stdout.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
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

// ── parseTunnelTarget ──────────────────────────────────────────────────

test("parseTunnelTarget maps a single URL token to an http target", () => {
  assert.deepEqual(parseTunnelTarget(["http://localhost:9090/mcp"]), {
    kind: "http",
    url: "http://localhost:9090/mcp",
  });
  assert.deepEqual(parseTunnelTarget(["HTTPS://example.com/mcp"]), {
    kind: "http",
    url: "HTTPS://example.com/mcp",
  });
});

test("parseTunnelTarget maps post-`--` tokens to a stdio command", () => {
  assert.deepEqual(
    parseTunnelTarget(["npx", "-y", "@modelcontextprotocol/server-everything"]),
    {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
  );
});

test("parseTunnelTarget rejects empty, mixed, and malformed targets", () => {
  assert.throws(() => parseTunnelTarget([]), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "USAGE_ERROR");
    return true;
  });
  assert.throws(
    () => parseTunnelTarget(["http://localhost:9090/mcp", "extra"]),
    /not both/,
  );
  assert.throws(() => parseTunnelTarget(["http://"]), /Invalid URL/);
});

// ── Command wiring ─────────────────────────────────────────────────────

test("tunnel without a target exits 2 with a usage error", async () => {
  const { result, stdout, stderr } = await captureProcessOutput(() =>
    main(["node", "mcpjam", "tunnel", "--id", "my-server", "--format", "json"], {
      telemetry: telemetryDisabled,
    }),
  );

  assert.equal(result.exitCode, 2);
  assert.equal(stdout, "");
  const payload = JSON.parse(stderr.trim().split("\n").at(-1)!) as {
    error: { code: string; message: string };
  };
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /Specify a target/);
});

test("tunnel without --id exits 2 via commander's required option", async () => {
  const { result, stderr } = await captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "tunnel",
        "http://localhost:9090/mcp",
        "--format",
        "json",
      ],
      { telemetry: telemetryDisabled },
    ),
  );

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(stderr.trim().split("\n").at(-1)!) as {
    error: { code: string; message: string };
  };
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /--id/);
});

test("tunnel rejects --env with an http target", async () => {
  const { result, stderr } = await captureProcessOutput(() =>
    main(
      [
        "node",
        "mcpjam",
        "tunnel",
        "http://localhost:9090/mcp",
        "--id",
        "x",
        "--env",
        "A=1",
        "--format",
        "json",
      ],
      { telemetry: telemetryDisabled },
    ),
  );

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(stderr.trim().split("\n").at(-1)!) as {
    error: { code: string; message: string };
  };
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /--env and --cwd/);
});
