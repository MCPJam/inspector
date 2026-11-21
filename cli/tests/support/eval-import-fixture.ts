/**
 * The fake platform API and CLI drivers shared by the suite-file live
 * validation tests. It records every request and write body so a test can
 * assert that a refusal happened before anything was written.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const telemetryDisabled = {
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
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

export async function withSuiteFile<T>(
  contents: string,
  run: (file: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-import-live-"));
  const file = path.join(dir, "suite.yaml");
  await writeFile(file, contents, "utf8");
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── the fixture ──────────────────────────────────────────────────────────────

export type FixtureOptions = {
  /** Tool names per server NAME. A server absent here exposes nothing. */
  toolsByServer?: Record<string, string[]>;
  /** Servers the project holds, in list order. */
  servers?: Array<{ id: string; name: string }>;
  /** Server NAMES the project lists with `enabled: false`. */
  disabledServers?: readonly string[];
  /** Fail the project's server list with this status instead of answering. */
  serversListStatus?: number;
  /** Environment name → the server names it resolves to. */
  environments?: Record<string, string[]>;
  /**
   * Host name → the server NAMES its own config pins.
   *
   * A host runs against its own configured set, never the file's — so a host
   * here can deliberately disagree with `target.servers`, which is the only
   * way to catch a validator checking the wrong inventory.
   */
  hosts?: Record<string, string[]>;
  /** Report a host whose config carries no readable `serverIds` at all. */
  hostWithUnreadableConfig?: string;
  /**
   * Cases the suite ALREADY holds, keyed by the declared id the file uses.
   *
   * Seeding one makes that case an UPDATE at sync time while the rest are
   * creates — the only way to observe that the launcher sees
   * `[...updates, ...creates]` rather than authored file order.
   */
  existingCases?: Array<{ declaredId: string; title: string }>;
  /**
   * Paginate `tools/list` for one server NAME, so the walk has to follow a
   * cursor to see everything.
   *
   * `pages` is the tool names each page carries; `cursors` is the `nextCursor`
   * each page returns (`undefined` ends the listing). Kept as raw parallel
   * arrays rather than a page-builder so a test can hand back a deliberately
   * odd cursor — an empty string, or the same one twice.
   */
  paginatedTools?: {
    server: string;
    pages: string[][];
    cursors: Array<string | undefined>;
  };
};

export type Fixture = {
  baseUrl: string;
  requests: string[];
  fromFileBodies: unknown[];
  batchBodies: unknown[];
  updateBodies: unknown[];
  runBodies: unknown[];
  toolListings: string[];
  /** The `cursor` on each `tools/list` request, in order (absent -> undefined). */
  toolCursors: Array<string | undefined>;
  close: () => Promise<void>;
};

