/**
 * `mcpjam readiness submission handoff|findings|finding|export|events` and the
 * records `status|snapshot|import-finding`.
 *
 * What these pin: each verb sends the route, query and body the handoff API
 * documents; stdout carries only the result (the JSON, or the export's exact
 * bytes) while progress and hints go to stderr; `findings --all` follows the
 * cursor to the last page, in the project the first page was read in; a flag
 * of the wrong kind is refused before any request; the directory's words
 * reach the API unchanged from a file or a pipe; a refused write exits 1 with
 * the API's reason on stderr; and no command takes a secret or prints one.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerReadinessCommands } from "../src/commands/readiness.js";
import { CliError } from "../src/lib/output.js";
import { captureProcessOutput, runCli } from "./support/cli-run.js";

const PROJECT = {
  id: "project-1",
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
/** Updated after PROJECT, so it is the default project once it exists. */
const NEWER = { ...PROJECT, id: "project-2", name: "Billing", updatedAt: 9 };
const SERVER = {
  id: "server-1",
  projectId: PROJECT.id,
  name: "markets",
  enabled: true,
  transportType: "http",
  url: "https://mcp.example.com/mcp",
  createdAt: 1,
  updatedAt: 2,
};
const ONE = "/api/v1/projects/project-1/directory-submissions/sub-1";
const LISTING = "claude.submission.listing-fields";

type Reply = { status?: number; body: unknown };
type Captured = { key: string; query: Record<string, string>; body: unknown };

/**
 * The API the commands reach. Each route answers its replies in order; the
 * project list answers `projects` in order and then repeats the last one.
 */
function stubFetch(routes: Record<string, Reply[]>, projects: unknown[][] = [[PROJECT]]): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) {
      return Response.json({ items: projects.length > 1 ? projects.shift() : projects[0] });
    }
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
    const reply = routes[key]?.shift();
    if (!reply) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerReadinessCommands(program);
  return program;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exitCode = 0;
});

/** One command against the stubbed API: what it printed on each stream. */
function run(args: string[]) {
  return captureProcessOutput(() =>
    buildProgram().parseAsync(["readiness", "submission", ...args, "--api-key", "sk_test"], { from: "user" })
  );
}

/** The whole CLI, as `main` runs it, with no saved login or Cloud settings of this machine. */
async function runWhole(args: string[]) {
  const isolated: Record<string, string | undefined> = {
    MCPJAM_API_KEY: undefined,
    MCPJAM_API_URL: undefined,
    MCPJAM_PROJECT: undefined,
    MCPJAM_PROJECT_ID: undefined,
    MCPJAM_AUTH_FILE: path.join(tmpdir(), "mcpjam-no-auth.json"),
  };
  const previous = Object.fromEntries(Object.keys(isolated).map((key) => [key, process.env[key]]));
  const assign = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  assign(isolated);
  try {
    return await runCli(["readiness", "submission", ...args]);
  } finally {
    assign(previous);
  }
}

function rejectsWith(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  };
}

function textFile(contents: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mcpjam-said-")), "said.txt");
  writeFileSync(file, contents);
  return file;
}

function findingRow(index: number) {
  return {
    checkId: `claude.check-${index}`,
    runId: "run-1",
    step: "listing",
    lane: "submission-artifacts",
    class: "required",
    status: "violated",
    title: `Check ${index}`,
    provenance: "declared",
    evaluatedAt: 1,
    engineVersion: "test",
    updatedAt: 2,
    hasDetails: false,
  };
}

const rows = (from: number, count: number) => Array.from({ length: count }, (_, index) => findingRow(from + index));
const ids = (findings: Array<{ checkId: string }>) => findings.map((finding) => finding.checkId);

