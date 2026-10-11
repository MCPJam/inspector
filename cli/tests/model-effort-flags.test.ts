import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerClientsCommands } from "../src/commands/clients.js";
import { registerEnvironmentsCommands } from "../src/commands/environments.js";
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
  registerEnvironmentsCommands(cloud);
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

test("environments update --effort edits the existing selection on the wire", async () => {
  const ENV = {
    id: "env-1",
    projectId: "project-1",
    name: "Staging",
    hostId: "host-1",
    modelId: "openai/gpt-5",
    modelSelection: SELECTION,
    revision: 3,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };
  const requests = stubApi({
    "^GET /projects/project-1/environments$": { items: [ENV] },
    "^GET /projects/project-1/environments/env-1$": {
      id: "env-1",
      projectId: "project-1",
      name: "Staging",
      hostId: "host-1",
      modelId: "openai/gpt-5",
      modelSelection: SELECTION,
      revision: 3,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    },
    "^GET /projects/project-1/environments/capabilities$": {
      modelOverrides: true,
      modelSelections: true,
    },
    "^PATCH /projects/project-1/environments/env-1$": {
      id: "env-1",
      projectId: "project-1",
      name: "Staging",
      hostId: "host-1",
      revision: 4,
      archived: false,
      createdAt: 1,
      updatedAt: 3,
    },
  });
  await run([
    "environments",
    "update",
    "--project",
    "Acme",
    "--environment",
    "env-1",
    "--expected-revision",
    "3",
    "--effort",
    "high",
  ]);
  const patch = requests.find((request) => request.method === "PATCH");
  assert.ok(patch, "expected a PATCH");
  assert.deepEqual((patch.body as Record<string, unknown>).modelSelection, {
    ...SELECTION,
    settings: { reasoningEffort: "high" },
  });
});

test("environments update --effort on a STORED legacy selection is refused, naming modelSelection", async () => {
  // A legacy selection means "own key only" and carries no settings: an effort
  // cannot be edited onto it, and inventing a source would guess who pays.
  const LEGACY = { source: "legacy", modelId: "llama3" };
  const ENV = {
    id: "env-1",
    projectId: "project-1",
    name: "Staging",
    hostId: "host-1",
    modelId: "llama3",
    modelSelection: LEGACY,
    modelSelectionOrigin: "backfill",
    revision: 3,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };
  const requests = stubApi({
    "^GET /projects/project-1/environments$": { items: [ENV] },
    "^GET /projects/project-1/environments/env-1$": ENV,
    "^GET /projects/project-1/environments/capabilities$": {
      modelOverrides: true,
      modelSelections: true,
    },
  });
  await assert.rejects(
    run([
      "environments",
      "update",
      "--project",
      "Acme",
      "--environment",
      "env-1",
      "--expected-revision",
      "3",
      "--effort",
      "high",
    ]),
    /legacy model selection[\s\S]*modelSelection/
  );
  assert.equal(requests.filter((r) => r.method === "PATCH").length, 0);
});

test("environments update --model sends the bare id shorthand unchanged", async () => {
  const ENV = {
    id: "env-1",
    projectId: "project-1",
    name: "Staging",
    hostId: "host-1",
    revision: 3,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };
  const requests = stubApi({
    "^GET /projects/project-1/environments$": { items: [ENV] },
    "^GET /projects/project-1/environments/env-1$": ENV,
    "^GET /projects/project-1/environments/capabilities$": {
      modelOverrides: true,
      modelSelections: true,
    },
    "^PATCH /projects/project-1/environments/env-1$": { ...ENV, revision: 4 },
  });
  await run([
    "environments",
    "update",
    "--project",
    "Acme",
    "--environment",
    "env-1",
    "--expected-revision",
    "3",
    "--model",
    "openai/gpt-5",
  ]);
  const patch = requests.find((request) => request.method === "PATCH");
  assert.ok(patch, "expected a PATCH");
  const body = patch.body as Record<string, unknown>;
  assert.equal(body.modelId, "openai/gpt-5");
  assert.ok(!("modelSelection" in body), "the CLI never invents a selection");
});

test("environments update --effort with a level outside the union is a local usage error", async () => {
  const requests = stubApi({});
  await assert.rejects(
    run([
      "environments",
      "update",
      "--project",
      "Acme",
      "--environment",
      "env-1",
      "--expected-revision",
      "3",
      "--effort",
      "turbo",
    ]),
    /--effort expects one of/
  );
  assert.equal(requests.filter((r) => r.method !== "GET").length, 0);
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
