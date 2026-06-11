import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { main } from "../src/index.js";

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

  // Only capture string writes (the CLI's output). Binary chunks are the
  // node:test runner's child-process reporting protocol and must keep
  // flowing to the real stdout or the runner breaks.
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

async function startMeFixture(options: {
  status?: number;
  body?: unknown;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith("/me")) {
      res.statusCode = options.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          options.body ?? {
            id: "user-1",
            email: "dev@example.com",
            name: "Dev",
            imageUrl: null,
            profilePictureUrl: null,
            plan: "pro",
            createdAt: null,
            updatedAt: null,
          },
        ),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "no route" }));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("whoami reports the account behind an sk_ API key", async () => {
  const fixture = await startMeFixture({});
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "whoami",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.email, "dev@example.com");
    assert.equal(payload.plan, "pro");
    assert.equal(payload.credential, "api-key");
  } finally {
    await fixture.close();
  }
});

test("whoami surfaces UNAUTHORIZED with login guidance", async () => {
  const fixture = await startMeFixture({
    status: 401,
    body: { code: "UNAUTHORIZED", message: "Invalid API key" },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "whoami",
          "--api-key",
          "sk_bad",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.error.code, "UNAUTHORIZED");
    assert.match(payload.error.message, /mcpjam login/);
  } finally {
    await fixture.close();
  }
});

test("whoami hard-errors on an explicit legacy key", async () => {
  const run = await captureProcessOutput(() =>
    main(
      ["node", "mcpjam", "whoami", "--api-key", "mcpjam_legacy"],
      { telemetry: telemetryDisabled },
    ),
  );

  assert.equal(run.result.exitCode, 2);
  const payload = JSON.parse(run.stderr);
  assert.equal(payload.error.code, "USAGE_ERROR");
});

test("logout without a stored login reports not_logged_in", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  const originalAuthFile = process.env.MCPJAM_AUTH_FILE;
  process.env.MCPJAM_AUTH_FILE = path.join(directory, "auth.json");

  try {
    const run = await captureProcessOutput(() =>
      main(["node", "mcpjam", "logout", "--format", "json"], {
        telemetry: telemetryDisabled,
      }),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, "not_logged_in");
    assert.ok(payload.authFile.endsWith("auth.json"));
  } finally {
    if (originalAuthFile === undefined) delete process.env.MCPJAM_AUTH_FILE;
    else process.env.MCPJAM_AUTH_FILE = originalAuthFile;
  }
});