const HANDOFF = {
  submission: {
    id: "sub-1",
    projectId: PROJECT.id,
    revision: 4,
    updatedAt: 2,
    flowVersion: "2026-11-13",
    flowId: "claude-connector",
    flowTitle: "Claude connector",
    directory: "claude",
    rulesVersion: "2026-11-13",
    refs: {},
  },
  status: null,
  currentStep: "listing",
  verdict: { verdict: "not-ready", failing: [LISTING], undetermined: [], notCheckedOnPath: [], notCheckedReasons: {} },
  blockers: [{ checkId: LISTING, title: "Listing fields", step: "listing" }],
  missingRequired: [{ key: "listing.name", step: "listing", label: "Name" }],
  credentials: {
    secrets: [{ key: "reviewer.passwordSecret", label: "Password", secretName: "MCPJAM_REVIEWER_PASSWORD" }],
    saved: null,
    tested: null,
    delivered: null,
  },
  nextActions: [
    {
      operation: "update_directory_submission",
      why: "1 answer the portal needs is missing or invalid. Send a value for each field.",
      input: { project: PROJECT.id, submission: "sub-1", expectedRevision: 4 },
      fields: ["listing.name"],
    },
    {
      operation: "get_directory_submission_finding",
      why: "Read what the first blocker found, with its evidence, before you fix it.",
      input: { project: PROJECT.id, submission: "sub-1", check: LISTING },
    },
  ],
  remainingPortalActions: [],
  unknowns: [],
  links: { submissionUrl: "https://claude.ai/settings/connectors/submit", managementUrl: null, statusLink: null },
};

/** The pack as the export route serves it: `content` is the file's bytes. */
const PACK_JSON = `${JSON.stringify(
  {
    kind: "mcpjam.directory-submission-export",
    submission: { id: "sub-1" },
    answers: [{ key: "reviewer.passwordSecret", value: "MCPJAM_REVIEWER_PASSWORD", secret: true }],
  },
  null,
  2
)}\n`;
const PACK_MARKDOWN = "# Claude connector: sub-1\n\nNo status is recorded.\n";

function packFile(format: "json" | "markdown", content: string, filename?: string) {
  const json = format === "json";
  const name = filename ?? `claude-connector-sub-1-r4.${json ? "json" : "md"}`;
  return { format, filename: name, mediaType: json ? "application/json" : "text/markdown", content };
}

const EVENT = {
  id: "evt-1",
  submissionId: "sub-1",
  projectId: PROJECT.id,
  kind: "status",
  reportedOrObserved: "reported",
  state: "submitted",
  actor: "user-1",
  createdAt: 3,
};

test("handoff prints the summary as the API built it, then each next action as the command that takes it", async () => {
  const requests = stubFetch({ [`GET ${ONE}/handoff`]: [{ body: HANDOFF }] });
  const { stdout, stderr } = await run(["handoff", "sub-1", "--json"]);
  const { project, ...summary } = JSON.parse(stdout) as { project: { id: string } };
  assert.equal(project.id, PROJECT.id);
  assert.deepEqual(summary, HANDOFF);
  assert.equal(requests.length, 1);
  assert.equal(
    stderr,
    [
      "Next:",
      "  mcpjam readiness submission set: 1 answer the portal needs is missing or invalid. Send a value for each field.",
      "  mcpjam readiness submission finding: Read what the first blocker found, with its evidence, before you fix it.",
      "",
    ].join("\n")
  );
});

