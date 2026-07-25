import assert from "node:assert/strict";
import test from "node:test";
import { runInputRequiredOperation } from "@mcpjam/sdk";
import type {
  InputRequests,
  InputResponses,
  MrtrLegSender,
} from "@mcpjam/sdk";
import {
  coerceFieldValue,
  createStdinMrtrCollector,
  MrtrCollectAbortError,
  parseElicitationFields,
  resolveNonInteractive,
  type LineReader,
} from "../src/lib/mrtr-input.js";

/** A scripted line reader: returns queued answers in order, records prompts. */
function scriptedReader(lines: string[]): LineReader & { prompts: string[] } {
  const queue = [...lines];
  const prompts: string[] = [];
  return {
    prompts,
    async question(prompt: string) {
      prompts.push(prompt);
      if (queue.length === 0) {
        throw new Error(`Reader exhausted at prompt: ${prompt}`);
      }
      return queue.shift() as string;
    },
  };
}

const answerSchema = {
  type: "object" as const,
  properties: { answer: { type: "string" as const } },
  required: ["answer"],
};

function elicit(
  key: string,
  extra: Record<string, unknown> = {},
): InputRequests {
  return {
    [key]: {
      method: "elicitation/create",
      params: { message: `About ${key}?`, requestedSchema: answerSchema, ...extra },
    },
  } as unknown as InputRequests;
}

// ── resolveNonInteractive ───────────────────────────────────────────────────

test("resolveNonInteractive: --yes forces decline", () => {
  assert.equal(resolveNonInteractive({ yes: true, stdinIsTTY: true, env: {} }), true);
});

test("resolveNonInteractive: CI forces decline", () => {
  assert.equal(
    resolveNonInteractive({ stdinIsTTY: true, env: { CI: "1" } }),
    true,
  );
});

test("resolveNonInteractive: non-TTY forces decline", () => {
  assert.equal(resolveNonInteractive({ stdinIsTTY: false, env: {} }), true);
});

test("resolveNonInteractive: interactive TTY stays interactive", () => {
  assert.equal(resolveNonInteractive({ stdinIsTTY: true, env: {} }), false);
});

// ── schema parsing / coercion ───────────────────────────────────────────────

test("parseElicitationFields extracts ordered typed fields", () => {
  const fields = parseElicitationFields({
    type: "object",
    properties: {
      name: { type: "string", title: "Name" },
      age: { type: "integer" },
      color: { enum: ["red", "green"], enumNames: ["Red", "Green"] },
    },
    required: ["name"],
  });
  assert.deepEqual(
    fields.map((f) => [f.key, f.type, f.required]),
    [
      ["name", "string", true],
      ["age", "integer", false],
      ["color", "enum", false],
    ],
  );
  assert.deepEqual(fields[2]?.enumValues, ["red", "green"]);
});

test("coerceFieldValue coerces and validates by type", () => {
  assert.deepEqual(coerceFieldValue("42", { key: "n", type: "integer", required: true }), {
    value: 42,
  });
  assert.deepEqual(coerceFieldValue("yes", { key: "b", type: "boolean", required: true }), {
    value: true,
  });
  assert.throws(() =>
    coerceFieldValue("abc", { key: "n", type: "number", required: true }),
  );
  // Optional blank skips the key entirely.
  assert.deepEqual(coerceFieldValue("", { key: "s", type: "string", required: false }), {
    skip: true,
  });
  // Required blank throws.
  assert.throws(() => coerceFieldValue("", { key: "s", type: "string", required: true }));
  // Enum by 1-based index.
  assert.deepEqual(
    coerceFieldValue("2", {
      key: "c",
      type: "enum",
      required: true,
      enumValues: ["a", "b"],
    }),
    { value: "b" },
  );
});

test("parseElicitationFields treats oneOf/anyOf const branches as an enum", () => {
  const fields = parseElicitationFields({
    type: "object",
    properties: {
      color: {
        oneOf: [
          { const: "red", title: "Red" },
          { const: "green", title: "Green" },
        ],
      },
    },
    required: ["color"],
  });
  assert.equal(fields[0]?.type, "enum");
  assert.deepEqual(fields[0]?.enumValues, ["red", "green"]);
  assert.deepEqual(fields[0]?.enumNames, ["Red", "Green"]);
});

test("parseElicitationFields parses a multi-select array of enum items", () => {
  const fields = parseElicitationFields({
    type: "object",
    properties: {
      tags: { type: "array", items: { enum: ["a", "b", "c"] } },
    },
    required: ["tags"],
  });
  assert.equal(fields[0]?.type, "array");
  assert.deepEqual(fields[0]?.enumValues, ["a", "b", "c"]);
});

test("coerceFieldValue collects an enum array as string[] (values and indexes)", () => {
  assert.deepEqual(
    coerceFieldValue("a, 3", {
      key: "tags",
      type: "array",
      required: true,
      enumValues: ["a", "b", "c"],
    }),
    { value: ["a", "c"] },
  );
});

test("coerceFieldValue collects a free-form scalar array by item type", () => {
  assert.deepEqual(
    coerceFieldValue("1, 2, 3", {
      key: "nums",
      type: "array",
      required: true,
      itemType: "integer",
    }),
    { value: [1, 2, 3] },
  );
});

