import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalSuiteFile } from "@mcpjam/sdk";
import { isWidgetAssertion } from "@mcpjam/sdk/contract";
import * as platform from "@mcpjam/sdk/platform";
import {
  buildIterationTranscript,
  evaluatePredicates,
  type Predicate,
} from "@mcpjam/sdk/predicates";

/**
 * The dogfood suite exists twice, once per environment, and the two copies must
 * ask the same questions.
 *
 * Why two files at all: a file-owned suite always carries an environment, and
 * `eval run --server` against one is refused with
 * `ENVIRONMENT_SERVERS_NOT_OVERRIDABLE`, so a single file cannot be pointed at
 * staging for the promotion gate and at production for the nightly monitor.
 * That refusal is correct rather than inconvenient: a suite's run history is
 * only comparable within one target, so one suite spanning two servers would
 * quietly corrupt every baseline comparison.
 *
 * What that leaves is the ordinary duplication hazard — someone fixes a case in
 * one file and the other silently measures something else. This test is the
 * thing that stops it. Everything ABOVE `cases:` is deliberately allowed to
 * differ (identity, target, prose); everything from `cases:` down must match
 * byte for byte.
 */
const EVALS_DIR = join(__dirname, "..", "..", "..", "..", ".mcpjam", "evals");
const STAGING = "mcpjam-mcp.yaml";
const PRODUCTION = "mcpjam-mcp-production.yaml";

function read(name: string): string {
  return readFileSync(join(EVALS_DIR, name), "utf8");
}

function casesBlock(source: string, name: string): string {
  const marker = "\ncases:\n";
  const at = source.indexOf(marker);
  // A rename of `cases:` would otherwise make this test vacuously pass by
  // comparing two empty strings.
  expect(at, `${name} must contain a top-level 'cases:' block`).toBeGreaterThan(
    -1,
  );
  return source.slice(at + marker.length);
}

describe("the dogfood eval suites", () => {
  it("ask identical questions of staging and production", () => {
    expect(casesBlock(read(PRODUCTION), PRODUCTION)).toBe(
      casesBlock(read(STAGING), STAGING),
    );
  });

  it("carry distinct identities, so neither can claim the other's suite", () => {
    const ids = [STAGING, PRODUCTION].map((name) => {
      const match = /^ {2}id: (\S+)$/m.exec(read(name));
      expect(match, `${name} must declare suite.id`).not.toBeNull();
      return match![1];
    });
    expect(ids[0]).not.toBe(ids[1]);

    const names = [STAGING, PRODUCTION].map((file) => {
      const match = /^ {2}name: (.+)$/m.exec(read(file));
      expect(match, `${file} must declare suite.name`).not.toBeNull();
      return match![1].trim();
    });
    // The SDK upload path joins on suite NAME, so two suites sharing one name
    // in a project would send local runs into whichever row is older.
    expect(names[0]).not.toBe(names[1]);
  });

  it("each target exactly one server, and not the same one", () => {
    const targets = [STAGING, PRODUCTION].map((file) => {
      const source = read(file);
      const block = source.slice(
        source.indexOf("\ntarget:\n"),
        source.indexOf("\ndefaults:\n"),
      );
      const servers = [...block.matchAll(/^ {4}- name: (\S+)$/gm)].map(
        (m) => m[1],
      );
      expect(servers, `${file} must target exactly one server`).toHaveLength(1);
      return servers[0];
    });
    expect(targets).toEqual(["mcpjam-mcp-staging", "mcpjam-mcp"]);
  });

  it("make the glossary case name the userValue stage, not echo the question", () => {
    const asserts = caseAsserts(GLOSSARY);
    const stages = "connection, discovery, selection, call, response";

    expect(passes(asserts, { answer: `${stages} and userValue` })).toBe(true);
    expect(passes(asserts, { answer: `${stages}, User value` })).toBe(true);
    // The prompt says "user-value chain"; restating it names no stage.
    expect(
      passes(asserts, {
        answer: `The six stages of the MCPJam user-value chain are ${stages}.`,
      }),
    ).toBe(false);
  });

  it("let 'asks rather than guessing' read the account but call no write", () => {
    const asserts = caseAsserts(ASKS);
    const answer = "Which project are you having trouble with?";
    const reads = ["get_me", "list_projects", "show_servers"];

    expect(passes(asserts, { toolCalls: reads, answer })).toBe(true);
    expect(
      passes(asserts, {
        toolCalls: ["search_mcp_tools", "load_mcp_tools", "list_projects"],
        answer,
      }),
    ).toBe(true);
    // Every write the platform has, including any shipped after this test.
    const writes = platformOperations().filter((op) => op.readOnly !== true);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(
        passes(asserts, { toolCalls: [...reads, write.name], answer }),
        write.name,
      ).toBe(false);
    }
  });

  it("make 'asks rather than guessing' require a question put to the user", () => {
    const asserts = caseAsserts(ASKS);

    for (const answer of [
      "Which project should I look at?",
      "Could you tell me:\n1. Which project?\n2. What you see?",
      "What error do you get, e.g. on mcp.example.com?",
    ]) {
      expect(passes(asserts, { answer }), answer).toBe(true);
    }
    for (const answer of [
      "The cause is probably an expired token? Restart it.",
      "Your project looks healthy.",
    ]) {
      expect(passes(asserts, { answer }), answer).toBe(false);
    }
  });
});

const GLOSSARY =
  "names the six user-value stages in order from its own glossary";
const ASKS = "asks rather than guessing when the request names nothing";

// The case's own assertions, loaded from the suite file and scored by the
// evaluator itself, so its pattern gates (an invalid or nested-quantifier
// regex fails closed) apply here exactly as in a nightly.
function caseAsserts(title: string): Predicate[] {
  const loaded = loadEvalSuiteFile(read(STAGING));
  if (!loaded.ok) throw new Error(`${STAGING} does not load`);
  const found = loaded.resolved.cases.find((c) => c.title === title);
  if (!found) throw new Error(`no case titled "${title}"`);
  return found.steps.flatMap((step) =>
    step.kind === "assert" && !isWidgetAssertion(step.assertion)
      ? [step.assertion]
      : [],
  );
}

function passes(
  asserts: Predicate[],
  run: { toolCalls?: string[]; answer: string },
): boolean {
  const transcript = buildIterationTranscript({
    toolCalls: (run.toolCalls ?? []).map((toolName) => ({
      toolName,
      arguments: {},
    })),
    finalAssistantMessage: run.answer,
  });
  return evaluatePredicates(transcript, asserts).every((r) => r.passed);
}

function platformOperations(): Array<{ name: string; readOnly?: boolean }> {
  return Object.values(platform).filter(
    (value): value is { name: string; readOnly?: boolean } & object =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { execute?: unknown }).execute === "function",
  );
}