test("--quiet keeps stderr empty while stdout stays the JSON", async () => {
  stubFetch({ [`GET ${ONE}/handoff`]: [{ body: HANDOFF }] });
  const result = await runWhole(["handoff", "sub-1", "--json", "--quiet", "--api-key", "sk_test"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal((JSON.parse(result.stdout) as { currentStep: string }).currentStep, "listing");
});

/** Run `fn` as if `stream` were a terminal. */
async function asTerminal<T>(stream: NodeJS.ReadStream | NodeJS.WriteStream, fn: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    if (before) Object.defineProperty(stream, "isTTY", before);
    else Reflect.deleteProperty(stream, "isTTY");
  }
}

test("--json prints JSON on one line in a terminal, where the default is the indented form", async () => {
  stubFetch({ [`GET ${ONE}/events`]: [{ body: { items: [EVENT] } }, { body: { items: [EVENT] } }] });
  const [indented, json] = await asTerminal(process.stdout, async () => [
    await run(["events", "sub-1"]),
    await run(["events", "sub-1", "--json"]),
  ]);
  assert.match(indented!.stdout.trim(), /\n/);
  assert.doesNotMatch(json!.stdout.trim(), /\n/);
  assert.deepEqual(JSON.parse(json!.stdout), JSON.parse(indented!.stdout));
});

test("findings sends its filters and, when more pages follow, says how to read them", async () => {
  const requests = stubFetch({ [`GET ${ONE}/findings`]: [{ body: { items: rows(0, 25), nextCursor: "c1" } }] });
  const { stdout, stderr } = await run([
    "findings",
    "sub-1",
    "--status",
    "violated",
    "--step",
    "listing",
    "--lane",
    "submission-artifacts",
  ]);
  assert.deepEqual(requests[0]!.query, { status: "violated", step: "listing", lane: "submission-artifacts" });
  const printed = JSON.parse(stdout) as { findings: unknown[]; nextCursor: string };
  assert.equal(printed.findings.length, 25);
  assert.equal(printed.nextCursor, "c1");
  assert.equal(stderr, "Showing the first 25 findings. Pass --all to read every page.\n");
});

test("findings --all follows the cursor past 50 findings, in the project the first page was read in", async () => {
  // A project updated in between becomes the default; later pages must not move to it.
  const requests = stubFetch(
    {
      [`GET ${ONE}/findings`]: [
        { body: { items: rows(0, 50), nextCursor: "c1" } },
        { body: { items: rows(50, 50), nextCursor: "c2" } },
        { body: { items: rows(100, 20) } },
      ],
    },
    [[PROJECT], [NEWER, PROJECT]]
  );
  const { stdout, stderr } = await run(["findings", "sub-1", "--status", "violated", "--all", "--json"]);
  // The whole of stdout is one JSON document; progress went to stderr.
  const printed = JSON.parse(stdout) as { submissionId: string; findings: Array<{ checkId: string }> };
  assert.deepEqual(ids(printed.findings), ids(rows(0, 120)));
  assert.equal("nextCursor" in printed, false);
  assert.equal(printed.submissionId, "sub-1");
  assert.deepEqual(
    requests.map((request) => request.query),
    [
      { status: "violated", limit: "100" },
      { status: "violated", limit: "100", cursor: "c1" },
      { status: "violated", limit: "100", cursor: "c2" },
    ]
  );
  assert.equal(stderr, "Read 50 findings. Reading the next page.\nRead 100 findings. Reading the next page.\n");
});

test("findings --all stops on a cursor it has already followed", async () => {
  stubFetch({
    [`GET ${ONE}/findings`]: [
      { body: { items: rows(0, 1), nextCursor: "c1" } },
      { body: { items: rows(1, 1), nextCursor: "c1" } },
    ],
  });
  await assert.rejects(
    run(["findings", "sub-1", "--all"]),
    rejectsWith("OPERATIONAL_ERROR", /same findings page twice after 2 findings/)
  );
});

test("findings and events refuse a status or kind the API does not have, before any request", async () => {
  const requests = stubFetch({});
  await assert.rejects(run(["findings", "sub-1", "--status", "failed"]), rejectsWith("USAGE_ERROR", /^status: /));
  await assert.rejects(run(["events", "sub-1", "--kind", "comment"]), rejectsWith("USAGE_ERROR", /^kind: /));
  assert.deepEqual(requests, []);
});

test("finding reads one check, with the observation behind it", async () => {
  const stored = { ...findingRow(0), checkId: "claude.endpoint.https", hasDetails: true, details: { status: 301 } };
  const requests = stubFetch({ [`GET ${ONE}/findings/claude.endpoint.https`]: [{ body: stored }] });
  const { stdout } = await run(["finding", "sub-1", "claude.endpoint.https"]);
  const printed = JSON.parse(stdout) as { submissionId: string; finding: unknown };
  assert.deepEqual(printed.finding, stored);
  assert.equal(printed.submissionId, "sub-1");
  assert.equal(requests.length, 1);
});

test("export prints the pack byte for byte as the API serves it, JSON or Markdown", async () => {
  const requests = stubFetch({
    [`GET ${ONE}/export`]: [{ body: packFile("json", PACK_JSON) }, { body: packFile("markdown", PACK_MARKDOWN) }],
  });
  const json = await run(["export", "sub-1"]);
  const markdown = await run(["export", "sub-1", "--markdown"]);
  assert.equal(json.stdout, PACK_JSON);
  assert.equal(markdown.stdout, PACK_MARKDOWN);
  assert.equal(json.stderr + markdown.stderr, "");
  assert.deepEqual(
    requests.map((request) => request.query),
    [{}, { format: "markdown" }]
  );

  // `--format` belongs to the program, so the pack's format is a flag of its own.
  const misnamed = await runWhole(["export", "sub-1", "--format", "markdown", "--api-key", "sk_test"]);
  assert.equal(misnamed.exitCode, 2);
  assert.match(misnamed.stderr, /For the Markdown pack, pass --markdown\./);
  assert.equal(requests.length, 2);
});

test("export --out saves the same bytes and prints where they went, never the pack", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "mcpjam-export-"));
  const file = path.join(folder, "nested", "pack.json");
  stubFetch({
    [`GET ${ONE}/export`]: [
      { body: packFile("json", PACK_JSON) },
      // The name is the server's: it must not take the pack out of the folder.
      { body: packFile("markdown", PACK_MARKDOWN, "../../outside.md") },
    ],
  });
  const saved = await run(["export", "sub-1", "--out", file]);
  assert.equal(readFileSync(file, "utf8"), PACK_JSON);
  const receipt = JSON.parse(saved.stdout) as Record<string, unknown>;
  assert.deepEqual(
    { ...receipt, project: undefined },
    {
      project: undefined,
      submissionId: "sub-1",
      format: "json",
      filename: "claude-connector-sub-1-r4.json",
      mediaType: "application/json",
      path: file,
      bytes: Buffer.byteLength(PACK_JSON),
    }
  );

  const inFolder = await run(["export", "sub-1", "--markdown", "--out", folder]);
  assert.equal(readFileSync(path.join(folder, "outside.md"), "utf8"), PACK_MARKDOWN);
  assert.equal((JSON.parse(inFolder.stdout) as { path: string }).path, path.join(folder, "outside.md"));
});

