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

/** Cloud audience lines share stderr with structured errors. Parse the JSON object. */
function parseStderrJson(stderr: string): {
  error: { code: string; message: string };
} {
  const line = stderr
    .trim()
    .split("\n")
    .reverse()
    .find((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error(`no JSON object in stderr:\n${stderr}`);
  }
  return JSON.parse(line);
}

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
  requestUrls: string[];
  close: () => Promise<void>;
}> {
  const authHeaders: string[] = [];
  // Recorded so a test can assert what a flag actually put ON THE WIRE. The
  // auth header alone cannot distinguish "sent the filter" from "quietly sent
  // no filter and listed everything".
  const requestUrls: string[] = [];
  const server: Server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain body
    }
    authHeaders.push(req.headers.authorization ?? "");
    requestUrls.push(req.url ?? "");
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
    if (url.pathname === "/api/v1/projects/proj-alpha/servers/srv-ready") {
      // Exact match, so it cannot shadow the `/doctor` route above.
      res.end(JSON.stringify(SERVERS[0]));
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
    requestUrls,
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
    "cloud",
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
    const payload = parseStderrJson(run.stderr);
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
    const payload = parseStderrJson(run.stderr);
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

    // No flag: no filter on the wire, not an empty one.
    assert.ok(
      fixture.requestUrls.every((url) => !url.includes("organizationId")),
    );
  } finally {
    await fixture.close();
  }
});

test("projects list --org sends the filter, and refuses a blank one", async () => {
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "list"),
          "--org",
          "org-1",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 0);
    // The point of the flag: it must reach the query string. Asserting on
    // stdout would pass even if the filter were silently dropped, since the
    // fixture answers the same list either way.
    assert.ok(
      fixture.requestUrls.some((url) =>
        url.includes("organizationId=org-1"),
      ),
      `expected organizationId on the wire, saw: ${fixture.requestUrls.join(", ")}`,
    );

    // A supplied-but-blank value is a typo. Widening it to "every project"
    // answers the opposite of what was asked, so it must fail instead.
    const blankRun = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "list"),
          "--org",
          "   ",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.notEqual(blankRun.result.exitCode, 0);
    assert.match(blankRun.stderr, /--org/);
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
    const payload = parseStderrJson(run.stderr);
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

/**
 * A fixture for the connection flow.
 *
 * `statuses` is consumed one poll at a time, so a test can describe a request
 * that starts non-terminal and settles.
 */
