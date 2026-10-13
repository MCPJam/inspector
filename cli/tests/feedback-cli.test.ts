import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerFeedbackCommand } from "../src/commands/feedback.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";

/**
 * `mcpjam cloud feedback` — a report about MCPJam itself, sent to the team.
 *
 * What these pin: the flags reach the POST body through the operation's own
 * schema (a bad `--kind` is a usage error and never a request); the retry key
 * rides the idempotency header and the CLI declares itself as the launcher;
 * and no project is assumed — not the MCPJAM_PROJECT one, not a linked one.
 */

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerFeedbackCommand(cloud);
  return program;
}

const RECEIPT = { id: "fb_1", receivedAt: 1_750_000_000_000, duplicate: false };

type Captured = { url: string; init?: RequestInit };

function stubFetch(
  feedbackResponse: () => Response = () => Response.json(RECEIPT, { status: 201 })
): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = String(target);
    requests.push({ url, init });
    if (/\/projects(\?|$)/.test(url)) {
      return Response.json({
        items: [
          {
            id: "project-1",
            name: "Checkout",
            description: null,
            icon: null,
            organizationId: "org-a",
            visibility: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      });
    }
    if (url.endsWith("/api/v1/feedback")) return feedbackResponse();
    return Response.json(
      { code: "NOT_FOUND", message: `No route for ${url}` },
      { status: 404 }
    );
  }) as typeof fetch;
  return requests;
}

function feedbackRequest(requests: Captured[]): {
  body: Record<string, unknown>;
  headers: Headers;
} {
  const request = requests.find((candidate) =>
    candidate.url.endsWith("/api/v1/feedback")
  );
  assert.ok(request, "expected a POST to /api/v1/feedback");
  assert.equal(request.init?.method, "POST");
  return {
    body: JSON.parse(String(request.init?.body)) as Record<string, unknown>,
    headers: new Headers(request.init?.headers as HeadersInit),
  };
}

async function run(args: string[]): Promise<void> {
  await buildProgram().parseAsync(
    ["cloud", "feedback", ...args, "--api-key", "sk_test"],
    { from: "user" }
  );
}

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write;
const realProject = process.env.MCPJAM_PROJECT;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
  if (realProject === undefined) delete process.env.MCPJAM_PROJECT;
  else process.env.MCPJAM_PROJECT = realProject;
});

function silenceStdout(): string[] {
  const written: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return written;
}

test("rejects a kind outside the enum without any request", async () => {
  const requests = stubFetch();
  await assert.rejects(
    run(["--kind", "praise", "--summary", "nice work"]),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Invalid input: kind/);
      return true;
    }
  );
  assert.equal(requests.length, 0);
});

test("rejects --details with --details-file without any request", async () => {
  const requests = stubFetch();
  await assert.rejects(
    run([
      "--kind",
      "bug",
      "--summary",
      "crash",
      "--details",
      "inline",
      "--details-file",
      "notes.txt",
    ]),
    /--details or --details-file, not both/
  );
  assert.equal(requests.length, 0);
});

test("forwards the report in the body, the key as a header, and the CLI as launcher", async () => {
  const requests = stubFetch();
  silenceStdout();
  await run([
    "--kind",
    "missing_capability",
    "--summary",
    "  cannot export a suite  ",
    "--details",
    "Wanted YAML; no export command exists.",
    "--operation",
    "cloud eval export",
    "--request-id",
    "req_0123456789abcdef",
    "--error-code",
    "FEATURE_NOT_SUPPORTED",
    "--idempotency-key",
    "key-a",
  ]);

  const { body, headers } = feedbackRequest(requests);
  assert.deepEqual(body, {
    kind: "missing_capability",
    summary: "cannot export a suite",
    details: "Wanted YAML; no export command exists.",
    operation: "cloud eval export",
    requestId: "req_0123456789abcdef",
    errorCode: "FEATURE_NOT_SUPPORTED",
  });
  assert.equal(headers.get("idempotency-key"), "key-a");
  const launcher = JSON.parse(headers.get("x-mcpjam-launcher") ?? "null") as {
    kind?: string;
    client?: string;
  };
  assert.equal(launcher.kind, "cli");
  assert.equal(launcher.client, "mcpjam-cli");
});

test("reads --details from a file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-feedback-"));
  const file = path.join(directory, "details.md");
  await writeFile(file, "Tried X, expected Y, got Z.\n", "utf8");
  const requests = stubFetch();
  silenceStdout();
  await run(["--kind", "bug", "--summary", "crash", "--details-file", file]);
  assert.equal(
    feedbackRequest(requests).body.details,
    "Tried X, expected Y, got Z."
  );
});

test("assumes no project, not even MCPJAM_PROJECT", async () => {
  process.env.MCPJAM_PROJECT = "project-1";
  const requests = stubFetch();
  silenceStdout();
  await run(["--kind", "bug", "--summary", "crash"]);
  assert.equal(
    requests.some((request) => /\/projects(\?|$)/.test(request.url)),
    false
  );
  assert.equal("projectId" in feedbackRequest(requests).body, false);
});

test("resolves a named --project to its id", async () => {
  const requests = stubFetch();
  silenceStdout();
  await run(["--kind", "bug", "--summary", "crash", "--project", "Checkout"]);
  assert.equal(feedbackRequest(requests).body.projectId, "project-1");
});

test("prints the receipt", async () => {
  stubFetch(() =>
    Response.json({ ...RECEIPT, duplicate: true }, { status: 201 })
  );
  const written = silenceStdout();
  await run(["--kind", "bug", "--summary", "crash"]);
  const printed = JSON.parse(written.join("")) as Record<string, unknown>;
  assert.deepEqual(printed, { ...RECEIPT, duplicate: true });
});

test("a failing report does not suggest filing a report", async () => {
  stubFetch(() =>
    Response.json(
      { code: "INTERNAL_ERROR", message: "Something broke." },
      { status: 500, headers: { "x-request-id": "req_0123456789abcdef" } }
    )
  );
  await assert.rejects(
    run(["--kind", "bug", "--summary", "crash"]),
    (error: unknown) => {
      assert.equal((error as Error).message, "Something broke.");
      assert.deepEqual((error as { details?: unknown }).details, {
        requestId: "req_0123456789abcdef",
      });
      return true;
    }
  );
});