test("events lists what was recorded, of one kind when asked", async () => {
  const requests = stubFetch({ [`GET ${ONE}/events`]: [{ body: { items: [EVENT] } }] });
  const { stdout } = await run(["events", "sub-1", "--kind", "status"]);
  assert.deepEqual(requests[0]!.query, { kind: "status" });
  assert.deepEqual((JSON.parse(stdout) as { events: unknown[] }).events, [EVENT]);
});

test("status records the stage as reported unless --observed, with the directory's words and evidence", async () => {
  const requests = stubFetch({ [`POST ${ONE}/events`]: [{ status: 201, body: EVENT }, { status: 201, body: EVENT }] });
  await run([
    "status",
    "sub-1",
    "--state",
    "submitted",
    "--directory-label",
    "Pending review",
    "--uncertain",
    "--link",
    "https://claude.ai/settings/connectors/1",
    "--reference",
    "REF-1",
    "--detail",
    "The submit dialog stayed busy.",
    "--evidence",
    "url=https://claude.ai/settings/connectors/1?tab=status",
  ]);
  const observed = await run(["status", "sub-1", "--state", "in-review", "--observed", "--idempotency-key", "k-1"]);
  assert.deepEqual(requests[0]!.body, {
    kind: "status",
    reportedOrObserved: "reported",
    state: "submitted",
    uncertain: true,
    directoryLabel: "Pending review",
    detail: "The submit dialog stayed busy.",
    link: "https://claude.ai/settings/connectors/1",
    reference: "REF-1",
    evidence: { kind: "url", value: "https://claude.ai/settings/connectors/1?tab=status" },
  });
  assert.deepEqual(requests[1]!.body, {
    kind: "status",
    reportedOrObserved: "observed",
    state: "in-review",
    idempotencyKey: "k-1",
  });
  assert.deepEqual((JSON.parse(observed.stdout) as { event: unknown }).event, EVENT);
  assert.equal(observed.stderr, "");
});

