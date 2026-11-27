import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerClientsCommands } from "../src/commands/clients.js";
import { registerSessionsCommands } from "../src/commands/sessions.js";
import { addPlatformOptions } from "../src/lib/platform-command.js";
import {
  effortShorthand,
  parseEffortFlag,
} from "../src/lib/model-selection-flags.js";
import { buildSetBlock } from "../src/commands/clients.js";

/**
 * `--effort` and the whole-selection flags.
 *
 * The property: an effort reaches the wire as the field the API takes (never
 * silently dropped), the shorthand EDITS the selection the target already has
 * (and refuses, naming `modelSelection`, when there is none), and a level
 * outside the union is a local usage error rather than a server round trip.
 */

const SELECTION = {
  modelId: "openai/gpt-5",
  source: "hosted",
  settings: { reasoningEffort: "medium" },
  fallback: { provider: "none", model: "none" },
};

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const cloud = program.command("cloud");
  addPlatformOptions(cloud);
  registerClientsCommands(cloud);
  registerSessionsCommands(cloud);
  return program;
}

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

type Request = { url: string; method: string; body?: unknown };
const realFetch = globalThis.fetch;
const realWrite = process.stdout.write;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
});

function stubApi(routes: Record<string, unknown>): Request[] {
  const requests: Request[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = String(target);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const path = new URL(url).pathname.replace("/api/v1", "");
    if (path === "/projects") return Response.json({ items: [PROJECT] });
    for (const [pattern, value] of Object.entries(routes)) {
      if (new RegExp(pattern).test(`${method} ${path}`)) {
        return Response.json(value);
      }
    }
    return Response.json({ code: "NOT_FOUND", message: url }, { status: 404 });
  }) as typeof fetch;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  return requests;
}

const run = (args: string[]) =>
  buildProgram().parseAsync(["cloud", ...args, "--api-key", "sk_test"], {
    from: "user",
  });

test("parseEffortFlag accepts every level, case-insensitively, and refuses the rest", () => {
  assert.equal(parseEffortFlag("HIGH"), "high");
  assert.equal(parseEffortFlag("xhigh"), "xhigh");
  assert.throws(() => parseEffortFlag("turbo"), /--effort expects one of/);
});

test("effortShorthand: null removes, both flags together is refused", () => {
  assert.equal(effortShorthand({}), undefined);
  assert.equal(effortShorthand({ clearEffort: true }), null);
  assert.equal(effortShorthand({ effort: "low" }), "low");
  assert.throws(
    () => effortShorthand({ effort: "low", clearEffort: true }),
    /either --effort or --clear-effort/
  );
});

test("clients update --set modelSelection parses JSON and --unset clears it", () => {
  // The block is a null-prototype object; compare its JSON, not its identity.
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(
    plain(
      buildSetBlock([`modelSelection=${JSON.stringify(SELECTION)}`], undefined)
    ),
    { modelSelection: SELECTION }
  );
  assert.deepEqual(plain(buildSetBlock(undefined, ["modelSelection"])), {
    modelSelection: null,
  });
});

test("sessions send --effort reaches the request body", async () => {
  const requests = stubApi({
    "^POST /chat-sessions/messages$": {
      sessionId: "s1",
      turnId: "t1",
      projectId: "project-1",
      persisted: { outcome: "saved" },
    },
  });
  await run([
    "sessions",
    "send",
    "--project",
    "Acme",
    "--model",
    "openai/gpt-5",
    "--message",
    "hi",
    "--idempotency-key",
    "k1",
    "--effort",
    "high",
  ]).catch(() => undefined);
  const post = requests.find((request) => request.method === "POST");
  assert.ok(post, "expected a POST to /chat-sessions/messages");
  assert.equal((post.body as Record<string, unknown>).reasoningEffort, "high");
  assert.ok(!("temperature" in (post.body as Record<string, unknown>)));
});

test("sessions send --no-servers preserves an empty target and omits an unspecified model", async () => {
  const requests = stubApi({
    "^POST /chat-sessions/messages$": { sessionId: "s1", turnId: "t1", projectId: "project-1", persisted: { outcome: "saved" } },
  });
  await run(["sessions", "send", "--project", "Acme", "--no-servers", "--message", "hi", "--idempotency-key", "empty"]);
  const post = requests.find((request) => request.method === "POST");
  assert.ok(post);
  assert.deepEqual((post.body as Record<string, unknown>).serverIds, []);
  assert.ok(!("modelId" in (post.body as Record<string, unknown>)));
});

test("sessions send refuses conflicting server flags before sending", async () => {
  const requests = stubApi({});
  await assert.rejects(run(["sessions", "send", "--project", "Acme", "--no-servers", "--server", "s1", "--message", "hi", "--idempotency-key", "conflict"]), /either --server or --no-servers/);
  assert.equal(requests.filter((r) => r.method === "POST").length, 0);
});
