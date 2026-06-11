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

const PROJECTS = [
  {
    id: "proj-alpha",
    name: "Alpha",
    description: null,
    icon: null,
    organizationId: "org-1",
    visibility: null,
    createdAt: 1,
    updatedAt: 200,
  },
  {
    id: "proj-beta",
    name: "Beta",
    description: null,
    icon: null,
    organizationId: "org-1",
    visibility: null,
    createdAt: 2,
    updatedAt: 100,
  },
];

const SERVERS = [
  {
    id: "srv-ready",
    projectId: "proj-alpha",
    name: "Ready Server",
    enabled: true,
    transportType: "http",
    url: "https://ready.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "srv-oauth",
    projectId: "proj-alpha",
    name: "OAuth Server",
    enabled: true,
    transportType: "http",
    url: "https://oauth.example.com/mcp",
    useOAuth: true,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "srv-limited",
    projectId: "proj-alpha",
    name: "Limited Server",
    enabled: true,
    transportType: "http",
    url: "https://limited.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "srv-stdio",
    projectId: "proj-alpha",
    name: "Stdio Server",
    enabled: true,
    transportType: "stdio",
    url: null,
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
];

const READY_DOCTOR = {
  target: { kind: "http" },
  generatedAt: "2026-06-11T00:00:00.000Z",
  status: "ready",
  probe: {
    url: "https://ready.example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: { selected: "streamable-http", attempts: [] },
    initialize: {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "ready-server", version: "2.0.0" },
    },
    oauth: { required: false, optional: false, registrationStrategies: [] },
  },
  connection: { status: "connected", detail: "Connected." },
  initInfo: null,
  capabilities: {},
  tools: [{ name: "echo", description: "Echo a message." }],
  toolsMetadata: {},
  resources: [],
  resourceTemplates: [],
  prompts: [],
  checks: {
    probe: { status: "ok", detail: "ok" },
    connection: { status: "ok", detail: "ok" },
    initialization: { status: "ok", detail: "ok" },
    capabilities: { status: "ok", detail: "ok" },
    tools: { status: "ok", detail: "1 tool discovered." },
    resources: { status: "ok", detail: "0 resources discovered." },
    resourceTemplates: { status: "ok", detail: "ok" },
    prompts: { status: "ok", detail: "0 prompts discovered." },
  },
  error: null,
};

async function startPlatformFixture(): Promise<{
  baseUrl: string;
  authHeaders: string[];
  close: () => Promise<void>;
}> {
  const authHeaders: string[] = [];
  const server: Server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain body
    }
    authHeaders.push(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS, nextCursor: "cursor-1" }));
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/servers") {
      res.end(JSON.stringify({ items: SERVERS }));
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/servers/srv-ready/doctor"
    ) {
      res.end(JSON.stringify(READY_DOCTOR));
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/servers/srv-oauth/doctor"
    ) {
      res.statusCode = 401;
      res.end(
        JSON.stringify({
          code: "OAUTH_REQUIRED",
          message: "Server requires an OAuth grant",
          details: { oauthRequired: true },
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/servers/srv-limited/doctor"
    ) {
      res.statusCode = 429;
      res.setHeader("retry-after", "7");
      res.end(JSON.stringify({ code: "RATE_LIMITED", message: "Slow down" }));
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
    authHeaders,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function startDelayedProjectsFixture(delayMs: number): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain body
    }
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/projects") {
      setTimeout(() => {
        if (!res.destroyed) {
          res.end(JSON.stringify({ items: PROJECTS }));
        }
      }, delayMs);
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

function projectsArgv(fixtureUrl: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "projects",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    fixtureUrl,
  ];
}

test("projects commands honor the global timeout option", async () => {
  const fixture = await startDelayedProjectsFixture(100);
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "list"),
          "--timeout",
          "20",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.error.code, "TIMEOUT");
    assert.match(payload.error.message, /20ms/);
  } finally {
    await fixture.close();
  }
});