test("status refuses a stage or evidence the API does not take, before any request", async () => {
  const requests = stubFetch({});
  const status = (...args: string[]) => run(["status", "sub-1", ...args]);
  await assert.rejects(status("--state", "done"), rejectsWith("USAGE_ERROR", /^state: /));
  await assert.rejects(
    status("--state", "submitted", "--evidence", "https://claude.ai"),
    rejectsWith("USAGE_ERROR", /--evidence takes kind=value/)
  );
  await assert.rejects(status("--state", "submitted", "--evidence", "photo=a.png"), rejectsWith("USAGE_ERROR", /^evidence\.kind: /));
  await assert.rejects(status(), /--state/);
  assert.deepEqual(requests, []);
});

test("a replayed record says on stderr that nothing new was recorded", async () => {
  stubFetch({ [`POST ${ONE}/events`]: [{ status: 200, body: { ...EVENT, replayed: true } }] });
  const { stdout, stderr } = await run(["status", "sub-1", "--state", "submitted", "--idempotency-key", "k-1"]);
  assert.equal((JSON.parse(stdout) as { event: { replayed: boolean } }).event.replayed, true);
  assert.equal(stderr, "This idempotency key already recorded event evt-1. Nothing new was recorded.\n");
});

test("snapshot names the copy, the revision it holds and the saved server", async () => {
  const requests = stubFetch({ [`POST ${ONE}/events`]: [{ status: 201, body: { ...EVENT, kind: "snapshot" } }] });
  await run([
    "snapshot",
    "sub-1",
    "--label",
    "directory",
    "--revision",
    "7",
    "--server",
    "markets",
    "--captured-at",
    "2026-11-13T09:30:00Z",
    "--note",
    "The portal listed 12 tools.",
    "--evidence",
    "text=Tools (12)",
    "--observed",
  ]);
  assert.deepEqual(requests[0]!.body, {
    kind: "snapshot",
    reportedOrObserved: "observed",
    evidence: { kind: "text", value: "Tools (12)" },
    snapshot: {
      label: "directory",
      serverId: SERVER.id,
      revisionNumber: 7,
      capturedAt: Date.parse("2026-11-13T09:30:00Z"),
      note: "The portal listed 12 tools.",
    },
  });
});

test("snapshot refuses a copy, revision or time it cannot record, before any request", async () => {
  const requests = stubFetch({});
  const snapshot = (...args: string[]) => run(["snapshot", "sub-1", ...args]);
  await assert.rejects(snapshot("--label", "live"), /Allowed choices are candidate, production, directory, published/);
  await assert.rejects(snapshot("--label", "directory", "--revision", "0"), rejectsWith("USAGE_ERROR", /--revision/));
  await assert.rejects(
    snapshot("--label", "directory", "--captured-at", "yesterday"),
    rejectsWith("USAGE_ERROR", /--captured-at takes a date and time/)
  );
  assert.deepEqual(requests, []);
});

const WORDS = 'Rejected: "Search" calls $API_URL and `rm -rf` twice.\n\nReply by Friday.';
const SAID = { ...EVENT, kind: "directory-finding" };

