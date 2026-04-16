import assert from "node:assert/strict";
import test from "node:test";
import {
  validateEvalsConfig,
  interpolateEnvVars,
} from "../src/lib/evals-config";
import { CliError } from "../src/lib/output";

function validConfig() {
  return {
    servers: {
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
    agent: {
      model: "openai/gpt-4o",
      apiKey: "sk-test-key",
    },
    tests: [
      {
        name: "addition",
        prompt: "Add 2 and 3",
        expectedToolCalls: ["add"],
      },
    ],
  };
}

test("validateEvalsConfig accepts a valid config", () => {
  const config = validateEvalsConfig(validConfig());
  assert.equal(config.agent.model, "openai/gpt-4o");
  assert.equal(config.tests.length, 1);
  assert.equal(config.tests[0].name, "addition");
});

test("validateEvalsConfig defaults matchMode to undefined (runner defaults to subset)", () => {
  const config = validateEvalsConfig(validConfig());
  assert.equal(config.tests[0].matchMode, undefined);
});

test("validateEvalsConfig accepts explicit matchMode", () => {
  const raw = validConfig();
  (raw.tests[0] as any).matchMode = "exact";
  const config = validateEvalsConfig(raw);
  assert.equal(config.tests[0].matchMode, "exact");
});

test("validateEvalsConfig rejects non-object input", () => {
  assert.throws(
    () => validateEvalsConfig("string"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("must be a JSON object"),
  );
});

test("validateEvalsConfig rejects empty servers", () => {
  const raw = validConfig();
  raw.servers = {} as any;
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes('non-empty "servers"'),
  );
});

test("validateEvalsConfig rejects missing agent.model", () => {
  const raw = validConfig();
  (raw.agent as any).model = "";
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("agent.model"),
  );
});

test("validateEvalsConfig rejects missing agent.apiKey", () => {
  const raw = validConfig();
  (raw.agent as any).apiKey = "";
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("agent.apiKey"),
  );
});

test("validateEvalsConfig rejects empty tests array", () => {
  const raw = validConfig();
  raw.tests = [];
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes('non-empty "tests"'),
  );
});

test("validateEvalsConfig rejects test missing prompt", () => {
  const raw = validConfig();
  (raw.tests[0] as any).prompt = "";
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("tests[0].prompt"),
  );
});

test("validateEvalsConfig rejects test missing expectedToolCalls", () => {
  const raw = validConfig();
  (raw.tests[0] as any).expectedToolCalls = [];
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("tests[0].expectedToolCalls"),
  );
});

test("validateEvalsConfig rejects invalid matchMode", () => {
  const raw = validConfig();
  (raw.tests[0] as any).matchMode = "fuzzy";
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("matchMode"),
  );
});

test("validateEvalsConfig rejects invalid model string", () => {
  const raw = validConfig();
  raw.agent.model = "no-slash";
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Invalid agent.model"),
  );
});

test("interpolateEnvVars resolves env variables", () => {
  process.env.__EVALS_TEST_VAR = "resolved-value";
  try {
    const result = interpolateEnvVars({ key: "${__EVALS_TEST_VAR}" });
    assert.deepEqual(result, { key: "resolved-value" });
  } finally {
    delete process.env.__EVALS_TEST_VAR;
  }
});

test("interpolateEnvVars throws on missing env variable", () => {
  delete process.env.__EVALS_MISSING_VAR;
  assert.throws(
    () => interpolateEnvVars({ key: "${__EVALS_MISSING_VAR}" }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("__EVALS_MISSING_VAR"),
  );
});

test("interpolateEnvVars handles nested objects and arrays", () => {
  process.env.__EVALS_NESTED = "hello";
  try {
    const result = interpolateEnvVars({
      a: { b: "${__EVALS_NESTED}" },
      c: ["${__EVALS_NESTED}", "literal"],
    });
    assert.deepEqual(result, {
      a: { b: "hello" },
      c: ["hello", "literal"],
    });
  } finally {
    delete process.env.__EVALS_NESTED;
  }
});

test("interpolateEnvVars passes through non-string primitives", () => {
  const result = interpolateEnvVars({ n: 42, b: true, x: null });
  assert.deepEqual(result, { n: 42, b: true, x: null });
});

test("validateEvalsConfig rejects temperature out of range", () => {
  const raw = validConfig();
  (raw.agent as any).temperature = 3;
  assert.throws(
    () => validateEvalsConfig(raw),
    (error) =>
      error instanceof CliError &&
      error.message.includes("temperature"),
  );
});

test("validateEvalsConfig accepts optional agent fields", () => {
  const raw = validConfig();
  raw.agent = {
    ...raw.agent,
    systemPrompt: "Test prompt",
    maxSteps: 5,
    temperature: 0.5,
  } as any;
  const config = validateEvalsConfig(raw);
  assert.equal(config.agent.systemPrompt, "Test prompt");
  assert.equal(config.agent.maxSteps, 5);
  assert.equal(config.agent.temperature, 0.5);
});