test("command-level deadline spanning multiple requests still reports TIMEOUT", async () => {
  // Each request stays under the per-request budget; the OVERALL command
  // deadline fires during the second one. The command controller's armed
  // PlatformApiError must surface (not a bare AbortError -> INTERNAL_ERROR).
  const server: Server = createServer((req, res) => {
    setTimeout(() => {
      if (!res.destroyed) {
        const url = new URL(req.url ?? "/", "http://fixture");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            url.pathname === "/api/v1/projects"
              ? { items: PROJECTS }
              : { items: [] },
          ),
        );
      }
    }, 100);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(baseUrl, "status"),
          "--timeout",
          "150",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.error.code, "TIMEOUT");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("projects list emits items as JSON and a table as human output", async () => {
  const fixture = await startPlatformFixture();
  try {
    const jsonRun = await captureProcessOutput(() =>
      main(
        [...projectsArgv(fixture.baseUrl, "list"), "--format", "json"],
        {
          telemetry: telemetryDisabled,
        },
      ),
    );
    assert.equal(jsonRun.result.exitCode, 0);
    const payload = JSON.parse(jsonRun.stdout);
    // Sorted most recently updated first.
    assert.deepEqual(
      payload.items.map((project: { id: string }) => project.id),
      ["proj-alpha", "proj-beta"],
    );
    // Operation payload passthrough: pagination fields are preserved.
    assert.equal(payload.nextCursor, "cursor-1");
    assert.equal(fixture.authHeaders[0], "Bearer sk_test");

    const humanRun = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "list"),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(humanRun.result.exitCode, 0);
    assert.match(humanRun.stdout, /ID\s+NAME\s+UPDATED/);
    assert.match(humanRun.stdout, /proj-alpha\s+Alpha/);
    assert.match(humanRun.stdout, /2 project\(s\)\./);
  } finally {
    await fixture.close();
  }
});

test("projects servers resolves the project by name", async () => {
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "--project",
            "alpha",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.project.id, "proj-alpha");
    assert.equal(payload.items.length, SERVERS.length);
    assert.deepEqual(payload.otherProjects, [
      { id: "proj-beta", name: "Beta" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("projects servers surfaces unknown projects as NOT_FOUND", async () => {
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "servers", "--project", "nope"),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stderr);
    assert.equal(payload.error.code, "NOT_FOUND");
    assert.match(payload.error.message, /Available projects/);
  } finally {
    await fixture.close();
  }
});

test("projects status maps doctor outcomes onto per-server statuses", async () => {
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "status"),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    // Status report: exit 0 even with unreachable/error servers.
    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout);
    const statusById = new Map(
      payload.servers.map((server: { id: string; status: string }) => [
        server.id,
        server.status,
      ]),
    );
    assert.equal(statusById.get("srv-ready"), "reachable");
    assert.equal(statusById.get("srv-oauth"), "reachable");
    assert.equal(statusById.get("srv-limited"), "error");
    assert.equal(statusById.get("srv-stdio"), "skipped");
    assert.deepEqual(payload.summary, {
      reachable: 2,
      unreachable: 0,
      skipped: 1,
      error: 1,
    });

    const limited = payload.servers.find(
      (server: { id: string }) => server.id === "srv-limited",
    );
    assert.match(limited.statusDetail, /RATE_LIMITED/);
    assert.match(limited.statusDetail, /Retry after 7s/);

    const ready = payload.servers.find(
      (server: { id: string }) => server.id === "srv-ready",
    );
    assert.equal(ready.serverInfo.name, "ready-server");
    assert.equal(ready.primitives.tools.items.length, 1);
  } finally {
    await fixture.close();
  }
});

test("projects status renders a human summary", async () => {
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "status"),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.match(run.stdout, /Project: Alpha \(proj-alpha\)/);
    assert.match(run.stdout, /✓ Ready Server \[reachable\]/);
    assert.match(run.stdout, /! Limited Server \[error\]/);
    assert.match(run.stdout, /- Stdio Server \[skipped\]/);
    assert.match(
      run.stdout,
      /Summary: 2 reachable, 0 unreachable, 1 skipped, 1 error\(s\)\./,
    );
    assert.match(run.stdout, /Other projects: Beta/);
  } finally {
    await fixture.close();
  }
});