test("import-finding sends the directory's words from a file as they are, less the file's last line ending", async () => {
  const requests = stubFetch({ [`POST ${ONE}/events`]: [{ status: 201, body: SAID }] });
  await run([
    "import-finding",
    "sub-1",
    "--text-file",
    textFile(`${WORDS}\n`),
    "--via",
    "email",
    "--severity",
    "blocking",
    "--code",
    "P-4",
    "--submission-version",
    "1.2.0",
    "--received-at",
    "2026-11-12T08:00:00Z",
    "--link",
    "https://mail.example.com/message/1",
  ]);
  assert.deepEqual(requests[0]!.body, {
    kind: "directory-finding",
    reportedOrObserved: "reported",
    link: "https://mail.example.com/message/1",
    finding: {
      text: WORDS,
      via: "email",
      severity: "blocking",
      code: "P-4",
      version: "1.2.0",
      receivedAt: Date.parse("2026-11-12T08:00:00Z"),
    },
  });
});

test("import-finding takes the words from a file or a pipe only, and refuses empty ones, before any request", async () => {
  const requests = stubFetch({});
  const said = (...args: string[]) => run(["import-finding", "sub-1", "--via", "email", ...args]);
  const file = textFile(WORDS);
  await assert.rejects(said(), rejectsWith("USAGE_ERROR", /--text-file <path>, or pipe them in with --text -/));
  await assert.rejects(said("--text-file", file, "--text", "-"), rejectsWith("USAGE_ERROR", /--text-file <path>, or pipe/));
  await assert.rejects(said("--text", "Rejected"), rejectsWith("USAGE_ERROR", /--text reads stdin only/));
  await assert.rejects(said("--text-file", textFile(" \n")), rejectsWith("USAGE_ERROR", /holds no text/));
  await assert.rejects(said("--text-file", path.join(tmpdir(), "mcpjam-missing", "said.txt")), rejectsWith("USAGE_ERROR", /Could not read/));
  await assert.rejects(
    run(["import-finding", "sub-1", "--text-file", file, "--via", "fax"]),
    rejectsWith("USAGE_ERROR", /^via: /)
  );
  // A terminal on stdin means nothing was piped in.
  await assert.rejects(
    asTerminal(process.stdin, () => said("--text", "-")),
    rejectsWith("USAGE_ERROR", /nothing is piped in/)
  );
  assert.deepEqual(requests, []);
});

const CLI_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("import-finding --text - sends the words piped in, unchanged", async (t) => {
  if (!existsSync(CLI_ENTRY)) {
    t.skip("cli/dist is not built; run through `npm run test:fast`, which builds it first");
    return;
  }
  const bodies: unknown[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://api");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/api/v1/projects") {
        response.end(JSON.stringify({ items: [PROJECT] }));
        return;
      }
      if (request.method === "POST" && url.pathname === `${ONE}/events`) {
        bodies.push(JSON.parse(raw));
        response.statusCode = 201;
        response.end(JSON.stringify(SAID));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "NOT_FOUND", message: `No route for ${url.pathname}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCPJAM_AUTH_FILE: path.join(tmpdir(), "mcpjam-no-auth.json"),
    MCPJAM_TELEMETRY_DISABLED: "1",
    NO_UPDATE_NOTIFIER: "1",
  };
  for (const key of ["MCPJAM_API_KEY", "MCPJAM_API_URL", "MCPJAM_PROJECT", "MCPJAM_PROJECT_ID"]) delete env[key];
  const args = ["readiness", "submission", "import-finding", "sub-1", "--text", "-", "--via", "portal"];
  const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI_ENTRY, ...args, "--api-key", "sk_test", "--api-url", `http://127.0.0.1:${port}/api/v1`],
      { encoding: "utf8", timeout: 60_000, env },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })
    );
    child.stdin?.end(`${WORDS}\n`);
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(bodies, [{ kind: "directory-finding", reportedOrObserved: "reported", finding: { text: WORDS, via: "portal" } }]);
  assert.deepEqual((JSON.parse(result.stdout) as { event: unknown }).event, SAID);
});