async function startConnectionFixture(options: {
  created: Record<string, unknown>;
  statuses?: Array<Record<string, unknown>>;
  /** The account `/me` reports, or `null` to make the lookup fail. The connect
   * command names it beside the handoff link, because a link is bound to the
   * account that made it and the browser opening it may be signed into another
   * one. */
  me?: { email: string } | null;
}): Promise<{
  baseUrl: string;
  createBodies: unknown[];
  cancelPaths: string[];
  polls: number;
  close: () => Promise<void>;
}> {
  const createBodies: unknown[] = [];
  const cancelPaths: string[] = [];
  const remaining = [...(options.statuses ?? [])];
  let polls = 0;

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    // `connect --project <name>` resolves the name to an id before creating
    // anything, so the connection fixture has to be able to answer that too.
    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS }));
      return;
    }
    if (url.pathname === "/api/v1/me") {
      if (options.me === null) {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "nope" }));
        return;
      }
      res.end(
        JSON.stringify(
          options.me ?? { id: "u_1", email: "cli@mcpjam.test", name: "CLI" },
        ),
      );
      return;
    }
    if (url.pathname === "/api/v1/server-connections" && req.method === "POST") {
      createBodies.push(raw ? JSON.parse(raw) : null);
      res.statusCode = 201;
      res.end(JSON.stringify(options.created));
      return;
    }
    if (
      url.pathname.startsWith("/api/v1/server-connections/") &&
      url.pathname.endsWith("/cancel")
    ) {
      cancelPaths.push(url.pathname);
      res.end(JSON.stringify({ ...options.created, status: "cancelled" }));
      return;
    }
    if (url.pathname.startsWith("/api/v1/server-connections/")) {
      polls += 1;
      res.end(JSON.stringify(remaining.shift() ?? options.created));
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
    createBodies,
    cancelPaths,
    get polls() {
      return polls;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("server connect rejects a URL that is not http(s) at the keyboard", async () => {
  const fixture = await startConnectionFixture({
    created: { connectionRequestId: "scr_1", status: "awaiting_authorization" },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "file:///etc/passwd",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    // Rejected before any request: a bad URL is a typo, and finding out from
    // the API is a slower, vaguer version of the same answer.
    assert.equal(run.result.exitCode, 1);
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("server connect prints the authorization link even with --no-browser", async () => {
  const fixture = await startConnectionFixture({
    created: {
      connectionRequestId: "scr_1",
      status: "awaiting_authorization",
      handoffUrl: "https://app.mcpjam.test/connect/server/tok",
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          "--no-wait",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    // A browser that fails to launch, or launches on the wrong machine over
    // SSH, otherwise leaves the user with a request they cannot finish.
    assert.match(run.stderr, /connect\/server\/tok/);
    // `--no-wait` hands back a request id, so it must also say how to follow it
    // — and how to stop it, because a request nobody finishes holds a slot.
    assert.match(run.stderr, /connect-status --request scr_1/);
    assert.match(run.stderr, /connect-cancel --request scr_1/);
    assert.equal(run.result.exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("server connect names the account and deployment the link belongs to", async () => {
  const fixture = await startConnectionFixture({
    created: {
      connectionRequestId: "scr_1",
      status: "awaiting_authorization",
      handoffUrl: "https://app.mcpjam.test/connect/server/tok",
    },
    me: { email: "marcelo@mcpjam.test" },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          "--no-wait",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    // The link is refused unless the BROWSER is signed into this same account,
    // and nothing used to say which one that was. An agent relaying the link to
    // a person could not see either side of the mismatch.
    assert.match(run.stderr, /marcelo@mcpjam\.test/);
    // And which deployment: this CLI can be pointed at prod, staging, or a
    // local server, and a link only works on the one that minted it.
    assert.match(run.stderr, /127\.0\.0\.1:/);
    assert.equal(run.result.exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("server connect still prints the link when the account lookup fails", async () => {
  const fixture = await startConnectionFixture({
    created: {
      connectionRequestId: "scr_1",
      status: "awaiting_authorization",
      handoffUrl: "https://app.mcpjam.test/connect/server/tok",
    },
    me: null,
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          "--no-wait",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    // The connection request already succeeded. Failing the command because a
    // decorative lookup failed would trade a working result for none.
    assert.match(run.stderr, /connect\/server\/tok/);
    assert.match(run.stderr, /mcpjam cloud whoami/);
    assert.equal(run.result.exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("server connect-status reads an existing request", async () => {
  const fixture = await startConnectionFixture({
    created: { connectionRequestId: "scr_1", status: "ready" },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect-status",
            "--request",
            "scr_1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(JSON.parse(run.stdout).status, "ready");
    assert.equal(fixture.polls, 1);
  } finally {
    await fixture.close();
  }
});

test("server connect-cancel stops a pending request", async () => {
  // Without this command the only way out of an abandoned request was to wait
  // out its hour, and five of them locked the account out of connecting at all.
  const fixture = await startConnectionFixture({
    created: { connectionRequestId: "scr_1", status: "awaiting_authorization" },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect-cancel",
            "--request",
            "scr_1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(JSON.parse(run.stdout).status, "cancelled");
    assert.deepEqual(fixture.cancelPaths, [
      "/api/v1/server-connections/scr_1/cancel",
    ]);
  } finally {
    await fixture.close();
  }
});

test("server connect stops watching once the request settles", async () => {
  const fixture = await startConnectionFixture({
    created: {
      connectionRequestId: "scr_1",
      status: "validating",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    statuses: [
      { connectionRequestId: "scr_1", status: "validating" },
      { connectionRequestId: "scr_1", status: "ready" },
    ],
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(JSON.parse(run.stdout).status, "ready");
    assert.equal(fixture.polls, 2);
  } finally {
    await fixture.close();
  }
});

test("server connect exits non-zero when it gave up rather than finished", async () => {
  const fixture = await startConnectionFixture({
    created: {
      connectionRequestId: "scr_1",
      status: "awaiting_authorization",
      // Already expired, so the deadline is met on the first check.
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
    statuses: [{ connectionRequestId: "scr_1", status: "awaiting_authorization" }],
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    // A script must be able to tell "the connection is ready" from "I stopped
    // watching"; both print a status, so the exit code carries the difference.
    assert.equal(run.result.exitCode, 1);
    assert.match(run.stderr, /Stopped waiting/);
    assert.match(run.stderr, /connect-status --request scr_1/);
    assert.match(run.stderr, /connect-cancel --request scr_1/);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("a subcommand under `servers` can be given --project at all", async () => {
  // Regression. `--project` is declared on the `servers` group AND on its
  // subcommands, and Commander gives the value to whichever command declares it
  // nearest the top — so the group consumed it and the subcommand's own
  // `requiredOption` then failed the parse for not having received it. Every
  // one of `servers get|create|update|delete` was unusable: there was no way to
  // type the option they demanded.
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "get",
            "--project",
            "alpha",
            "--server",
            "srv-ready",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(JSON.parse(run.stdout).id, "srv-ready");
  } finally {
    await fixture.close();
  }
});

test("omitting --project on a subcommand that needs it is still a usage error", async () => {
  // The required-ness moved out of Commander and into the action, so it has to
  // be re-proved: the check must still fire, and with the same exit code the
  // `requiredOption` produced, or a caller who forgot the flag now gets a
  // confusing API-level failure instead of a usage message.
  const fixture = await startPlatformFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(fixture.baseUrl, "servers", "get", "--server", "srv-ready"),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /--project/);
    // It must fail at the keyboard, before spending a request on it.
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("server connect honors --project instead of silently ignoring it", async () => {
  // The same collision, in the command this feature adds. `connect` read its
  // own `options.project`, which the `servers` group had already consumed, so
  // `--project` parsed cleanly and then did nothing — the request was created
  // against the default project while the caller was told nothing.
  const fixture = await startConnectionFixture({
    created: { connectionRequestId: "scr_1", status: "awaiting_authorization" },
  });
  try {
    await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            fixture.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
            "--project",
            "proj-beta",
          ),
          "--no-wait",
          "--no-browser",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(fixture.createBodies.length, 1);
    // Not merely "a project was sent": with the bug, `projectId` was undefined
    // and the request fell through to `awaiting_project`, asking a human to
    // pick the project the caller had already named.
    const body = fixture.createBodies[0] as { projectId?: string };
    assert.equal(body.projectId, "proj-beta");
  } finally {
    await fixture.close();
  }
});

test("a failing command does not leave its exit code on the next main()", async () => {
  // Commands signal failure by setting `process.exitCode`, which `main()` reads
  // back — so the channel is a global that outlives the call. A `connect` that
  // gave up left a 1 sitting there, and the next in-process `main()` returned
  // 1 for work that had succeeded. Only the real entrypoint runs `main()` once;
  // tests, embedders and anything scripting the CLI run it repeatedly.
  const gaveUp = await startConnectionFixture({
    created: {
      connectionRequestId: "scr_1",
      status: "awaiting_authorization",
      // Already expired, so the poll loop gives up on its first check.
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  try {
    const first = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            gaveUp.baseUrl,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(first.result.exitCode, 1);
  } finally {
    await gaveUp.close();
  }

  // Deliberately NOT resetting process.exitCode between the two runs: the
  // point of the test is that the second run does not inherit the first's.
  const ok = await startPlatformFixture();
  try {
    const second = await captureProcessOutput(() =>
      main([...projectsArgv(ok.baseUrl, "list"), "--format", "json"], {
        telemetry: telemetryDisabled,
      }),
    );
    assert.equal(second.result.exitCode, 0);
  } finally {
    process.exitCode = 0;
    await ok.close();
  }
});

test("Ctrl-C during an in-flight poll returns without waiting out the request", async () => {
  // Waking the backoff sleep is only half of it. When the interrupt lands while
  // a status request is in flight, nothing re-reads the flag until that request
  // resolves — so the CLI printed "Stopped watching" and then sat there for up
  // to the request timeout, which is the hang the message exists to prevent.
  const server: Server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain body
    }
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/server-connections" && req.method === "POST") {
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          connectionRequestId: "scr_1",
          status: "awaiting_authorization",
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/api/v1/server-connections/")) {
      // Never answers. The only ways out are the request timeout and the
      // interrupt; the test asserts which one actually happens.
      process.nextTick(() => process.emit("SIGINT"));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "no route" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const startedAt = Date.now();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...projectsArgv(
            `http://127.0.0.1:${port}/api/v1`,
            "servers",
            "connect",
            "--url",
            "https://example.com/mcp",
          ),
          "--no-browser",
          // Well above the time an interrupt should take, so finishing quickly
          // can only mean the request was actually aborted.
          "--timeout",
          "30000",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.match(run.stderr, /Stopped watching/);
    assert.equal(run.result.exitCode, 1);
    assert.ok(
      Date.now() - startedAt < 10_000,
      `interrupt took ${Date.now() - startedAt}ms; the request was not aborted`,
    );
    // Nothing fresher was ever received, so the create response is what gets
    // reported rather than a crash or an invented status.
    assert.equal(JSON.parse(run.stdout).connectionRequestId, "scr_1");
  } finally {
    process.exitCode = 0;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
