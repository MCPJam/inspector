import assert from "node:assert/strict";
import test from "node:test";
import { runInputRequiredOperation } from "@mcpjam/sdk";
import type {
  InputRequests,
  InputResponses,
  MrtrLegSender,
} from "@mcpjam/sdk";
import { applyInteractiveElicitationCapability } from "../src/lib/ephemeral.js";
import {
  buildMrtrBeforeConnect,
  coerceFieldValue,
  createStdinMrtrCollector,
  sanitizeTerminalText,
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

// ── schema-valid empty values for required fields ──────────────────────────

test("parseElicitationFields marks blank-able required fields", () => {
  const fields = parseElicitationFields({
    type: "object",
    properties: {
      note: { type: "string" },
      code: { type: "string", minLength: 3 },
      tags: { type: "array", items: { type: "string" } },
      picks: { type: "array", items: { type: "string" }, minItems: 2 },
      opt: { type: "string" },
    },
    required: ["note", "code", "tags", "picks"],
  });
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.note.allowEmpty, true);
  assert.equal(byKey.code.allowEmpty, undefined, "minLength > 0 forbids empty");
  assert.equal(byKey.tags.allowEmpty, true);
  assert.equal(byKey.picks.allowEmpty, undefined, "minItems > 0 forbids empty");
  // Optional fields keep the skip-the-key behavior; they are never allowEmpty.
  assert.equal(byKey.opt.allowEmpty, undefined);
});

test("coerceFieldValue accepts a blank answer when the schema permits empty", () => {
  assert.deepEqual(
    coerceFieldValue("", {
      key: "note",
      type: "string",
      required: true,
      allowEmpty: true,
    }),
    { value: "" },
  );
  assert.deepEqual(
    coerceFieldValue("", {
      key: "tags",
      type: "array",
      required: true,
      allowEmpty: true,
      itemType: "string",
    }),
    { value: [] },
  );
  // Still rejected when the schema forbids an empty value.
  assert.throws(() =>
    coerceFieldValue("", { key: "code", type: "string", required: true }),
  );
  assert.throws(() =>
    coerceFieldValue("", { key: "picks", type: "array", required: true }),
  );
  // A non-string type never gets the empty-value escape hatch.
  assert.throws(() =>
    coerceFieldValue("", {
      key: "n",
      type: "number",
      required: true,
      allowEmpty: true,
    }),
  );
});

test("collector completes a required-but-empty string field", async () => {
  const reader = scriptedReader(["a", ""]);
  const collector = createStdinMrtrCollector({ reader, write: () => {} });
  const responses = (await collector({
    state: {} as never,
    inputRequests: {
      q: {
        method: "elicitation/create",
        params: {
          message: "Notes?",
          requestedSchema: {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["note"],
          },
        },
      },
    } as unknown as InputRequests,
  })) as InputResponses;
  // Null-prototype content map (server-assigned keys); normalize for compare.
  assert.deepEqual(JSON.parse(JSON.stringify(responses.q)), {
    action: "accept",
    content: { note: "" },
  });
});

// ── terminal-control sanitization of untrusted server text ─────────────────

test("sanitizeTerminalText strips control sequences but keeps tabs", () => {
  assert.equal(sanitizeTerminalText("safe\u001b[2Jwiped\u0007"), "safe [2Jwiped ");
  assert.equal(sanitizeTerminalText("a\tb"), "a\tb");
  assert.equal(sanitizeTerminalText("line\nbreak"), "line break");
});

test("collector never writes raw control characters from server text", async () => {
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
    inputRequests: {
      u: {
        method: "elicitation/create",
        params: {
          message: "Approve\u001b[1;1H\u001b[2Jspoofed prompt",
          mode: "url",
          url: "https://evil.example/x\u001b[2K\rhttps://bank.example",
        },
      },
    } as unknown as InputRequests,
  })) as InputResponses;
  assert.deepEqual(responses.u, { action: "accept" });
  // Nothing the server sent can repaint the terminal or forge the prompt line.
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out), JSON.stringify(out));
  // The real URL still reaches the user, just neutralized.
  assert.match(out, /https:\/\/evil\.example\/x/);
});

// ── beforeConnect hook ─────────────────────────────────────────────────────

test("buildMrtrBeforeConnect only registers a collector when interactive", () => {
  assert.equal(buildMrtrBeforeConnect({}), undefined);
  const hook = buildMrtrBeforeConnect({ interactive: true, yes: true });
  assert.equal(typeof hook, "function");
  const registered: Array<[string, unknown]> = [];
  hook?.(
    {
      setMrtrInputCollector: (serverId: string, collect: unknown) =>
        void registered.push([serverId, collect]),
    } as never,
    "__cli__",
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0][0], "__cli__");
  assert.equal(typeof registered[0][1], "function");
});

// ── advertised elicitation capability ──────────────────────────────────────