test("a refused write exits 1 with the API's reason on stderr, and never repeats what was refused", async () => {
  const token = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZXZpZXdlciJ9.c2lnbmF0dXJlLXZhbHVl";
  const message =
    "This event holds what looks like a credential. Remove it, and name the project secret that holds it instead.";
  stubFetch({ [`POST ${ONE}/events`]: [{ status: 400, body: { code: "VALIDATION_ERROR", message } }] });
  const result = await runWhole([
    "import-finding",
    "sub-1",
    "--text-file",
    textFile(`The reviewer signed in with ${token}`),
    "--via",
    "email",
    "--api-key",
    "sk_test",
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  const { error } = JSON.parse(result.stderr.trim().split("\n").at(-1)!) as { error: { code: string; message: string } };
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.equal(error.message, message);
  assert.doesNotMatch(result.stderr, /eyJhbGci/);
});

const COMMANDS = ["handoff", "findings", "finding", "export", "events", "status", "snapshot", "import-finding"];

test("no handoff or record command has a flag for a secret's value", () => {
  const submission = buildProgram()
    .commands.find((command) => command.name() === "readiness")!
    .commands.find((command) => command.name() === "submission")!;
  // Every hosted command signs in to MCPJam itself; none of these is a submission's secret.
  const signIn = new Set(["--api-key", "--api-url", "--api-header"]);
  for (const name of COMMANDS) {
    const command = submission.commands.find((candidate) => candidate.name() === name);
    assert.ok(command, `readiness submission ${name} is not registered`);
    const flags = command.options.map((option) => option.long ?? "").filter((flag) => !signIn.has(flag));
    assert.deepEqual(
      flags.filter((flag) => /secret|password|token|credential|value/i.test(flag)),
      [],
      `readiness submission ${name} takes a secret`
    );
  }
});

test("no command prints the API key or an edge header, whether its call succeeds or is refused", async () => {
  const key = "sk_live_handoffSampleKey";
  const header = "edge-sample-credential";
  stubFetch({
    [`GET ${ONE}/handoff`]: [{ body: HANDOFF }],
    [`GET ${ONE}/findings`]: [{ body: { items: rows(0, 2), nextCursor: "c1" } }, { body: { items: rows(2, 1) } }],
    [`GET ${ONE}/findings/claude.check-0`]: [{ body: findingRow(0) }],
    [`GET ${ONE}/export`]: [{ body: packFile("json", PACK_JSON) }],
    [`GET ${ONE}/events`]: [{ body: { items: [EVENT] } }],
    [`POST ${ONE}/events`]: [
      { status: 201, body: EVENT },
      { status: 201, body: { ...EVENT, kind: "snapshot" } },
      {
        status: 403,
        body: {
          code: "FORBIDDEN",
          message: "Directory readiness is not available for your organization.",
          details: { code: "FEATURE_UNAVAILABLE", feature: "directory-readiness" },
        },
      },
    ],
  });
  const runs = [
    ["handoff", "sub-1"],
    ["findings", "sub-1", "--all"],
    ["finding", "sub-1", "claude.check-0"],
    ["export", "sub-1"],
    ["events", "sub-1"],
    ["status", "sub-1", "--state", "submitted"],
    ["snapshot", "sub-1", "--label", "production"],
    ["import-finding", "sub-1", "--text-file", textFile(WORDS), "--via", "email"],
  ];
  assert.deepEqual(
    runs.map(([name]) => name),
    COMMANDS
  );
  for (const args of runs) {
    const result = await runWhole([...args, "--api-key", key, "--api-header", `X-Edge-Auth: ${header}`]);
    const printed = result.stdout + result.stderr;
    assert.equal(result.exitCode, args[0] === "import-finding" ? 1 : 0, `${args[0]}: ${result.stderr}`);
    assert.ok(!printed.includes(key) && !printed.includes(header), `readiness submission ${args[0]} printed a credential`);
  }
});
