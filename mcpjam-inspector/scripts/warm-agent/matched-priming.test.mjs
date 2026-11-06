import { test } from "node:test";
import assert from "node:assert/strict";
import { primeMatched } from "./matched-priming.mjs";

const host = {
  hostId: "host",
  modelId: "model",
  nativeModel: "native",
  serverIds: [],
  cliServers: {},
};
const configuration = { model: "native", serverNames: [] };

test("all paths get identical priming, with final warm-ups in measured order", async () => {
  const calls = [];
  const make = (path) => async (prompt) => {
    calls.push([path, prompt]);
    return { output: "READY", failed: false, configuration };
  };
  const cliSend = make("cli");
  const result = await primeMatched({
    paths: ["on", "cli", "off"],
    host,
    prime: "READY?",
    ready: "READY",
    prompt: "MEASURED?",
    serialize: (fn) => fn(),
    arms: { on: { send: make("on") }, off: { send: make("off") } },
    cli: { turn: async ({ prompt }) => ({ result: await cliSend(prompt) }) },
  });
  assert.deepEqual(calls, [
    ["cli", "READY?"],
    ["on", "READY?"],
    ["cli", "READY?"],
    ["off", "READY?"],
  ]);
  assert.deepEqual(result.history, [
    ["user", "READY?"],
    ["assistant", "READY"],
    ["user", "READY?"],
    ["assistant", "READY"],
    ["user", "MEASURED?"],
  ]);
});

test("a failed initial CLI primer stops before any measured warm-up", async () => {
  await assert.rejects(
    primeMatched({
      paths: ["on"],
      host,
      prime: "READY?",
      ready: "READY",
      prompt: "MEASURED?",
      serialize: (fn) => fn(),
      arms: {
        on: {
          send: () => {
            throw Error("must not dispatch");
          },
        },
      },
      cli: {
        turn: async () => ({ result: { failed: true, output: "READY" } }),
      },
    }),
    /priming response differs/,
  );
});