export async function startFixture(
  options: FixtureOptions = {}
): Promise<Fixture> {
  const servers = options.servers ?? [{ id: "srv_billing", name: "billing" }];
  const toolsByServer = options.toolsByServer ?? {
    billing: ["render_refund", "issue_refund"],
  };
  const environments = options.environments ?? {};
  const hosts = options.hosts ?? {};
  // Suite ATTACHMENTS, so `--host` gets past the launcher's own
  // "no attached hosts" guard. Separate from the host's configured server set
  // above: attachment is what the suite offers, `config.serverIds` is what the
  // host actually connects.
  const suiteHostAttachments = Object.keys(hosts).map((name, index) => ({
    id: `host_${index}`,
    name,
  }));

  const requests: string[] = [];
  const fromFileBodies: unknown[] = [];
  const batchBodies: unknown[] = [];
  const updateBodies: unknown[] = [];
  const runBodies: unknown[] = [];
  const toolListings: string[] = [];
  const toolCursors: Array<string | undefined> = [];
  const casesByDeclaredId = new Map<
    string,
    { id: string; declaredId: string; title: string }
  >();
  for (const seed of options.existingCases ?? []) {
    casesByDeclaredId.set(seed.declaredId, {
      id: `row_${seed.declaredId}`,
      declaredId: seed.declaredId,
      title: seed.title,
    });
  }

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fixture");
    const method = req.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    const body = raw ? JSON.parse(raw) : {};
    const json = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };

    if (url.pathname === "/api/v1/projects") {
      json({
        items: [
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
        ],
      });
      return;
    }

    if (url.pathname === "/api/v1/projects/proj-alpha/servers") {
      if (options.serversListStatus !== undefined) {
        json(
          { error: { code: "INTERNAL_ERROR", message: "listing failed" } },
          options.serversListStatus
        );
        return;
      }
      json({
        items: servers.map((entry) => ({
          ...entry,
          projectId: "proj-alpha",
          enabled: !options.disabledServers?.includes(entry.name),
          transportType: "http",
          url: `https://example.test/${entry.name}`,
          useOAuth: false,
          hasClientSecret: false,
          createdAt: 1,
          updatedAt: 2,
        })),
      });
      return;
    }

    const toolsMatch = url.pathname.match(
      /^\/api\/v1\/projects\/proj-alpha\/servers\/([^/]+)\/tools$/
    );
    if (toolsMatch && method === "POST") {
      const serverId = decodeURIComponent(toolsMatch[1]);
      const named = servers.find((entry) => entry.id === serverId);
      toolListings.push(serverId);
      const requestCursor = (body as { cursor?: unknown }).cursor as
        | string
        | undefined;
      toolCursors.push(requestCursor);
      const paginated = options.paginatedTools;
      if (paginated && named?.name === paginated.server) {
        // Which page a cursor refers to is this fixture's business, not the
        // client's: the cursor is opaque, so page N's cursor simply selects
        // page N+1. That keeps `""` a perfectly ordinary token here.
        const raw =
          requestCursor === undefined
            ? 0
            : paginated.cursors.findIndex(
                (issued) => issued === requestCursor
              ) + 1;
        // Clamp past the end onto the last entry, so a one-page script whose
        // cursor points back at itself models a server that reissues ONE
        // CONSTANT TOKEN forever rather than one that simply runs out.
        const index = Math.min(raw, paginated.pages.length - 1);
        json({
          items: (paginated.pages[index] ?? []).map((name) => ({
            name,
            description: name,
          })),
          ...(paginated.cursors[index] !== undefined
            ? { nextCursor: paginated.cursors[index] }
            : {}),
        });
        return;
      }
      json({
        items: (toolsByServer[named?.name ?? ""] ?? []).map((name) => ({
          name,
          description: name,
        })),
      });
      return;
    }

    if (url.pathname === "/api/v1/projects/proj-alpha/hosts") {
      json({
        items: Object.keys(hosts).map((name, index) => ({
          id: `host_${index}`,
          name,
          hostConfigId: `hc_${index}`,
          modelId: "anthropic/claude-sonnet-4-6",
          serverCount: (hosts[name] ?? []).length,
          createdAt: 1,
          updatedAt: 2,
        })),
      });
      return;
    }

    const hostMatch = url.pathname.match(
      /^\/api\/v1\/projects\/proj-alpha\/hosts\/([^/]+)$/
    );
    if (hostMatch) {
      const hostId = decodeURIComponent(hostMatch[1]);
      const name =
        Object.keys(hosts)[Number(hostId.split("_")[1] ?? "0")] ?? hostId;
      json({
        id: hostId,
        name,
        config:
          options.hostWithUnreadableConfig === name
            ? { modelId: "anthropic/claude-sonnet-4-6" }
            : {
                modelId: "anthropic/claude-sonnet-4-6",
                serverIds: (hosts[name] ?? []).map(
                  (serverName) =>
                    servers.find((entry) => entry.name === serverName)?.id ??
                    `srv_${serverName}`
                ),
              },
      });
      return;
    }

    if (url.pathname === "/api/v1/projects/proj-alpha/environments") {
      json({
        items: Object.keys(environments).map((name, index) => ({
          id: `env_${index}`,
          name,
          archived: false,
        })),
      });
      return;
    }

    const resolveMatch = url.pathname.match(
      /^\/api\/v1\/projects\/proj-alpha\/environments\/([^/]+)\/resolve$/
    );
    if (resolveMatch) {
      const environmentId = decodeURIComponent(resolveMatch[1]);
      const name =
        Object.keys(environments)[Number(environmentId.split("_")[1] ?? "0")] ??
        environmentId;
      json({
        environment: { id: environmentId, name, revision: 1 },
        hostId: "host_1",
        hostName: "Claude Desktop",
        hostConfigId: "hc_1",
        selectedServerIds: [],
        effectiveServerIds: [],
        pluginVersions: [],
        servers: (environments[name] ?? []).map((serverName) => ({
          serverId:
            servers.find((entry) => entry.name === serverName)?.id ??
            `srv_${serverName}`,
          name: serverName,
        })),
      });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/from-file" &&
      method === "POST"
    ) {
      fromFileBodies.push(body);
      json(
        {
          created: true,
          suite: {
            id: "suite-file-1",
            declaredId: body.declaredSuiteId,
            name: body.name,
            description: null,
            projectId: "proj-alpha",
            environment: { servers: ["billing"], computerEnvironment: null },
            executionConfig: { model: "anthropic/claude-sonnet-4-6" },
            hosts: suiteHostAttachments,
            environmentIds: [],
            settings: {},
            schedule: {},
            createdAt: 1,
            updatedAt: 2,
          },
        },
        201
      );
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases" &&
      method === "GET"
    ) {
      json({ items: [...casesByDeclaredId.values()] });
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/batch" &&
      method === "POST"
    ) {
      batchBodies.push(body);
      const created = (body.cases as Array<{ id?: string; title: string }>).map(
        (testCase, index) => {
          const declaredId = testCase.id ?? `minted_${index}`;
          casesByDeclaredId.set(declaredId, {
            id: `row_${declaredId}`,
            declaredId,
            title: testCase.title,
          });
          return {
            index,
            id: `row_${declaredId}`,
            declaredId,
            title: testCase.title,
            replayed: false,
          };
        }
      );
      json({ created, failed: [], duplicatePolicy: "block" }, 201);
      return;
    }

    if (
      url.pathname.startsWith(
        "/api/v1/projects/proj-alpha/eval-suites/suite-file-1/cases/"
      ) &&
      method === "PATCH"
    ) {
      updateBodies.push(body);
      json({ id: "row_c_render", title: "updated" });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-file-1" &&
      method === "GET"
    ) {
      json({
        id: "suite-file-1",
        declaredId: "s_billing",
        name: "Billing smoke",
        description: null,
        projectId: "proj-alpha",
        environment: { servers: ["billing"] },
        executionConfig: { model: "anthropic/claude-sonnet-4-6" },
        hosts: suiteHostAttachments,
        environmentIds: [],
        settings: {},
        schedule: {},
        createdAt: 1,
        updatedAt: 2,
      });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      method === "GET"
    ) {
      json({
        items: [
          {
            id: "suite-file-1",
            name: "Billing smoke",
            projectId: "proj-alpha",
            createdAt: 1,
            updatedAt: 2,
            latestRun: null,
            totals: { passed: 0, failed: 0, runs: 0 },
            passRateTrend: [],
          },
        ],
      });
      return;
    }

    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs" &&
      method === "POST"
    ) {
      runBodies.push(body);
      json(
        {
          runId: `run-${runBodies.length}`,
          suiteId: "suite-file-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [{ id: "srv_billing", name: "billing" }],
          environment: null,
        },
        202
      );
      return;
    }

    json({ error: { message: `no route ${url.pathname}` } }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("fixture server did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    fromFileBodies,
    batchBodies,
    updateBodies,
    runBodies,
    toolListings,
    toolCursors,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

export function validateArgv(file: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    "validate",
    "--file",
    file,
    ...args,
    "--format",
    "json",
  ];
}

export function runArgv(
  baseUrl: string,
  file: string,
  ...args: string[]
): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    "run",
    "--file",
    file,
    "--project",
    "Alpha",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
    "--format",
    "json",
  ];
}

export type ValidateEnvelope = {
  valid: boolean;
  projectValidation?: {
    project: { id: string; name: string };
    targets: string[];
    valid: boolean;
    findings: Array<Record<string, unknown>>;
  };
};
