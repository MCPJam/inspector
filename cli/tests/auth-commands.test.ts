import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/index.js";

const telemetryDisabled = {
  env: {
    ...process.env,
    MCPJAM_TELEMETRY_DISABLED: "1",
  },
};

async function captureProcessOutput<T>(
  fn: () => Promise<T>,
  onStderr?: (stderr: string) => void
): Promise<{
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
      ...rest
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      onStderr?.(stderr);
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

const ENTERPRISE_ORG = {
  id: "org-1",
  name: "Acme",
  plan: "enterprise",
  myRole: "member",
  isCreator: false,
  logoUrl: null,
  createdAt: null,
};

/**
 * The MCPJam API, login settings and sign-in provider `login` and `whoami`
 * talk to. `status`, `body` and `delayMs` shape the `/me` answer.
 */
async function startAccountFixture(options: {
  status?: number;
  body?: unknown;
  delayMs?: number;
  organizationsStatus?: number;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let origin = "";
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
    if (pathname === "/api/cli/auth/config") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: origin,
          clientId: "client-1",
          authStartUrl: `${origin}/api/cli/auth/start`,
          tokenEndpoint: `${origin}/oauth2/token`,
          redirectUri: `${origin}/api/cli/auth/callback`,
        })
      );
      return;
    }
    if (pathname === "/oauth2/token") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        })
      );
      return;
    }
    if (pathname === "/api/v1/organizations") {
      res.statusCode = options.organizationsStatus ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          res.statusCode === 200
            ? { items: [ENTERPRISE_ORG] }
            : { code: "INTERNAL_ERROR", message: "Organizations are down" }
        )
      );
      return;
    }
    if (req.url?.endsWith("/me")) {
      const reply = () => {
        if (res.destroyed) return;
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
              // The legacy per-user field: "free" for everyone, whatever
              // the organization pays for. Neither command may report it.
              plan: "free",
              createdAt: null,
              updatedAt: null,
            }
          )
        );
      };
      if (options.delayMs) {
        setTimeout(reply, options.delayMs);
        return;
      }
      reply();
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "no route" }));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl: `${origin}/api/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

test("whoami reports the account behind an sk_ API key", async () => {
  const fixture = await startAccountFixture({});
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "whoami",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled }
      )
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.email, "dev@example.com");
    assert.deepEqual(payload.organizations, [
      { id: "org-1", name: "Acme", plan: "enterprise" },
    ]);
    assert.equal("plan" in payload, false);
    assert.equal(payload.credential, "api-key");
  } finally {
    await fixture.close();
  }
});

test("whoami lists each organization's plan in human output", async () => {
  const fixture = await startAccountFixture({});
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "whoami",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled }
      )
    );

    assert.equal(run.result.exitCode, 0, run.stderr);
    assert.match(run.stdout, /"name": "Acme"/);
    assert.match(run.stdout, /"plan": "enterprise"/);
    assert.doesNotMatch(run.stdout, /"free"/);
  } finally {
    await fixture.close();
  }
});

test("whoami fails when the organization lookup fails", async () => {
  const fixture = await startAccountFixture({ organizationsStatus: 500 });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "whoami",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled }
      )
    );

    assert.equal(run.result.exitCode, 1);
    assert.equal(run.stdout, "");
    assert.match(
      JSON.parse(run.stderr).error.message,
      /Organizations are down/
    );
  } finally {
    await fixture.close();
  }
});

test("whoami surfaces UNAUTHORIZED with login guidance", async () => {
  const fixture = await startAccountFixture({
    status: 401,
    body: { code: "UNAUTHORIZED", message: "Invalid API key" },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "whoami",
          "--api-key",
          "sk_bad",
          "--api-url",
          fixture.baseUrl,
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled }
      )
    );

    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.error.code, "UNAUTHORIZED");
    assert.match(payload.error.message, /mcpjam cloud login/);
  } finally {
    await fixture.close();
  }
});

test("login hard-errors on an invalid --api-url before any network call", async () => {
  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "cloud", "login", "--api-url", "not-a-url"], {
      telemetry: telemetryDisabled,
    })
  );

  assert.equal(run.result.exitCode, 2);
  const payload = JSON.parse(run.stderr);
  assert.equal(payload.error.code, "USAGE_ERROR");
  assert.match(payload.error.message, /--api-url/);
});

/**
 * `cloud login --no-browser` against the fixture, playing the browser: the
 * sign-in page would send it back to the CLI with a code.
 */
async function runLogin(baseUrl: string, format: "json" | "human") {
  const authFile = join(
    await mkdtemp(join(tmpdir(), "mcpjam-auth-")),
    "auth.json"
  );
  const originalAuthFile = process.env.MCPJAM_AUTH_FILE;
  process.env.MCPJAM_AUTH_FILE = authFile;
  let callback: Promise<string> | undefined;
  try {
    const run = await captureProcessOutput(
      () =>
        main(
          [
            "node",
            "mcpjam",
            "cloud",
            "login",
            "--api-url",
            baseUrl,
            "--no-browser",
            "--format",
            format,
          ],
          { telemetry: telemetryDisabled }
        ),
      (stderr) => {
        const printed =
          /Open this URL in your browser to continue:\s+(\S+)/.exec(stderr);
        if (!printed || callback) return;
        const authorize = new URL(printed[1]!);
        const redirect = new URL(
          authorize.searchParams.get("redirect_uri") ?? ""
        );
        redirect.searchParams.set("code", "code-1");
        redirect.searchParams.set(
          "state",
          authorize.searchParams.get("state") ?? ""
        );
        callback = fetch(redirect).then((response) => response.text());
      }
    );
    await callback;
    const saved = JSON.parse(await readFile(authFile, "utf8")) as Record<
      string,
      unknown
    >;
    return { ...run, saved };
  } finally {
    if (originalAuthFile === undefined) delete process.env.MCPJAM_AUTH_FILE;
    else process.env.MCPJAM_AUTH_FILE = originalAuthFile;
  }
}

test("login reports each organization's plan and no account plan", async () => {
  const fixture = await startAccountFixture({});
  try {
    const run = await runLogin(fixture.baseUrl, "json");

    assert.equal(run.result.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, "logged_in");
    assert.equal(payload.email, "dev@example.com");
    assert.deepEqual(payload.organizations, [
      { id: "org-1", name: "Acme", plan: "enterprise" },
    ]);
    assert.equal("plan" in payload, false);
    assert.equal(run.saved.email, "dev@example.com");
    assert.equal("plan" in run.saved, false);
  } finally {
    await fixture.close();
  }
});

test("login lists each organization's plan in human output", async () => {
  const fixture = await startAccountFixture({});
  try {
    const run = await runLogin(fixture.baseUrl, "human");

    assert.equal(run.result.exitCode, 0, run.stderr);
    assert.match(run.stdout, /"name": "Acme"/);
    assert.match(run.stdout, /"plan": "enterprise"/);
    assert.doesNotMatch(run.stdout, /"free"/);
  } finally {
    await fixture.close();
  }
});

test("login still succeeds when the organization lookup fails", async () => {
  const fixture = await startAccountFixture({ organizationsStatus: 500 });
  try {
    const run = await runLogin(fixture.baseUrl, "json");

    assert.equal(run.result.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, "logged_in");
    assert.equal(payload.email, "dev@example.com");
    assert.equal("organizations" in payload, false);
    assert.equal(run.saved.accessToken, "access-1");
    assert.match(run.stderr, /Could not load organizations after login/);
  } finally {
    await fixture.close();
  }
});

test("whoami honors the global timeout option", async () => {
  const fixture = await startAccountFixture({ delayMs: 100 });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "whoami",
          "--api-key",
          "sk_test",
          "--api-url",
          fixture.baseUrl,
          "--timeout",
          "20",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled }
      )
    );

    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.error.code, "TIMEOUT");
    assert.match(payload.error.message, /20ms/);
  } finally {
    await fixture.close();
  }
});

test("whoami hard-errors on an explicit legacy key", async () => {
  const run = await captureProcessOutput(() =>
    main(["node", "mcpjam", "cloud", "whoami", "--api-key", "mcpjam_legacy"], {
      telemetry: telemetryDisabled,
    })
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
      main(["node", "mcpjam", "cloud", "logout", "--format", "json"], {
        telemetry: telemetryDisabled,
      })
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

test("logout warns on human stderr when MCPJAM_API_KEY remains active", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  const originalAuthFile = process.env.MCPJAM_AUTH_FILE;
  const originalApiKey = process.env.MCPJAM_API_KEY;
  process.env.MCPJAM_AUTH_FILE = path.join(directory, "auth.json");
  process.env.MCPJAM_API_KEY = "sk_still_active";

  try {
    const human = await captureProcessOutput(() =>
      main(["node", "mcpjam", "cloud", "logout", "--format", "human"], {
        telemetry: telemetryDisabled,
      })
    );
    assert.equal(human.result.exitCode, 0);
    assert.match(human.stderr, /MCPJAM_API_KEY is still set/);

    const json = await captureProcessOutput(() =>
      main(["node", "mcpjam", "cloud", "logout", "--format", "json"], {
        telemetry: telemetryDisabled,
      })
    );
    assert.equal(json.result.exitCode, 0);
    assert.doesNotMatch(json.stderr, /MCPJAM_API_KEY is still set/);
    assert.equal(JSON.parse(json.stdout).status, "not_logged_in");
  } finally {
    if (originalAuthFile === undefined) delete process.env.MCPJAM_AUTH_FILE;
    else process.env.MCPJAM_AUTH_FILE = originalAuthFile;
    if (originalApiKey === undefined) delete process.env.MCPJAM_API_KEY;
    else process.env.MCPJAM_API_KEY = originalApiKey;
  }
});