test("collector uses null-prototype maps for server-assigned keys", async () => {
  const reader = scriptedReader(["d"]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  // JSON.parse makes `__proto__` an OWN enumerable key, as a wire response would.
  const proto = JSON.parse(
    '{"__proto__": {"method": "elicitation/create", "params": {}}}',
  );
  const responses = (await collector({
    state: {} as never,
    inputRequests: proto as unknown as InputRequests,
  })) as InputResponses;
  // `__proto__` became an OWN property (not a prototype mutation).
  assert.ok(Object.prototype.hasOwnProperty.call(responses, "__proto__"));
  assert.deepEqual(
    (responses as Record<string, unknown>).__proto__,
    { action: "decline" },
  );
});

// ── collector: accept / decline / cancel via stdin ─────────────────────────

test("collector accepts a form field and builds ElicitResult content", async () => {
  const reader = scriptedReader(["a", "bananas"]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  const responses = (await collector({
    state: {} as never,
    inputRequests: elicit("q"),
  })) as InputResponses;
  // Content is a null-prototype map (server-assigned keys); normalize for compare.
  assert.deepEqual(JSON.parse(JSON.stringify(responses.q)), {
    action: "accept",
    content: { answer: "bananas" },
  });
});

test("collector declines cleanly (no exception)", async () => {
  const reader = scriptedReader(["d"]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  const responses = (await collector({
    state: {} as never,
    inputRequests: elicit("q"),
  })) as InputResponses;
  assert.deepEqual(responses.q, { action: "decline" });
});

test("collector cancels and short-circuits remaining keys", async () => {
  const reader = scriptedReader(["c"]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  const two = { ...elicit("q1"), ...elicit("q2") } as InputRequests;
  const responses = (await collector({
    state: {} as never,
    inputRequests: two,
  })) as InputResponses;
  // q1 cancelled by the user; q2 auto-filled as cancel (every key answered).
  assert.deepEqual(responses.q1, { action: "cancel" });
  assert.deepEqual(responses.q2, { action: "cancel" });
});

test("collector collects every key in a multi-input round", async () => {
  const reader = scriptedReader(["a", "one", "a", "two"]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  const two = { ...elicit("q1"), ...elicit("q2") } as InputRequests;
  const responses = (await collector({
    state: {} as never,
    inputRequests: two,
  })) as InputResponses;
  assert.deepEqual(JSON.parse(JSON.stringify(responses.q1)), {
    action: "accept",
    content: { answer: "one" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(responses.q2)), {
    action: "accept",
    content: { answer: "two" },
  });
});

// ── URL mode: printed as plain text, consent only, never auto-open ──────────

test("collector prints URL as plain text and returns consent", async () => {
  const reader = scriptedReader(["a"]);
  let out = "";
  const collector = createStdinMrtrCollector({
    reader,
    write: (t) => {
      out += t;
    },
  });
  const responses = (await collector({
    state: {} as never,
    inputRequests: elicit("u", { mode: "url", url: "https://auth.example/x" }),
  })) as InputResponses;
  assert.deepEqual(responses.u, { action: "accept" });
  assert.match(out, /https:\/\/auth\.example\/x/);
});

// ── non-interactive: decline every request, never read stdin ────────────────

test("non-interactive declines every request without reading stdin", async () => {
  const reader = scriptedReader([]); // must never be consulted
  const collector = createStdinMrtrCollector({
    reader,
    write: () => {},
    nonInteractive: true,
  });
  const two = { ...elicit("q1"), ...elicit("q2") } as InputRequests;
  const responses = (await collector({
    state: {} as never,
    inputRequests: two,
  })) as InputResponses;
  assert.deepEqual(responses.q1, { action: "decline" });
  assert.deepEqual(responses.q2, { action: "decline" });
  assert.equal(reader.prompts.length, 0);
});

// ── abort rejects (never a synthetic decline) ───────────────────────────────

test("collector rejects on an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const reader = scriptedReader(["a", "x"]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  await assert.rejects(
    collector({
      state: {} as never,
      inputRequests: elicit("q"),
      signal: controller.signal,
    }),
    MrtrCollectAbortError,
  );
});

// ── end-to-end through the real SDK driver loop (all three verbs) ───────────

/**
 * A fake sender emulating a modern server that answers `input_required` on the
 * first leg and completes on the retry carrying the accepted content. Drives
 * the REAL `runInputRequiredOperation` loop (as the manager would) so the
 * terminal collector is exercised across the three entry verbs end to end.
 */
function makeFakeSender(
  method: "tools/call" | "prompts/get" | "resources/read",
): { sender: MrtrLegSender; legs: number } {
  const box = { sender: undefined as unknown as MrtrLegSender, legs: 0 };
  box.sender = async (request) => {
    box.legs += 1;
    const answered = (
      request.params.inputResponses as Record<string, { content?: { answer?: string } }> | undefined
    )?.q?.content?.answer;
    if (!answered) {
      return {
        resultType: "input_required" as const,
        inputRequests: {
          q: {
            method: "elicitation/create",
            params: { message: "answer?", requestedSchema: answerSchema },
          },
        },
        requestState: `${method}-state-1`,
      } as never;
    }
    return { completed: method, answer: answered } as never;
  };
  return box as { sender: MrtrLegSender; legs: number };
}

for (const method of ["tools/call", "prompts/get", "resources/read"] as const) {
  test(`interactive ${method} completes through an input_required round`, async () => {
    const reader = scriptedReader(["a", "final-answer"]);
    const collector = createStdinMrtrCollector({ reader, write: () => {} });
    const fake = makeFakeSender(method);
    const result = (await runInputRequiredOperation({
      method,
      params: { name: "x" },
      sender: fake.sender,
      collectInput: collector,
    })) as { completed: string; answer: string };
    assert.equal(result.completed, method);
    assert.equal(result.answer, "final-answer");
    assert.equal(fake.legs, 2); // initial input_required + completing retry
  });
}