test("interactive advertises both elicitation modes", () => {
  const config = applyInteractiveElicitationCapability({
    url: "https://example.test/mcp",
  } as never) as { capabilities?: Record<string, unknown> };
  // Bare `{}` would be form-only, so url-mode MRTR could never start.
  assert.deepEqual(config.capabilities?.elicitation, { form: {}, url: {} });
});

test("interactive keeps other legacy capabilities intact", () => {
  const config = applyInteractiveElicitationCapability({
    url: "https://example.test/mcp",
    capabilities: { roots: { listChanged: true } },
  } as never) as { capabilities?: Record<string, unknown> };
  assert.deepEqual(config.capabilities?.roots, { listChanged: true });
  assert.deepEqual(config.capabilities?.elicitation, { form: {}, url: {} });
});

test("interactive rejects an exact capability set without elicitation", () => {
  assert.throws(
    () =>
      applyInteractiveElicitationCapability({
        url: "https://example.test/mcp",
        clientCapabilities: {},
      } as never),
    /--interactive requires the advertised client capabilities/,
  );
});

test("interactive honors an exact capability set that declares elicitation", () => {
  const exact = { elicitation: { form: {} } };
  const config = applyInteractiveElicitationCapability({
    url: "https://example.test/mcp",
    clientCapabilities: exact,
  } as never) as { clientCapabilities?: Record<string, unknown> };
  // Host fidelity: an exact set is advertised verbatim, modes included.
  assert.deepEqual(config.clientCapabilities, exact);
});

// ── schema constraints are checked at the prompt ───────────────────────────

test("parseElicitationFields carries the checkable schema bounds", () => {
  const [text, count] = parseElicitationFields({
    type: "object",
    properties: {
      code: { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 1, maximum: 3 },
    },
    required: ["code", "count"],
  });
  assert.deepEqual(text.constraints, {
    minLength: 2,
    maxLength: 4,
    pattern: "^[a-z]+$",
  });
  assert.deepEqual(count.constraints, { minimum: 1, maximum: 3 });
});

test("coerceFieldValue rejects out-of-bound answers so the field re-prompts", () => {
  const code = {
    key: "code",
    type: "string" as const,
    required: true,
    constraints: { minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
  };
  assert.throws(() => coerceFieldValue("a", code), /at least 2/);
  assert.throws(() => coerceFieldValue("abcde", code), /at most 4/);
  assert.throws(() => coerceFieldValue("AB", code), /must match/);
  assert.deepEqual(coerceFieldValue("abc", code), { value: "abc" });

  const count = {
    key: "count",
    type: "number" as const,
    required: true,
    constraints: { minimum: 1, maximum: 3 },
  };
  assert.throws(() => coerceFieldValue("0", count), />= 1/);
  assert.throws(() => coerceFieldValue("9", count), /<= 3/);
  assert.deepEqual(coerceFieldValue("2", count), { value: 2 });

  const picks = {
    key: "picks",
    type: "array" as const,
    required: true,
    enumValues: ["a", "b", "c"],
    constraints: { minItems: 2, maxItems: 2 },
  };
  assert.throws(() => coerceFieldValue("a", picks), /at least 2/);
  assert.throws(() => coerceFieldValue("a,b,c", picks), /at most 2/);
  assert.deepEqual(coerceFieldValue("a,b", picks), { value: ["a", "b"] });
});

test("a bad answer re-prompts instead of failing the operation", async () => {
  const reader = scriptedReader(["a", "x", "abc"]);
  let out = "";
  const collector = createStdinMrtrCollector({
    reader,
    write: (t) => {
      out += t;
    },
  });
  const responses = (await collector({
    state: {} as never,
    inputRequests: {
      q: {
        method: "elicitation/create",
        params: {
          message: "Code?",
          requestedSchema: {
            type: "object",
            properties: { code: { type: "string", minLength: 2 } },
            required: ["code"],
          },
        },
      },
    } as unknown as InputRequests,
  })) as InputResponses;
  assert.match(out, /at least 2/);
  assert.deepEqual(JSON.parse(JSON.stringify(responses.q)), {
    action: "accept",
    content: { code: "abc" },
  });
});

// ── exhausted retries decline, they never reject the round ─────────────────

test("retry exhaustion declines that request and keeps the other answers", async () => {
  // q1 answers cleanly; q2 exhausts its attempts on an un-coercible number.
  const reader = scriptedReader(["a", "bananas", "a", "x", "y", "z"]);
  let out = "";
  const collector = createStdinMrtrCollector({
    reader,
    maxFieldAttempts: 3,
    write: (t) => {
      out += t;
    },
  });
  const responses = (await collector({
    state: {} as never,
    inputRequests: {
      ...elicit("q1"),
      q2: {
        method: "elicitation/create",
        params: {
          message: "How many?",
          requestedSchema: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
      },
    } as unknown as InputRequests,
  })) as InputResponses;
  // The earlier key's work survives — throwing would have discarded it.
  assert.deepEqual(JSON.parse(JSON.stringify(responses.q1)), {
    action: "accept",
    content: { answer: "bananas" },
  });
  assert.deepEqual(responses.q2, { action: "decline" });
  assert.match(out, /declining this request/);
});
