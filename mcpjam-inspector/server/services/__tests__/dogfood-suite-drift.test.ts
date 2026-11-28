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
    // And every read it has: a read shipped later would otherwise fail the
    // case in a nightly while this test stayed green.
    const allowed = asserts.flatMap((a) =>
      a.type === "onlyToolsCalled" ? a.toolNames : [],
    );
    expect(
      platformOperations()
        .filter((op) => op.readOnly === true)
        .map((op) => op.name)
        .filter((name) => !allowed.includes(name)),
    ).toEqual([]);
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

  it("make the identity case require the address itself", () => {
    const asserts = caseAsserts(IDENTITY);
    const toolCalls = ["get_me"];

    expect(
      passes(asserts, {
        toolCalls,
        answer: "You are signed in as ada@example.com.",
      }),
    ).toBe(true);
    expect(
      passes(asserts, { toolCalls, answer: "You are signed in to MCPJam." }),
    ).toBe(false);
  });

  it("make the count case require one number", () => {
    // Only the answer check: a synthetic transcript carries no turn count or
    // token usage, so the case's budget checks cannot pass here.
    const asserts = caseAsserts(COUNT).filter(
      (a) => a.type === "responseMatches",
    );
    expect(asserts).toHaveLength(1);
    const toolCalls = ["list_projects"];

    for (const answer of ["3", "You have 3 projects."]) {
      expect(passes(asserts, { toolCalls, answer }), answer).toBe(true);
    }
    for (const answer of ["You have several projects.", "3 of 12 projects"]) {
      expect(passes(asserts, { toolCalls, answer }), answer).toBe(false);
    }
  });

  it("make the missing-project case require saying so, and no create", () => {
    const asserts = caseAsserts(MISSING);
    const lookup = {
      toolName: "list_eval_suites",
      arguments: { project: "No Such Project 7f3a" },
    };
    const notFound: Result = {
      toolName: "list_eval_suites",
      text: "NOT_FOUND: no project matches 'No Such Project 7f3a'",
      isError: true,
    };
    const looked = { toolCalls: [lookup], toolResults: [notFound] };

    for (const answer of [
      "I couldn't find a project named 'No Such Project 7f3a'.",
      "That project does not exist. Your projects are A and B.",
      "I don't see a project called that. Which one did you mean?",
      "The project 'No Such Project 7f3a' could not be found.",
      "No Such Project 7f3a wasn't found among your projects.",
      "For project 'No Such Project 7f3a', I couldn't find it.",
    ]) {
      expect(passes(asserts, { ...looked, answer }), answer).toBe(true);
    }
    for (const answer of [
      "The suites are Smoke and Nightly.",
      "I don't see any problems. The suites are Smoke and Nightly.",
    ]) {
      expect(passes(asserts, { ...looked, answer }), answer).toBe(false);
    }

    // An answer the pattern accepts, so only the run around it can fail.
    const answer = "That project does not exist.";
    expect(passes(asserts, { ...looked, answer })).toBe(true);
    // No lookup at all.
    expect(passes(asserts, { answer })).toBe(false);
    // Lookups that never name the missing project.
    expect(passes(asserts, { toolCalls: ["list_projects"], answer })).toBe(
      false,
    );
    expect(
      passes(asserts, {
        toolCalls: [
          { toolName: "list_eval_suites", arguments: { project: "Other" } },
        ],
        toolResults: [{ ...notFound, text: "NOT_FOUND: no project 'Other'" }],
        answer,
      }),
    ).toBe(false);
    // Creating the project it could not find.
    expect(
      passes(asserts, {
        toolCalls: [lookup, "create_project"],
        toolResults: [notFound],
        answer,
      }),
    ).toBe(false);
    // Falling back to another project's suites.
    expect(
      passes(asserts, {
        toolCalls: [lookup, { toolName: "list_eval_suites", arguments: {} }],
        toolResults: [
          notFound,
          {
            toolName: "list_eval_suites",
            text: '{"project":{"name":"MCPJam MCP dogfood"},"items":[{"name":"Smoke"},{"name":"Nightly"}]}',
          },
        ],
        answer:
          "Project not found: No Such Project 7f3a. Here are the suites in MCPJam MCP dogfood: Smoke, Nightly.",
      }),
    ).toBe(false);
  });

  it("name only tools the MCPJam MCP server has", () => {
    const names = new Set(platformOperations().map((op) => op.name));
    const used = allToolNames();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !names.has(name))).toEqual([]);
  });
});

const GLOSSARY =
  "names the six user-value stages in order from its own glossary";
const ASKS = "asks rather than guessing when the request names nothing";
const IDENTITY = "answers who the caller is from the platform, not from memory";
const COUNT = "counts projects in one hop and stays inside a token budget";
const MISSING = "says a named project does not exist instead of guessing";

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

type Call = string | { toolName: string; arguments: Record<string, unknown> };
type Result = { toolName: string; text: string; isError?: boolean };

// A trial passes when every gating check passes; advisory checks only report.
function passes(
  asserts: Predicate[],
  run: { toolCalls?: Call[]; toolResults?: Result[]; answer: string },
): boolean {
  const transcript = buildIterationTranscript({
    toolCalls: (run.toolCalls ?? []).map((call) =>
      typeof call === "string" ? { toolName: call, arguments: {} } : call,
    ),
    ...(run.toolResults
      ? {
          resultsCaptured: true,
          toolResults: run.toolResults.map((result) => ({
            ...result,
            size: {
              bytes: result.text.length,
              basis: "model_visible_output" as const,
              complete: true,
            },
          })),
        }
      : {}),
    finalAssistantMessage: run.answer,
  });
  const gating = asserts.filter((a) => a.role !== "advisory");
  return evaluatePredicates(transcript, gating).every((r) => r.passed);
}

function allToolNames(): string[] {
  const loaded = loadEvalSuiteFile(read(STAGING));
  if (!loaded.ok) throw new Error(`${STAGING} does not load`);
  return loaded.resolved.cases.flatMap((c) =>
    c.steps.flatMap((step) =>
      step.kind === "assert" && "toolName" in step.assertion
        ? [step.assertion.toolName].filter(
            (name): name is string => typeof name === "string",
          )
        : [],
    ),
  );
}

function platformOperations(): Array<{ name: string; readOnly?: boolean }> {
  const exports: unknown[] = Object.values(platform);
  return exports.filter(
    (value): value is { name: string; readOnly?: boolean } =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { execute?: unknown }).execute === "function",
  );
}
