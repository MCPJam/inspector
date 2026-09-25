/**
 * `mcpjam eval run --wait` prints what each iteration actually ran on — the
 * same line the inspector shows — and a deviation line whenever the record
 * says the run differed from the request. An iteration recorded before
 * execution records existed says "not recorded", never a guess.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatIterationProvenance,
  formatRecordedExecutionDisclosure,
  writeIterationProvenance,
} from "../src/lib/eval-provenance.js";

const execution = {
  requested: {
    modelId: "anthropic/claude-sonnet-4.5",
    source: "hosted",
    fallback: { provider: "openrouter", model: "none" },
  },
  resolved: {
    rail: "openrouter",
    wireModelId: "anthropic/claude-sonnet-4.5",
    offering: { rail: "openrouter", providerKey: "openrouter" },
  },
  harness: { id: "claude-code", runtimeVersion: "2.1.3" },
  effectiveSettings: { temperature: 0.2, maxOutputTokens: 0 },
  attempts: [
    {
      rail: "gateway",
      wireModelId: "anthropic/claude-sonnet-4.5",
      outcome: "error",
      code: "provider_error",
      at: 1,
    },
    {
      rail: "openrouter",
      wireModelId: "anthropic/claude-sonnet-4.5",
      outcome: "ok",
      at: 2,
    },
  ],
  deviation: {
    kind: "provider_fallback",
    reason:
      "The gateway attempt failed (provider_error); the openrouter fallback served the request.",
  },
} as const;

test("prints one provenance line per iteration, with the deviation", () => {
  const lines = formatIterationProvenance([
    {
      runId: "run-1",
      iterations: [
        {
          id: "it-2",
          title: "search works",
          iterationNumber: 2,
          execution: execution as never,
        },
        { id: "it-1", title: "search works", iterationNumber: 1 },
      ],
    },
  ]);
  assert.deepEqual(lines, [
    "Iteration provenance (run run-1):",
    "  search works #1: not recorded",
    "  search works #2: Ran on anthropic/claude-sonnet-4.5 via OpenRouter (MCPJam key), claude-code v2.1.3, temperature 0.2, max output provider default",
    "    Deviation: Provider fallback — The gateway attempt failed (provider_error); the openrouter fallback served the request.",
  ]);
  assert.ok(!lines.join("\n").match(/\b0 tokens\b/));
});

test("reports an unreadable run instead of printing nothing", () => {
  assert.deepEqual(
    formatIterationProvenance([
      { runId: "run-9", iterations: [], error: "HTTP 503" },
    ]),
    ["Iteration provenance (run run-9): unavailable — HTTP 503"]
  );
});

test("writes nothing outside human mode, so JSON stays one document", () => {
  const written: string[] = [];
  const stream = {
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const runs = [
    {
      runId: "run-1",
      iterations: [
        {
          id: "it-1",
          title: "t",
          iterationNumber: 1,
          execution: execution as never,
        },
      ],
    },
  ];
  writeIterationProvenance("json", runs, stream);
  assert.deepEqual(written, []);
  writeIterationProvenance("human", runs, stream);
  assert.equal(written.length, 1);
  assert.match(written[0]!, /t #1: Ran on anthropic\/claude-sonnet-4\.5/);
});

test("the disclosure's recorded facts print only when read off records", () => {
  assert.equal(
    formatRecordedExecutionDisclosure({
      provenance: "inferred-from-current-config",
    }),
    null
  );
  assert.equal(formatRecordedExecutionDisclosure({}), null);
  assert.equal(
    formatRecordedExecutionDisclosure({
      provenance: "execution-record",
      recorded: {
        records: 1,
        resolvedRails: ["orgCloud"],
        attemptedRails: ["orgCloud"],
        providerKeys: ["azure"],
        deviations: [],
      },
    }),
    "Recorded (1 record): ran via organization connection"
  );
});
